"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    isGoogleMapsConfigured,
    loadGoogleMapsLibraries,
    type MapsLoaderStatus,
    readGoogleMapsApiKey,
} from "./google-maps-loader";
import { classifyResidenceCell, type ResidenceCellClass } from "./h3-cell-classifier";
import {
    h3DecimalToHex,
    latLngToResidenceCell,
    normalizeResidenceCellInput,
    residenceCellCenter,
    residenceCellsInViewport,
    type ViewportBounds,
} from "./h3-geo";
import {
    buildOverlayCells,
    buildResidenceSummary,
    type OverlayCell,
    type OverlayCellKind,
    selectResidenceCell,
} from "./residence-overlay";

// NEXT_PUBLIC_* はビルド時にインライン化される（output: "export"）。
const mapsApiKey = readGoogleMapsApiKey();
const residenceWorkerUrl = process.env.NEXT_PUBLIC_SONARI_RESIDENCE_PROOF_WORKER_URL ?? "";

// 東京駅付近を初期中心にする。
const DEFAULT_CENTER: google.maps.LatLngLiteral = { lat: 35.681236, lng: 139.767125 };
// ズームは 12〜14 の 3 段に固定し、表示セル数が膨らみすぎないようにする。
const MIN_ZOOM = 12;
const MAX_ZOOM = 14;
const DEFAULT_ZOOM = 13;
// viewport 内セルの分類で同時に投げる worker 呼び出しの上限。
const CLASSIFY_CONCURRENCY = 6;
// 念のための上限。ズーム固定でも極端な viewport で描画/分類が膨らむのを防ぐ。
const MAX_VIEWPORT_CELLS = 200;
// pan/zoom 後の overlay 再構築をまとめるための debounce(ms)。
const REBUILD_DEBOUNCE_MS = 150;

const WATER_MESSAGE = "海上などのセルは居住地として選択できません。";

/** classification を overlay 上の種別へ変換する（選択中セルの判定は呼び出し側が優先する）。 */
function classToKind(cls: ResidenceCellClass): OverlayCellKind {
    return cls === "water" ? "disabled" : "selectable";
}

const polygonStyleByKind: Record<OverlayCellKind, google.maps.PolygonOptions> = {
    selectable: {
        strokeColor: "#4f7d5a",
        strokeOpacity: 0.85,
        strokeWeight: 1,
        fillColor: "#7fae87",
        fillOpacity: 0.18,
        clickable: true,
        zIndex: 1,
    },
    disabled: {
        strokeColor: "#9aa0a6",
        strokeOpacity: 0.5,
        strokeWeight: 1,
        fillColor: "#9aa0a6",
        fillOpacity: 0.4,
        // 海セルもクリックは受け付け、理由メッセージを出すために clickable にする。
        clickable: true,
        zIndex: 1,
    },
    selected: {
        strokeColor: "#2f5d3a",
        strokeOpacity: 1,
        strokeWeight: 2.5,
        fillColor: "#5b9268",
        fillOpacity: 0.45,
        clickable: true,
        zIndex: 10,
    },
    pending: {
        strokeColor: "#c7ccd1",
        strokeOpacity: 0.4,
        strokeWeight: 1,
        fillColor: "#c7ccd1",
        fillOpacity: 0.08,
        clickable: true,
        zIndex: 1,
    },
};

export function ResidenceCellPicker() {
    // 初回描画はサーバー・クライアントで必ず一致させるため env に依存させない。
    // 実際の状態（unconfigured/ready/error）はマウント後の useEffect で決める。
    const [status, setStatus] = useState<MapsLoaderStatus>("loading");
    const [selectedDecimal, setSelectedDecimal] = useState<string | null>(null);
    const [selectedClass, setSelectedClass] = useState<ResidenceCellClass | undefined>(undefined);
    const [advancedInput, setAdvancedInput] = useState<string>("");
    const [notice, setNotice] = useState<string | null>(null);

    const mapElRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const mapRef = useRef<google.maps.Map | null>(null);
    const polygonsRef = useRef<Map<string, google.maps.Polygon>>(new Map());
    const classCacheRef = useRef<Map<string, ResidenceCellClass>>(new Map());
    const selectedDecimalRef = useRef<string | null>(null);
    const classifyQueueRef = useRef<string[]>([]);
    const inflightRef = useRef<Set<string>>(new Set());
    const activeCountRef = useRef<number>(0);
    const rebuildTimerRef = useRef<number | null>(null);

    // 選択 decimal を click ハンドラから参照するため ref に同期する。
    useEffect(() => {
        selectedDecimalRef.current = selectedDecimal;
    }, [selectedDecimal]);

    // 選択が変わったら advanced 入力欄に16進表記を反映する。
    useEffect(() => {
        setAdvancedInput(selectedDecimal === null ? "" : h3DecimalToHex(selectedDecimal));
    }, [selectedDecimal]);

    // 分類結果を取り込み、選択中でなければ該当ポリゴンの見た目を更新する。
    const applyClassification = useCallback((decimal: string, cls: ResidenceCellClass) => {
        classCacheRef.current.set(decimal, cls);
        if (selectedDecimalRef.current === decimal) {
            return;
        }
        const poly = polygonsRef.current.get(decimal);
        if (poly !== undefined) {
            poly.setOptions(polygonStyleByKind[classToKind(cls)]);
        }
    }, []);

    // 並行数を制限しながら分類キューを消化する。
    const pumpClassifyQueue = useCallback(() => {
        while (
            activeCountRef.current < CLASSIFY_CONCURRENCY &&
            classifyQueueRef.current.length > 0
        ) {
            const decimal = classifyQueueRef.current.shift();
            if (decimal === undefined) {
                break;
            }
            if (classCacheRef.current.has(decimal) || inflightRef.current.has(decimal)) {
                continue;
            }
            inflightRef.current.add(decimal);
            activeCountRef.current += 1;
            classifyResidenceCell({ cellDecimal: decimal, workerUrl: residenceWorkerUrl })
                .then((result) => {
                    applyClassification(decimal, result.classification);
                })
                .catch(() => {
                    applyClassification(decimal, "unknown");
                })
                .finally(() => {
                    inflightRef.current.delete(decimal);
                    activeCountRef.current -= 1;
                    pumpClassifyQueue();
                });
        }
    }, [applyClassification]);

    // クリックされたセルを分類のうえ選択する。海セルは選択せず理由を出す。
    const applySelection = useCallback(async (decimal: string) => {
        let cls = classCacheRef.current.get(decimal);
        if (cls === undefined) {
            try {
                const result = await classifyResidenceCell({
                    cellDecimal: decimal,
                    workerUrl: residenceWorkerUrl,
                });
                cls = result.classification;
            } catch {
                cls = "unknown";
            }
            classCacheRef.current.set(decimal, cls);
        }

        const previous = selectedDecimalRef.current;
        const outcome = selectResidenceCell({ selectedDecimal: previous }, decimal, cls);
        if (outcome.rejected) {
            setNotice(outcome.message ?? WATER_MESSAGE);
            return;
        }

        setNotice(null);
        setSelectedDecimal(decimal);
        setSelectedClass(cls);

        // 直前の選択セルを通常の見た目へ戻す。
        if (previous !== null && previous !== decimal) {
            const previousPoly = polygonsRef.current.get(previous);
            if (previousPoly !== undefined) {
                const previousClass = classCacheRef.current.get(previous);
                previousPoly.setOptions(
                    polygonStyleByKind[
                        previousClass === undefined ? "pending" : classToKind(previousClass)
                    ],
                );
            }
        }

        // 選択セルを強調し、その中心へ地図を寄せる。
        const selectedPoly = polygonsRef.current.get(decimal);
        if (selectedPoly !== undefined) {
            selectedPoly.setOptions(polygonStyleByKind.selected);
        }
        const map = mapRef.current;
        if (map !== null) {
            map.panTo(residenceCellCenter(h3DecimalToHex(decimal)));
        }
    }, []);

    // viewport 内のセルからポリゴンを差分更新する。
    const syncPolygons = useCallback(
        (overlay: OverlayCell[], map: google.maps.Map) => {
            const nextDecimals = new Set(overlay.map((cell) => cell.decimal));

            // viewport から外れたポリゴンを除去する。
            for (const [decimal, poly] of polygonsRef.current) {
                if (!nextDecimals.has(decimal)) {
                    google.maps.event.clearInstanceListeners(poly);
                    poly.setMap(null);
                    polygonsRef.current.delete(decimal);
                }
            }

            for (const cell of overlay) {
                const style = polygonStyleByKind[cell.kind];
                const existing = polygonsRef.current.get(cell.decimal);
                if (existing === undefined) {
                    const poly = new google.maps.Polygon({ paths: cell.boundary, ...style });
                    poly.setMap(map);
                    poly.addListener("click", () => {
                        void applySelection(cell.decimal);
                    });
                    polygonsRef.current.set(cell.decimal, poly);
                } else {
                    existing.setOptions(style);
                }
            }
        },
        [applySelection],
    );

    // 現在の地図範囲から overlay を組み立て直し、未分類セルを分類キューへ積む。
    const rebuildOverlay = useCallback(() => {
        const map = mapRef.current;
        if (map === null) {
            return;
        }
        const bounds = map.getBounds();
        if (bounds === undefined) {
            return;
        }
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        const viewport: ViewportBounds = {
            north: ne.lat(),
            south: sw.lat(),
            east: ne.lng(),
            west: sw.lng(),
        };

        let cellsHex = residenceCellsInViewport(viewport);
        if (cellsHex.length > MAX_VIEWPORT_CELLS) {
            cellsHex = cellsHex.slice(0, MAX_VIEWPORT_CELLS);
        }

        // 切り捨ての影響で選択中セルのハイライトが消えないよう、必ず含める。
        const selected = selectedDecimalRef.current;
        if (selected !== null) {
            const selectedHex = h3DecimalToHex(selected);
            if (!cellsHex.includes(selectedHex)) {
                cellsHex = [...cellsHex, selectedHex];
            }
        }

        const overlay = buildOverlayCells({
            viewportCellsHex: cellsHex,
            classifications: classCacheRef.current,
            selectedDecimal: selectedDecimalRef.current,
        });
        syncPolygons(overlay, map);

        for (const cell of overlay) {
            if (cell.kind === "pending") {
                classifyQueueRef.current.push(cell.decimal);
            }
        }
        pumpClassifyQueue();
    }, [pumpClassifyQueue, syncPolygons]);

    // pan/zoom 連発をまとめて再構築する。
    const scheduleRebuild = useCallback(() => {
        if (rebuildTimerRef.current !== null) {
            window.clearTimeout(rebuildTimerRef.current);
        }
        rebuildTimerRef.current = window.setTimeout(() => {
            rebuildOverlay();
        }, REBUILD_DEBOUNCE_MS);
    }, [rebuildOverlay]);

    // 地図の初期化（マウント時に一度だけ）。
    useEffect(() => {
        if (!isGoogleMapsConfigured(mapsApiKey)) {
            setStatus("unconfigured");
            return;
        }

        let cancelled = false;
        setStatus("loading");

        loadGoogleMapsLibraries(mapsApiKey)
            .then(() => {
                if (cancelled) {
                    return;
                }
                const element = mapElRef.current;
                if (element === null) {
                    return;
                }

                const map = new google.maps.Map(element, {
                    center: DEFAULT_CENTER,
                    zoom: DEFAULT_ZOOM,
                    minZoom: MIN_ZOOM,
                    maxZoom: MAX_ZOOM,
                    clickableIcons: false,
                    streetViewControl: false,
                    mapTypeControl: false,
                    fullscreenControl: false,
                });
                mapRef.current = map;

                map.addListener("click", (event: google.maps.MapMouseEvent) => {
                    const latLng = event.latLng;
                    if (latLng === null || latLng === undefined) {
                        return;
                    }
                    const cell = latLngToResidenceCell(latLng.lat(), latLng.lng());
                    void applySelection(cell.decimal);
                });

                map.addListener("idle", () => {
                    scheduleRebuild();
                });

                const input = searchInputRef.current;
                if (input !== null) {
                    const autocomplete = new google.maps.places.Autocomplete(input, {
                        fields: ["geometry"],
                    });
                    autocomplete.addListener("place_changed", () => {
                        const place = autocomplete.getPlace();
                        const location = place.geometry?.location;
                        if (location === undefined) {
                            return;
                        }
                        map.panTo(location);
                        map.setZoom(MAX_ZOOM);
                        const cell = latLngToResidenceCell(location.lat(), location.lng());
                        void applySelection(cell.decimal);
                    });
                }

                setStatus("ready");
                scheduleRebuild();
            })
            .catch(() => {
                if (!cancelled) {
                    setStatus("error");
                }
            });

        return () => {
            cancelled = true;
            if (rebuildTimerRef.current !== null) {
                window.clearTimeout(rebuildTimerRef.current);
            }
            for (const poly of polygonsRef.current.values()) {
                google.maps.event.clearInstanceListeners(poly);
                poly.setMap(null);
            }
            polygonsRef.current.clear();
            const map = mapRef.current;
            if (map !== null) {
                google.maps.event.clearInstanceListeners(map);
            }
        };
    }, [applySelection, scheduleRebuild]);

    // 現在地ボタン。座標は一時利用のみで保存しない。
    const handleUseCurrentLocation = useCallback(() => {
        if (typeof navigator === "undefined" || navigator.geolocation === undefined) {
            setNotice("この端末では現在地を取得できません。");
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const { latitude, longitude } = position.coords;
                const map = mapRef.current;
                if (map !== null) {
                    map.panTo({ lat: latitude, lng: longitude });
                    map.setZoom(MAX_ZOOM);
                }
                const cell = latLngToResidenceCell(latitude, longitude);
                void applySelection(cell.decimal);
            },
            () => {
                setNotice("現在地の取得が許可されませんでした。");
            },
        );
    }, [applySelection]);

    // advanced 入力欄の確定。16進セルIDを正規化して選択へ反映する。
    const handleAdvancedCommit = useCallback(
        (raw: string) => {
            if (raw.trim().length === 0) {
                return;
            }
            let decimal: string;
            try {
                decimal = normalizeResidenceCellInput(raw).decimal;
            } catch {
                setNotice("H3 セルIDが正しくありません（resolution 7 の16進セルID）。");
                return;
            }
            void applySelection(decimal);
        },
        [applySelection],
    );

    const summary = buildResidenceSummary({ selectedDecimal, classification: selectedClass });
    const isReady = status === "ready";
    const workerUnavailable = residenceWorkerUrl.trim().length === 0;

    return (
        <div className="residence-selector">
            <div className="residence-search-row">
                <label className="text-field" htmlFor="residence-search">
                    <span>Search city, station, or address</span>
                    <input
                        autoComplete="off"
                        disabled={!isReady}
                        id="residence-search"
                        placeholder="Shibuya, Tokyo"
                        ref={searchInputRef}
                        type="text"
                    />
                    <small>
                        Search text may be sent to a map provider. Sonari stores the selected H3
                        cell only.
                    </small>
                </label>
                <button
                    className="btn btn-secondary"
                    disabled={!isReady}
                    onClick={handleUseCurrentLocation}
                    type="button"
                >
                    Use current location
                </button>
            </div>

            {status === "unconfigured" ? (
                <div className="residence-map-fallback" role="status">
                    <strong>Map preview is unavailable.</strong>
                    <p>
                        Set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to enable the map. You can still enter
                        an H3 cell manually from Advanced cell input below.
                    </p>
                </div>
            ) : (
                <div className="residence-map-picker">
                    <div
                        aria-label="Residence cell map"
                        className="residence-map-canvas"
                        ref={mapElRef}
                        role="application"
                        style={{ minHeight: 320 }}
                    />
                    {status === "loading" ? (
                        <div className="residence-map-overlay-note" role="status">
                            Loading map…
                        </div>
                    ) : null}
                    {status === "error" ? (
                        <div className="residence-map-overlay-note" role="status">
                            The map failed to load. Try again later, or use Advanced cell input
                            below.
                        </div>
                    ) : null}
                </div>
            )}

            {workerUnavailable ? (
                <p className="residence-notice" role="status">
                    Land/sea check is unavailable, so all cells are selectable for now.
                </p>
            ) : null}
            {notice !== null ? (
                <p className="residence-notice" role="status">
                    {notice}
                </p>
            ) : null}

            <div className="selected-area-summary">
                <div>
                    <span>H3 resolution</span>
                    <strong>{summary.resolution}</strong>
                </div>
                <div>
                    <span>Cell ID</span>
                    <strong className="mono-value">{summary.cellHex ?? "—"}</strong>
                </div>
                <div>
                    <span>Allowlist</span>
                    <strong>{summary.allowlistStatus}</strong>
                </div>
            </div>

            <input name="homeCell" type="hidden" value={selectedDecimal ?? ""} />

            <details className="advanced-cell-input">
                <summary>Advanced cell input</summary>
                <label className="text-field" htmlFor="home-cell-advanced">
                    <span>H3 resolution 7 cell (hex)</span>
                    <input
                        id="home-cell-advanced"
                        onBlur={(event) => {
                            handleAdvancedCommit(event.target.value);
                        }}
                        onChange={(event) => {
                            setAdvancedInput(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                handleAdvancedCommit(event.currentTarget.value);
                            }
                        }}
                        placeholder="872f5aa8effffff"
                        type="text"
                        value={advancedInput}
                    />
                    <small>
                        Debug only. Enter a hex H3 cell to override the selection. The saved value
                        is the decimal cell ID.
                    </small>
                </label>
            </details>
        </div>
    );
}
