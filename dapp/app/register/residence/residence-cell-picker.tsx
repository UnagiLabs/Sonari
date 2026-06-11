"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    isGoogleMapsConfigured,
    loadGoogleMapsLibraries,
    type MapsLoaderStatus,
    readGoogleMapsApiKey,
} from "./google-maps-loader";
import { shouldShowAdvancedCellInput } from "./advanced-cell-input";
import { classifyResidenceCell, type ResidenceCellClass } from "./h3-cell-classifier";
import {
    h3DecimalToHex,
    latLngToResidenceCell,
    normalizeResidenceCellInput,
    residenceCellCenter,
    residenceCellsInViewport,
    type ViewportBounds,
} from "./h3-geo";
import { canRetryMapLoad, nextRetryNonce } from "./map-load-retry";
import { buildCellLegendEntries, polygonStyleForKind } from "./residence-cell-style";
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

/** classification を overlay 上の種別へ変換する（選択中セルの判定は呼び出し側が優先する）。 */
function classToKind(cls: ResidenceCellClass): OverlayCellKind {
    return cls === "water" ? "disabled" : "selectable";
}

export interface ResidenceCellPickerProps {
    /** 選択セル（10進）が変わるたびに呼ばれる。安定参照（useCallback）で渡すこと。 */
    readonly onSelectionChange?: (decimal: string | null) => void;
}

export function ResidenceCellPicker({ onSelectionChange }: ResidenceCellPickerProps = {}) {
    const t = useTranslations("register.wizard.residence.picker");
    // 地図初期化 effect の依存に t を入れると locale 切替のたびに地図が
    // 再初期化されてしまうため、コールバック内からは ref 経由で参照する。
    const tRef = useRef(t);
    useEffect(() => {
        tRef.current = t;
    });

    // 初回描画はサーバー・クライアントで必ず一致させるため env に依存させない。
    // 実際の状態（unconfigured/ready/error）はマウント後の useEffect で決める。
    const [status, setStatus] = useState<MapsLoaderStatus>("loading");
    const [retryNonce, setRetryNonce] = useState<number>(0);
    const [selectedDecimal, setSelectedDecimal] = useState<string | null>(null);
    const [selectedClass, setSelectedClass] = useState<ResidenceCellClass | undefined>(undefined);
    const [advancedInput, setAdvancedInput] = useState<string>("");
    const [notice, setNotice] = useState<string | null>(null);

    const mapElRef = useRef<HTMLDivElement | null>(null);
    const autocompleteHostRef = useRef<HTMLDivElement | null>(null);
    const autocompleteElRef = useRef<google.maps.places.PlaceAutocompleteElement | null>(null);
    const mapRef = useRef<google.maps.Map | null>(null);
    const polygonsRef = useRef<Map<string, google.maps.Polygon>>(new Map());
    const classCacheRef = useRef<Map<string, ResidenceCellClass>>(new Map());
    const selectedDecimalRef = useRef<string | null>(null);
    const classifyQueueRef = useRef<string[]>([]);
    const inflightRef = useRef<Set<string>>(new Set());
    const activeCountRef = useRef<number>(0);
    const rebuildTimerRef = useRef<number | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);

    // 選択 decimal を click ハンドラから参照するため ref に同期する。
    useEffect(() => {
        selectedDecimalRef.current = selectedDecimal;
    }, [selectedDecimal]);

    // 親（ウィザード）へ選択セルの変化を通知する。
    useEffect(() => {
        onSelectionChange?.(selectedDecimal);
    }, [selectedDecimal, onSelectionChange]);

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
            poly.setOptions(polygonStyleForKind(classToKind(cls)));
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
            // 拒否されるのは water セルのみ（selectResidenceCell の仕様）。
            setNotice(tRef.current("waterMessage"));
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
                    polygonStyleForKind(
                        previousClass === undefined ? "pending" : classToKind(previousClass),
                    ),
                );
            }
        }

        // 選択セルを強調し、その中心へ地図を寄せる。
        const selectedPoly = polygonsRef.current.get(decimal);
        if (selectedPoly !== undefined) {
            selectedPoly.setOptions(polygonStyleForKind("selected"));
        }
        const map = mapRef.current;
        if (map !== null) {
            map.panTo(residenceCellCenter(h3DecimalToHex(decimal)));
        }
    }, []);

    // 緯度経度へ地図を寄せ、対応セルを選択する共通処理。
    // 検索候補の選択と現在地ボタンが同じ pan/zoom + セル選択を行うため共通化する。
    const focusLatLng = useCallback(
        (lat: number, lng: number) => {
            const map = mapRef.current;
            if (map !== null) {
                map.panTo({ lat, lng });
                map.setZoom(MAX_ZOOM);
            }
            const cell = latLngToResidenceCell(lat, lng);
            void applySelection(cell.decimal);
        },
        [applySelection],
    );

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
                const style = polygonStyleForKind(cell.kind);
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
    // retryNonce は本文では参照しないが、再試行ボタンで地図初期化をやり直すための
    // 意図的なトリガー依存。error 状態でのみ nonce が増えるため ready 後は再実行されない。
    // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce は再初期化トリガーとして意図的に依存へ含める
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
                map.setOptions({ gestureHandling: "greedy" });

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

                const host = autocompleteHostRef.current;
                if (host !== null) {
                    // 後継 API の PlaceAutocompleteElement（Web Component）。
                    // 旧 Autocomplete は 2025-03-01 以降の新規顧客に提供されない非推奨 API。
                    // options 引数は必須（全プロパティ optional）。
                    const placeAutocomplete = new google.maps.places.PlaceAutocompleteElement({});
                    placeAutocomplete.placeholder = tRef.current("searchPlaceholder");
                    host.replaceChildren(placeAutocomplete);
                    autocompleteElRef.current = placeAutocomplete;
                    placeAutocomplete.addEventListener("gmp-select", async (event) => {
                        const place = event.placePrediction.toPlace();
                        try {
                            await place.fetchFields({ fields: ["location"] });
                        } catch {
                            return;
                        }
                        const location = place.location;
                        if (location === null || location === undefined) {
                            return;
                        }
                        focusLatLng(location.lat(), location.lng());
                    });
                }

                setStatus("ready");
                scheduleRebuild();

                // コンテナサイズ変更時に地図中心を保持する。
                // keep-mounted でフルブリード CSS が変わっても中心がずれないよう
                // ResizeObserver で canvas サイズを監視し、resize 後に中心を復元する。
                if (typeof ResizeObserver !== "undefined" && element !== null) {
                    const observer = new ResizeObserver(() => {
                        const currentMap = mapRef.current;
                        if (currentMap === null) {
                            return;
                        }
                        const savedCenter = currentMap.getCenter();
                        google.maps.event.trigger(currentMap, "resize");
                        if (savedCenter !== undefined && savedCenter !== null) {
                            currentMap.setCenter(savedCenter);
                        }
                    });
                    observer.observe(element);
                    resizeObserverRef.current = observer;
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setStatus("error");
                }
            });

        return () => {
            cancelled = true;
            if (resizeObserverRef.current !== null) {
                resizeObserverRef.current.disconnect();
                resizeObserverRef.current = null;
            }
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
            // 生成した Web Component を DOM から外す（リスナごと GC される）。
            if (autocompleteElRef.current !== null) {
                autocompleteElRef.current.remove();
                autocompleteElRef.current = null;
            }
            // 再試行時に古いインスタンスが残らないよう null に戻す。
            mapRef.current = null;
        };
    }, [applySelection, focusLatLng, scheduleRebuild, retryNonce]);

    // 現在地ボタン。座標は一時利用のみで保存しない。
    const handleUseCurrentLocation = useCallback(() => {
        if (typeof navigator === "undefined" || navigator.geolocation === undefined) {
            setNotice(tRef.current("geolocationUnavailable"));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const { latitude, longitude } = position.coords;
                focusLatLng(latitude, longitude);
            },
            () => {
                setNotice(tRef.current("geolocationDenied"));
            },
        );
    }, [focusLatLng]);

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
                setNotice(tRef.current("invalidCellInput"));
                return;
            }
            void applySelection(decimal);
        },
        [applySelection],
    );

    const summary = buildResidenceSummary({ selectedDecimal, classification: selectedClass });
    const isReady = status === "ready";
    const workerUnavailable = residenceWorkerUrl.trim().length === 0;
    const legendEntries = buildCellLegendEntries();

    return (
        <div className="residence-map-stage">
            {/* 地図 canvas: unconfigured 時は描画しないが DOM 構造は維持する */}
            {status === "unconfigured" ? (
                <div className="residence-map-fallback" role="status">
                    <strong>{t("unconfiguredTitle")}</strong>
                    <p>{t("unconfiguredBody")}</p>
                </div>
            ) : (
                <div
                    aria-label={t("mapAria")}
                    className="residence-map-canvas"
                    ref={mapElRef}
                    role="application"
                />
            )}

            {/* 地図上部オーバーレイ: 検索ボックス + 現在地ボタン */}
            <div className="residence-overlay-top">
                <div className="residence-search-overlay">
                    <div className="text-field">
                        <span>{t("searchLabel")}</span>
                        <div className="residence-autocomplete-host" ref={autocompleteHostRef} />
                        <small>{t("searchHint")}</small>
                    </div>
                    <button
                        className="btn btn-secondary"
                        disabled={!isReady}
                        onClick={handleUseCurrentLocation}
                        type="button"
                    >
                        {t("useCurrentLocation")}
                    </button>
                </div>

                {/* ロード中/エラー通知 */}
                {status === "loading" ? (
                    <div className="residence-map-overlay-note" role="status">
                        {t("loadingMap")}
                    </div>
                ) : null}
                {status === "error" ? (
                    <div className="residence-map-overlay-note" role="status">
                        {t("mapError")}
                        {canRetryMapLoad(status) ? (
                            <button
                                className="btn btn-secondary"
                                onClick={() => {
                                    setRetryNonce(nextRetryNonce);
                                }}
                                type="button"
                            >
                                {t("retryMapLoad")}
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </div>

            {/* 地図下部オーバーレイ: サマリ・凡例・通知 */}
            <div className="residence-overlay-bottom">
                <div className="residence-info-panel">
                    <div className="selected-area-summary">
                        <div>
                            <span>{t("summaryResolution")}</span>
                            <strong>{summary.resolution}</strong>
                        </div>
                        <div>
                            <span>{t("summaryCellId")}</span>
                            <strong className="mono-value">{summary.cellHex ?? "—"}</strong>
                        </div>
                        <div>
                            <span>{t("summaryAllowlist")}</span>
                            <strong>{summary.allowlistStatus}</strong>
                        </div>
                    </div>

                    <ul className="residence-legend">
                        {legendEntries.map((entry) => (
                            <li className="residence-legend-item" key={entry.kind}>
                                <span
                                    className={`residence-legend-swatch swatch-${entry.swatch}`}
                                />
                                <span>{t(entry.labelKey as Parameters<typeof t>[0])}</span>
                            </li>
                        ))}
                    </ul>

                    {workerUnavailable ? (
                        <p className="residence-notice" role="status">
                            {t("workerUnavailable")}
                        </p>
                    ) : null}
                    {notice !== null ? (
                        <p className="residence-notice" role="status">
                            {notice}
                        </p>
                    ) : null}

                    <input name="homeCell" type="hidden" value={selectedDecimal ?? ""} />

                    {shouldShowAdvancedCellInput(status) ? (
                        <details className="advanced-cell-input">
                            <summary>{t("advancedSummary")}</summary>
                            <label className="text-field" htmlFor="home-cell-advanced">
                                <span>{t("advancedLabel")}</span>
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
                                <small>{t("advancedHelp")}</small>
                            </label>
                        </details>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
