"use client";

// ---------------------------------------------------------------------------
// AffectedAreaMap – 被災エリア表示専用地図コンポーネント
//
// 被災セルをバンド色のポリゴンで描画し、凡例・タップ詳細・モード自動切替・
// フォールバックを備える表示専用コンポーネント。
// 請求・セル選択・親通知・hidden input は一切持たない。
// ---------------------------------------------------------------------------

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseHomeCell } from "../../mypage/home-cell";
import {
    isGoogleMapsConfigured,
    loadGoogleMapsLibraries,
    type MapsLoaderStatus,
    readGoogleMapsApiKey,
    resolveInitialMapsStatus,
} from "../../register/residence/google-maps-loader";
import {
    residenceCellBoundary,
    residenceCellCenter,
    type ViewportBounds,
} from "../../register/residence/h3-geo";
import { buildBandLegendEntries } from "../catalog/cell-band-rules";
import type { CellSource, DisasterOverviewOverlay } from "../catalog/claimable-program";
import {
    buildAffectedCellGeometries,
    computeAffectedAreaBounds,
    MAX_AFFECTED_VIEWPORT_CELLS,
    selectAffectedAreaLayerMode,
    selectMapMode,
    selectVisibleCells,
} from "./affected-area-geo";
import {
    type AffectedCellDetail,
    buildCellDetail,
    polygonStyleForBand,
} from "./affected-area-style";
import { type AffectedCell, parseAffectedCells } from "./affected-cells";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

// NEXT_PUBLIC_* はビルド時にインライン化される（output: "export"）。
const mapsApiKey = readGoogleMapsApiKey();

// 被災エリアが空または null のときに使う固定初期中心（東北地方付近）。
const DEFAULT_CENTER: google.maps.LatLngLiteral = { lat: 38.0, lng: 140.9 };
// home モードのズーム。
const HOME_ZOOM = 13;
// overview モードのデフォルトズーム（fitBounds 失敗時）。
const OVERVIEW_ZOOM = 8;

// 自宅セルが被災集合に含まれないときに使う中立アウトラインスタイル。
const HOME_CELL_OUTLINE_STYLE = {
    strokeColor: "#1e40af",
    strokeOpacity: 0.85,
    strokeWeight: 2.5,
    fillColor: "#3b82f6",
    fillOpacity: 0.12,
    zIndex: 5,
} as const;

async function fetchJson(path: string): Promise<unknown> {
    const res = await fetch(path);
    // 非 2xx（例: JSON ボディ付き 404）は空集合ではなくエラー扱いにする。
    if (!res.ok) {
        throw new Error(`affected cells fetch failed: HTTP ${res.status}`);
    }
    return res.json();
}

function mapBoundsToViewportBounds(
    bounds: google.maps.LatLngBounds | undefined,
): ViewportBounds | null {
    if (bounds === undefined) {
        return null;
    }
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    return {
        north: ne.lat(),
        south: sw.lat(),
        east: ne.lng(),
        west: sw.lng(),
    };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AffectedAreaMapProps {
    /** 被災セルの取得元（#382 で定義した形）。 */
    readonly cellSource: CellSource;
    /** 俯瞰時に使う band-colored 画像 overlay。任意。 */
    readonly overviewOverlay?: DisasterOverviewOverlay;
    /**
     * 居住セル（10進）。任意。
     * 有効な res7 セルなら自宅中心モード＋強調、なければ俯瞰モード。
     */
    readonly residenceCell?: string | null;
}

// ---------------------------------------------------------------------------
// コンポーネント
// ---------------------------------------------------------------------------

/**
 * 被災エリアを地図上に表示する読み取り専用コンポーネント。
 *
 * - cellSource が "static-asset" のとき、マウント後に fetch して被災セルを取得する。
 * - residenceCell が有効な res7 セルなら home モード（自宅中心・強調）、
 *   なければ overview モード（全体 fitBounds）を使う。
 * - overviewOverlay がある場合、低倍率では band-colored 画像を GroundOverlay で表示し、
 *   viewport 内セルが少ないときだけ raw res7 セルを描く。
 * - 各セルポリゴンをクリックすると詳細パネルに buildCellDetail の内容を表示する。
 * - deferred / API 未設定 / fetch 失敗 / 空集合のときはテキストフォールバック。
 */
export function AffectedAreaMap({
    cellSource,
    overviewOverlay,
    residenceCell,
}: AffectedAreaMapProps) {
    const t = useTranslations("claim.affectedAreaMap");

    // 居住セルの検証済み情報
    const parsedHome = residenceCell != null ? parseHomeCell(residenceCell) : null;
    const mode = selectMapMode(residenceCell ?? null);

    // cellSource はオブジェクト参照が呼び出し側で不安定でも、effect の再実行
    // （地図の作り直し・再 fetch）が暴発しないよう、依存にはプリミティブを使う。
    const cellSourceKind = cellSource.kind;
    const cellSourcePath = cellSource.kind === "static-asset" ? cellSource.path : null;
    const overviewOverlayUrl = overviewOverlay?.url ?? null;
    const overviewOverlayOpacity = overviewOverlay?.opacity ?? 1;
    const overviewOverlayBounds = overviewOverlay?.bounds ?? null;

    // ---------------------------------------------------------------------------
    // State / Ref
    // ---------------------------------------------------------------------------

    // deferred の場合は地図を出さないため最初から "unconfigured" 扱いにする。
    // 初回描画でサーバー/クライアントを一致させるため、env に依存する初期化は
    // マウント後の useEffect で行う。ただし deferred は最優先でフォールバックする。
    const [status, setStatus] = useState<MapsLoaderStatus>(() => {
        if (cellSourceKind === "deferred") {
            return "unconfigured";
        }
        return resolveInitialMapsStatus(mapsApiKey);
    });

    // 被災セルの取得状態
    const [cells, setCells] = useState<AffectedCell[]>([]);
    const [fetchError, setFetchError] = useState<boolean>(false);
    const [fetchDone, setFetchDone] = useState<boolean>(false);
    const cellGeometries = useMemo(() => buildAffectedCellGeometries(cells), [cells]);

    // タップ詳細パネル
    const [selectedDetail, setSelectedDetail] = useState<AffectedCellDetail | null>(null);

    // Refs
    const mapElRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<google.maps.Map | null>(null);
    // 被災セル polygon map: decimal → Polygon
    const polygonsRef = useRef<Map<string, google.maps.Polygon>>(new Map());
    // 自宅アウトライン用の専用ポリゴン（被災集合外の自宅セルに使う）
    const homeCellPolyRef = useRef<google.maps.Polygon | null>(null);
    const overviewOverlayRef = useRef<google.maps.GroundOverlay | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const cellsRef = useRef<AffectedCell[]>([]);
    const cellGeometriesRef = useRef(cellGeometries);
    const parsedHomeRef = useRef(parsedHome);

    // ref を最新に同期する
    useEffect(() => {
        cellsRef.current = cells;
        cellGeometriesRef.current = cellGeometries;
    }, [cells, cellGeometries]);

    useEffect(() => {
        parsedHomeRef.current = parsedHome;
    });

    // ---------------------------------------------------------------------------
    // 被災セルの fetch（static-asset のみ）
    // ---------------------------------------------------------------------------

    useEffect(() => {
        if (cellSourcePath === null) {
            return;
        }
        let cancelled = false;

        setFetchError(false);
        setFetchDone(false);
        setCells([]);

        fetchJson(cellSourcePath)
            .then((json) => {
                if (!cancelled) {
                    setCells(parseAffectedCells(json));
                    setFetchDone(true);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setFetchError(true);
                    setFetchDone(true);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [cellSourcePath]);

    const clearCellPolygons = useCallback(() => {
        for (const poly of polygonsRef.current.values()) {
            google.maps.event.clearInstanceListeners(poly);
            poly.setMap(null);
        }
        polygonsRef.current.clear();

        if (homeCellPolyRef.current !== null) {
            google.maps.event.clearInstanceListeners(homeCellPolyRef.current);
            homeCellPolyRef.current.setMap(null);
            homeCellPolyRef.current = null;
        }
    }, []);

    const resetOverviewOverlay = useCallback(
        (map: google.maps.Map) => {
            if (overviewOverlayRef.current !== null) {
                overviewOverlayRef.current.setMap(null);
                overviewOverlayRef.current = null;
            }
            if (overviewOverlayUrl === null || overviewOverlayBounds === null) {
                return null;
            }
            const overlay = new google.maps.GroundOverlay(
                overviewOverlayUrl,
                overviewOverlayBounds,
                { opacity: overviewOverlayOpacity },
            );
            overviewOverlayRef.current = overlay;
            overlay.setMap(map);
            return overlay;
        },
        [overviewOverlayBounds, overviewOverlayOpacity, overviewOverlayUrl],
    );

    const setOverviewOverlayVisible = useCallback(
        (visible: boolean) => {
            const map = mapRef.current;
            if (map === null) {
                return;
            }
            const overlay = overviewOverlayRef.current ?? resetOverviewOverlay(map);
            if (overlay === null) {
                return;
            }
            overlay.setMap(visible ? map : null);
        },
        [resetOverviewOverlay],
    );

    const syncPolygons = useCallback((visibleCells: AffectedCell[], map: google.maps.Map) => {
        const home = parsedHomeRef.current;
        const homeDecimal = home?.decimal ?? null;

        const nextDecimals = new Set(visibleCells.map((c) => c.decimal));

        for (const [decimal, poly] of polygonsRef.current) {
            if (!nextDecimals.has(decimal)) {
                google.maps.event.clearInstanceListeners(poly);
                poly.setMap(null);
                polygonsRef.current.delete(decimal);
            }
        }

        for (const cell of visibleCells) {
            const highlighted = cell.decimal === homeDecimal;
            const style = polygonStyleForBand(cell.band, highlighted);
            const existing = polygonsRef.current.get(cell.decimal);
            if (existing === undefined) {
                const geometry = cellGeometriesRef.current.find(
                    (candidate) => candidate.cell.decimal === cell.decimal,
                );
                const poly = new google.maps.Polygon({
                    paths: geometry?.boundary ?? residenceCellBoundary(cell.hex),
                    ...style,
                });
                poly.setMap(map);
                poly.addListener("click", () => {
                    setSelectedDetail(buildCellDetail(cell));
                });
                polygonsRef.current.set(cell.decimal, poly);
            } else {
                existing.setOptions(style);
            }
        }

        if (home !== null) {
            const inAffected = cellsRef.current.some((c) => c.decimal === home.decimal);
            if (!inAffected) {
                if (homeCellPolyRef.current === null) {
                    const homePoly = new google.maps.Polygon({
                        paths: residenceCellBoundary(home.hex),
                        ...HOME_CELL_OUTLINE_STYLE,
                    });
                    homePoly.setMap(map);
                    homeCellPolyRef.current = homePoly;
                }
            } else if (homeCellPolyRef.current !== null) {
                homeCellPolyRef.current.setMap(null);
                homeCellPolyRef.current = null;
            }
        }
    }, []);

    const syncOverlay = useCallback(() => {
        const map = mapRef.current;
        if (map === null) {
            return;
        }
        const bounds = mapBoundsToViewportBounds(map.getBounds());
        if (bounds === null) {
            setOverviewOverlayVisible(true);
            return;
        }

        const sourceGeometries = cellGeometriesRef.current;
        if (sourceGeometries.length === 0) {
            clearCellPolygons();
            setOverviewOverlayVisible(true);
            return;
        }

        const layerMode =
            overviewOverlayUrl === null
                ? "cells"
                : selectAffectedAreaLayerMode({
                      cells: sourceGeometries,
                      bounds,
                      threshold: MAX_AFFECTED_VIEWPORT_CELLS,
                  });

        if (layerMode === "overview-overlay") {
            clearCellPolygons();
            setOverviewOverlayVisible(true);
            return;
        }

        setOverviewOverlayVisible(false);
        const home = parsedHomeRef.current;
        const visibleCells = selectVisibleCells({
            cells: sourceGeometries,
            bounds,
            limit: MAX_AFFECTED_VIEWPORT_CELLS,
            highlightedDecimal: home?.decimal ?? null,
        });
        syncPolygons(visibleCells, map);
    }, [clearCellPolygons, overviewOverlayUrl, setOverviewOverlayVisible, syncPolygons]);

    // cells / overlay が変化したら表示レイヤーを同期する。
    useEffect(() => {
        const map = mapRef.current;
        if (map === null) {
            return;
        }
        resetOverviewOverlay(map);
        if (mode === "overview") {
            if (overviewOverlayBounds !== null) {
                map.fitBounds(overviewOverlayBounds);
            } else {
                const bounds = computeAffectedAreaBounds(cellGeometries);
                if (bounds !== null) {
                    map.fitBounds(bounds);
                }
            }
        }
        syncOverlay();
    }, [cellGeometries, mode, overviewOverlayBounds, resetOverviewOverlay, syncOverlay]);

    // ---------------------------------------------------------------------------
    // 地図初期化 effect（マウント時に一度だけ）
    // ---------------------------------------------------------------------------

    useEffect(() => {
        // deferred は地図を出さない
        if (cellSourceKind === "deferred") {
            return;
        }

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

                // home モードは自宅中心・固定ズーム
                // overview モードは全体 fitBounds
                let initialCenter: google.maps.LatLngLiteral;
                let initialZoom: number;

                if (mode === "home" && parsedHomeRef.current !== null) {
                    const center = residenceCellCenter(parsedHomeRef.current.hex);
                    initialCenter = { lat: center.lat, lng: center.lng };
                    initialZoom = HOME_ZOOM;
                } else {
                    const bounds =
                        overviewOverlayBounds ??
                        computeAffectedAreaBounds(cellGeometriesRef.current);
                    if (bounds !== null) {
                        // fitBounds は後で呼ぶ。初期値は bounds 中心に仮置き
                        initialCenter = {
                            lat: (bounds.north + bounds.south) / 2,
                            lng: (bounds.east + bounds.west) / 2,
                        };
                    } else {
                        initialCenter = DEFAULT_CENTER;
                    }
                    initialZoom = OVERVIEW_ZOOM;
                }

                const map = new google.maps.Map(element, {
                    center: initialCenter,
                    zoom: initialZoom,
                    disableDefaultUI: true,
                    clickableIcons: false,
                    gestureHandling: "cooperative",
                });
                mapRef.current = map;

                resetOverviewOverlay(map);

                // overview モードでは band overlay または affected cells の範囲へ合わせる
                if (mode === "overview") {
                    const bounds =
                        overviewOverlayBounds ??
                        computeAffectedAreaBounds(cellGeometriesRef.current);
                    if (bounds !== null) {
                        map.fitBounds({
                            north: bounds.north,
                            south: bounds.south,
                            east: bounds.east,
                            west: bounds.west,
                        });
                    }
                }

                map.addListener("idle", () => {
                    syncOverlay();
                });

                setStatus("ready");
                syncOverlay();

                // コンテナサイズ変更時に地図中心を保持する
                if (typeof ResizeObserver !== "undefined") {
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

            // ResizeObserver の解除
            if (resizeObserverRef.current !== null) {
                resizeObserverRef.current.disconnect();
                resizeObserverRef.current = null;
            }

            // overlay cleanup
            clearCellPolygons();
            if (overviewOverlayRef.current !== null) {
                overviewOverlayRef.current.setMap(null);
                overviewOverlayRef.current = null;
            }

            // map リスナの解除
            const map = mapRef.current;
            if (map !== null) {
                google.maps.event.clearInstanceListeners(map);
            }
            mapRef.current = null;
        };
    }, [
        cellSourceKind,
        clearCellPolygons,
        mode,
        overviewOverlayBounds,
        resetOverviewOverlay,
        syncOverlay,
    ]);

    // ---------------------------------------------------------------------------
    // 凡例エントリ（固定。renders ごとに再生成しない）
    // ---------------------------------------------------------------------------

    const legendEntries = buildBandLegendEntries();

    // ---------------------------------------------------------------------------
    // フォールバック優先順位
    //
    // 1. deferred → 「被災エリア準備中」フォールバック
    // 2. API 未設定 → 「地図表示不可」フォールバック
    // 3. 地図を描く（その中で loading / error / empty をインライン表示）
    // ---------------------------------------------------------------------------

    // deferred フォールバック
    if (cellSourceKind === "deferred") {
        return (
            <div className="affected-area-map-fallback">
                <p className="affected-area-map-fallback-title">{t("deferredTitle")}</p>
                <p>{t("deferredBody")}</p>
            </div>
        );
    }

    // API 未設定フォールバック
    if (!isGoogleMapsConfigured(mapsApiKey)) {
        return (
            <div className="affected-area-map-fallback">
                <p className="affected-area-map-fallback-title">{t("unconfiguredTitle")}</p>
                <p>{t("unconfiguredBody")}</p>
            </div>
        );
    }

    // 地図ステージ + 凡例 + 詳細パネル
    return (
        <div className="affected-area-map">
            {/* 地図ステージ */}
            <div className="affected-area-map-stage">
                <div
                    aria-label={t("ariaLabel")}
                    className="affected-area-map-canvas"
                    ref={mapElRef}
                    role="application"
                />

                {/* ローディング・エラー・空集合をオーバーレイで表示 */}
                {status === "loading" ? (
                    <div className="affected-area-map-overlay-note" role="status">
                        {t("loading")}
                    </div>
                ) : null}
                {status === "error" ? (
                    <div className="affected-area-map-overlay-note" role="status">
                        {t("errorBody")}
                    </div>
                ) : null}
                {status === "ready" && fetchDone && !fetchError && cells.length === 0 ? (
                    <div className="affected-area-map-overlay-note" role="status">
                        {t("emptyBody")}
                    </div>
                ) : null}
            </div>

            {/* 凡例 */}
            <div className="affected-area-map-legend">
                <p className="affected-area-map-legend-title">{t("legendTitle")}</p>
                <ul className="affected-area-map-legend-list">
                    {legendEntries.map((entry) => (
                        <li className="affected-area-map-legend-item" key={entry.band}>
                            <span
                                className="affected-area-map-legend-swatch"
                                style={{ backgroundColor: entry.color }}
                            />
                            <span>
                                {t("legendItem", { band: entry.band, amount: entry.amount })}
                            </span>
                        </li>
                    ))}
                    {/* 自宅セルが有効な res7 セルならば凡例に「あなたのセル」を出す */}
                    {parsedHome !== null ? (
                        <li className="affected-area-map-legend-item">
                            <span
                                className="affected-area-map-legend-swatch"
                                style={{ backgroundColor: HOME_CELL_OUTLINE_STYLE.fillColor }}
                            />
                            <span>{t("homeCellLabel")}</span>
                        </li>
                    ) : null}
                </ul>
            </div>

            {/* タップ詳細パネル */}
            {selectedDetail !== null ? (
                <div className="affected-area-map-detail">
                    <p className="affected-area-map-detail-title">{t("detailTitle")}</p>
                    <p>{t("detailBand", { band: selectedDetail.band })}</p>
                    <p>{t("detailAmount", { amount: selectedDetail.amountUsdc })}</p>
                    <p>{t("detailCellId", { id: selectedDetail.shortCellId })}</p>
                    <button
                        className="affected-area-map-detail-close"
                        onClick={() => {
                            setSelectedDetail(null);
                        }}
                        type="button"
                    >
                        {t("detailClose")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
