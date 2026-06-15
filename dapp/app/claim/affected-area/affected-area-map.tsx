"use client";

// ---------------------------------------------------------------------------
// AffectedAreaMap – 被災エリア表示専用地図コンポーネント
//
// 被災セルをバンド色のポリゴンで描画し、凡例・タップ詳細・モード自動切替・
// フォールバックを備える表示専用コンポーネント。
// 請求・セル選択・親通知・hidden input は一切持たない。
// ---------------------------------------------------------------------------

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
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
import type { CellSource } from "../catalog/claimable-program";
import { computeAffectedAreaBounds, selectMapMode, selectVisibleCells } from "./affected-area-geo";
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

// pan/zoom 後のポリゴン再構築をまとめる debounce(ms)。
const REBUILD_DEBOUNCE_MS = 150;

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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AffectedAreaMapProps {
    /** 被災セルの取得元（#382 で定義した形）。 */
    readonly cellSource: CellSource;
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
 * - 地図 idle 時に debounce して viewport 内のセルだけポリゴンを描く（差分 sync）。
 * - 各ポリゴンをクリックすると詳細パネルに buildCellDetail の内容を表示する。
 * - deferred / API 未設定 / fetch 失敗 / 空集合のときはテキストフォールバック。
 */
export function AffectedAreaMap({ cellSource, residenceCell }: AffectedAreaMapProps) {
    const t = useTranslations("claim.affectedAreaMap");

    // 居住セルの検証済み情報
    const parsedHome = residenceCell != null ? parseHomeCell(residenceCell) : null;
    const mode = selectMapMode(residenceCell ?? null);

    // ---------------------------------------------------------------------------
    // State / Ref
    // ---------------------------------------------------------------------------

    // deferred の場合は地図を出さないため最初から "unconfigured" 扱いにする。
    // 初回描画でサーバー/クライアントを一致させるため、env に依存する初期化は
    // マウント後の useEffect で行う。ただし deferred は最優先でフォールバックする。
    const [status, setStatus] = useState<MapsLoaderStatus>(() => {
        if (cellSource.kind === "deferred") {
            return "unconfigured";
        }
        return resolveInitialMapsStatus(mapsApiKey);
    });

    // 被災セルの取得状態
    const [cells, setCells] = useState<AffectedCell[]>([]);
    const [fetchError, setFetchError] = useState<boolean>(false);
    const [fetchDone, setFetchDone] = useState<boolean>(false);

    // タップ詳細パネル
    const [selectedDetail, setSelectedDetail] = useState<AffectedCellDetail | null>(null);

    // Refs
    const mapElRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<google.maps.Map | null>(null);
    // 被災セル polygon map: decimal → Polygon
    const polygonsRef = useRef<Map<string, google.maps.Polygon>>(new Map());
    // 自宅アウトライン用の専用ポリゴン（被災集合外の自宅セルに使う）
    const homeCellPolyRef = useRef<google.maps.Polygon | null>(null);
    const rebuildTimerRef = useRef<number | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    // 最新 cells を rebuild 内で参照するための ref（useCallback を再生成しないため）
    const cellsRef = useRef<AffectedCell[]>([]);
    const parsedHomeRef = useRef(parsedHome);

    // ref を最新に同期する
    useEffect(() => {
        cellsRef.current = cells;
    }, [cells]);

    useEffect(() => {
        parsedHomeRef.current = parsedHome;
    });

    // ---------------------------------------------------------------------------
    // 被災セルの fetch（static-asset のみ）
    // ---------------------------------------------------------------------------

    useEffect(() => {
        if (cellSource.kind !== "static-asset") {
            return;
        }
        const { path } = cellSource;
        let cancelled = false;

        fetch(path)
            .then((res) => res.json())
            .then((json: unknown) => {
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
    }, [cellSource]);

    // ---------------------------------------------------------------------------
    // ポリゴン差分 sync
    // ---------------------------------------------------------------------------

    const syncPolygons = useCallback((visibleCells: AffectedCell[], map: google.maps.Map) => {
        const home = parsedHomeRef.current;
        const homeDecimal = home?.decimal ?? null;

        // 次の描画対象 decimal セット
        const nextDecimals = new Set(visibleCells.map((c) => c.decimal));

        // viewport から外れたポリゴンを除去する
        for (const [decimal, poly] of polygonsRef.current) {
            if (!nextDecimals.has(decimal)) {
                google.maps.event.clearInstanceListeners(poly);
                poly.setMap(null);
                polygonsRef.current.delete(decimal);
            }
        }

        // 追加・スタイル更新
        for (const cell of visibleCells) {
            const highlighted = cell.decimal === homeDecimal;
            const style = polygonStyleForBand(cell.band, highlighted);
            const existing = polygonsRef.current.get(cell.decimal);
            if (existing === undefined) {
                const poly = new google.maps.Polygon({
                    paths: residenceCellBoundary(cell.hex),
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

        // 自宅セルが被災集合に含まれない場合は中立アウトラインで描く
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
            } else {
                // 被災集合に含まれる → 中立アウトラインは不要
                if (homeCellPolyRef.current !== null) {
                    homeCellPolyRef.current.setMap(null);
                    homeCellPolyRef.current = null;
                }
            }
        }
    }, []);

    // ---------------------------------------------------------------------------
    // overlay 再構築（viewport 絞り込み→差分 sync）
    // ---------------------------------------------------------------------------

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

        const home = parsedHomeRef.current;
        const visibleCells = selectVisibleCells({
            cells: cellsRef.current,
            bounds: viewport,
            highlightedDecimal: home?.decimal ?? null,
        });

        syncPolygons(visibleCells, map);
    }, [syncPolygons]);

    const scheduleRebuild = useCallback(() => {
        if (rebuildTimerRef.current !== null) {
            window.clearTimeout(rebuildTimerRef.current);
        }
        rebuildTimerRef.current = window.setTimeout(() => {
            rebuildOverlay();
        }, REBUILD_DEBOUNCE_MS);
    }, [rebuildOverlay]);

    // cells が変化したら overlay を再構築する（fetch 完了後など）。
    // cells は cellsRef に同期済みのため直接依存に含めず、scheduleRebuild のみを依存とする。
    // biome-ignore lint/correctness/useExhaustiveDependencies: cells は cellsRef 経由で参照するため依存不要
    useEffect(() => {
        if (mapRef.current !== null) {
            scheduleRebuild();
        }
    }, [cells, scheduleRebuild]);

    // ---------------------------------------------------------------------------
    // 地図初期化 effect（マウント時に一度だけ）
    // ---------------------------------------------------------------------------

    useEffect(() => {
        // deferred は地図を出さない
        if (cellSource.kind === "deferred") {
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
                    const bounds = computeAffectedAreaBounds(cellsRef.current);
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

                // overview モードで cells がある場合は fitBounds で全体表示する
                if (mode === "overview") {
                    const bounds = computeAffectedAreaBounds(cellsRef.current);
                    if (bounds !== null) {
                        map.fitBounds({
                            north: bounds.north,
                            south: bounds.south,
                            east: bounds.east,
                            west: bounds.west,
                        });
                    }
                }

                // idle リスナ: pan/zoom 後に debounce して再構築する
                map.addListener("idle", () => {
                    scheduleRebuild();
                });

                setStatus("ready");
                scheduleRebuild();

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

            // debounce タイマの解除
            if (rebuildTimerRef.current !== null) {
                window.clearTimeout(rebuildTimerRef.current);
                rebuildTimerRef.current = null;
            }

            // 全ポリゴンの cleanup
            for (const poly of polygonsRef.current.values()) {
                google.maps.event.clearInstanceListeners(poly);
                poly.setMap(null);
            }
            polygonsRef.current.clear();

            // 自宅アウトラインの cleanup
            if (homeCellPolyRef.current !== null) {
                homeCellPolyRef.current.setMap(null);
                homeCellPolyRef.current = null;
            }

            // map リスナの解除
            const map = mapRef.current;
            if (map !== null) {
                google.maps.event.clearInstanceListeners(map);
            }
            mapRef.current = null;
        };
    }, [cellSource, mode, scheduleRebuild]);

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
    if (cellSource.kind === "deferred") {
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
