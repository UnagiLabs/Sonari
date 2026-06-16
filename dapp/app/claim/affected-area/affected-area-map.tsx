"use client";

// ---------------------------------------------------------------------------
// AffectedAreaMap – 被災エリア表示専用地図コンポーネント
//
// 被災セルを affected_cells 由来の事前生成 tile artifact から表示する。
// 低倍率では SVG raster tile、高倍率では visible viewport の cell tile JSON
// だけを取得して Google Maps Polygon として描画する。
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
import type { AffectedAreaArtifactSource, CellSource } from "../catalog/claimable-program";
import {
    type AffectedCellDetail,
    buildCellDetail,
    polygonStyleForBand,
} from "./affected-area-style";
import {
    type AffectedAreaTileManifest,
    type AffectedCellTileFeature,
    cellTileKeysForViewport,
    dedupeCellTileFeatures,
    featureToAffectedCell,
    parseAffectedAreaTileManifest,
    parseAffectedCellTile,
    rasterTileUrlForManifest,
    selectAffectedAreaLayerModeForZoom,
    tileUrlFromTemplate,
} from "./affected-area-tiles";

const mapsApiKey = readGoogleMapsApiKey();

const DEFAULT_CENTER: google.maps.LatLngLiteral = { lat: 38.0, lng: 140.9 };
const HOME_ZOOM = 13;
const OVERVIEW_ZOOM = 8;

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
    if (!res.ok) {
        throw new Error(`affected area fetch failed: HTTP ${res.status}`);
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

function centerOfBounds(bounds: ViewportBounds): google.maps.LatLngLiteral {
    return {
        lat: (bounds.north + bounds.south) / 2,
        lng: (bounds.east + bounds.west) / 2,
    };
}

function removeOverlayMapType(map: google.maps.Map, imageMapType: google.maps.ImageMapType): void {
    const overlays = map.overlayMapTypes;
    for (let i = overlays.getLength() - 1; i >= 0; i -= 1) {
        if (overlays.getAt(i) === imageMapType) {
            overlays.removeAt(i);
        }
    }
}

export interface AffectedAreaMapProps {
    /** 被災セルの取得元。deferred の fallback 判定に使う。 */
    readonly cellSource: CellSource;
    /** 表示用 affected-area artifact の取得元。 */
    readonly affectedAreaArtifact: AffectedAreaArtifactSource;
    /**
     * 居住セル（10進）。任意。
     * 有効な res7 セルなら自宅中心モード＋強調、なければ俯瞰モード。
     */
    readonly residenceCell?: string | null;
}

/**
 * 被災エリアを地図上に表示する読み取り専用コンポーネント。
 *
 * - manifestPath から tile manifest を取得する。
 * - zoom < minCellZoom では SVG raster tile overlay を ImageMapType で表示する。
 * - zoom >= minCellZoom では visible viewport の cell tile JSON だけを取得し、
 *   decimal で dedupe して Polygon を差分同期する。
 * - 通常表示では全件 affected-cells.json を fetch しない。
 */
export function AffectedAreaMap({
    cellSource,
    affectedAreaArtifact,
    residenceCell,
}: AffectedAreaMapProps) {
    const t = useTranslations("claim.affectedAreaMap");

    const parsedHome = residenceCell != null ? parseHomeCell(residenceCell) : null;
    const isHomeMode = parsedHome !== null;
    const cellSourceKind = cellSource.kind;
    const manifestPath = affectedAreaArtifact.manifestPath;

    const [status, setStatus] = useState<MapsLoaderStatus>(() => {
        if (cellSourceKind === "deferred") {
            return "unconfigured";
        }
        return resolveInitialMapsStatus(mapsApiKey);
    });
    const [manifest, setManifest] = useState<AffectedAreaTileManifest | null>(null);
    const [fetchError, setFetchError] = useState<boolean>(false);
    const [fetchDone, setFetchDone] = useState<boolean>(false);
    const [selectedDetail, setSelectedDetail] = useState<AffectedCellDetail | null>(null);

    const mapElRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<google.maps.Map | null>(null);
    const polygonsRef = useRef<Map<string, google.maps.Polygon>>(new Map());
    const homeCellPolyRef = useRef<google.maps.Polygon | null>(null);
    const rasterOverlayRef = useRef<google.maps.ImageMapType | null>(null);
    const rasterOverlaySourceRef = useRef<string | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const manifestRef = useRef<AffectedAreaTileManifest | null>(manifest);
    const parsedHomeRef = useRef(parsedHome);
    const tileCacheRef = useRef<Map<string, readonly AffectedCellTileFeature[]>>(new Map());
    const tileFetchSeqRef = useRef(0);
    const knownAffectedHomeRef = useRef(false);

    useEffect(() => {
        manifestRef.current = manifest;
    }, [manifest]);

    useEffect(() => {
        parsedHomeRef.current = parsedHome;
    });

    useEffect(() => {
        if (cellSourceKind === "deferred") {
            return;
        }
        let cancelled = false;

        setFetchError(false);
        setFetchDone(false);
        setManifest(null);
        tileCacheRef.current.clear();

        fetchJson(manifestPath)
            .then((json) => {
                const parsed = parseAffectedAreaTileManifest(json);
                if (parsed === null) {
                    throw new Error("invalid affected area manifest");
                }
                if (!cancelled) {
                    setManifest(parsed);
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
    }, [cellSourceKind, manifestPath]);

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

    const setRasterOverlayVisible = useCallback(
        (map: google.maps.Map, nextManifest: AffectedAreaTileManifest, visible: boolean) => {
            let overlay = rasterOverlayRef.current;
            if (overlay !== null && rasterOverlaySourceRef.current !== nextManifest.sourceSha256) {
                removeOverlayMapType(map, overlay);
                rasterOverlayRef.current = null;
                rasterOverlaySourceRef.current = null;
                overlay = null;
            }
            if (overlay === null) {
                overlay = new google.maps.ImageMapType({
                    tileSize: new google.maps.Size(nextManifest.tileSize, nextManifest.tileSize),
                    opacity: 1,
                    getTileUrl: (coord, zoom) => {
                        return rasterTileUrlForManifest(nextManifest, {
                            z: zoom,
                            x: coord.x,
                            y: coord.y,
                        });
                    },
                });
                rasterOverlayRef.current = overlay;
                rasterOverlaySourceRef.current = nextManifest.sourceSha256;
            }

            if (visible) {
                removeOverlayMapType(map, overlay);
                map.overlayMapTypes.push(overlay);
            } else {
                removeOverlayMapType(map, overlay);
            }
        },
        [],
    );

    const syncPolygons = useCallback(
        (features: readonly AffectedCellTileFeature[], map: google.maps.Map) => {
            const home = parsedHomeRef.current;
            const homeDecimal = home?.decimal ?? null;

            const nextDecimals = new Set(features.map((feature) => feature.decimal));

            for (const [decimal, poly] of polygonsRef.current) {
                if (!nextDecimals.has(decimal)) {
                    google.maps.event.clearInstanceListeners(poly);
                    poly.setMap(null);
                    polygonsRef.current.delete(decimal);
                }
            }

            for (const feature of features) {
                const cell = featureToAffectedCell(feature);
                const highlighted = cell.decimal === homeDecimal;
                if (highlighted) {
                    knownAffectedHomeRef.current = true;
                }
                const style = polygonStyleForBand(cell.band, highlighted);
                const existing = polygonsRef.current.get(cell.decimal);
                if (existing === undefined) {
                    const poly = new google.maps.Polygon({
                        paths: feature.boundary,
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

            if (home !== null && !knownAffectedHomeRef.current) {
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
        },
        [],
    );

    const syncCellTiles = useCallback(
        async (
            map: google.maps.Map,
            nextManifest: AffectedAreaTileManifest,
            bounds: ViewportBounds,
        ): Promise<void> => {
            tileFetchSeqRef.current += 1;
            const sequence = tileFetchSeqRef.current;
            const keys = cellTileKeysForViewport(nextManifest, bounds);

            const fetched = await Promise.all(
                keys.map(async (key) => {
                    const cached = tileCacheRef.current.get(key);
                    if (cached !== undefined) {
                        return cached;
                    }
                    const [z, x, y] = key.split("/").map(Number);
                    const json = await fetchJson(
                        tileUrlFromTemplate(nextManifest.cellTileUrlTemplate, { z, x, y }),
                    );
                    const tile = parseAffectedCellTile(json);
                    if (tile === null || tile.z !== z || tile.x !== x || tile.y !== y) {
                        throw new Error(`invalid affected cell tile: ${key}`);
                    }
                    tileCacheRef.current.set(key, tile.features);
                    return tile.features;
                }),
            );

            if (sequence !== tileFetchSeqRef.current || mapRef.current !== map) {
                return;
            }
            const features = dedupeCellTileFeatures(fetched.flat());
            syncPolygons(features, map);
        },
        [syncPolygons],
    );

    const syncOverlay = useCallback(() => {
        const map = mapRef.current;
        const nextManifest = manifestRef.current;
        if (map === null || nextManifest === null) {
            return;
        }

        const zoom = map.getZoom() ?? OVERVIEW_ZOOM;
        const layerMode = selectAffectedAreaLayerModeForZoom(zoom, nextManifest);
        if (layerMode === "raster") {
            tileFetchSeqRef.current += 1;
            clearCellPolygons();
            setRasterOverlayVisible(map, nextManifest, true);
            return;
        }

        setRasterOverlayVisible(map, nextManifest, false);
        const bounds = mapBoundsToViewportBounds(map.getBounds());
        if (bounds === null) {
            clearCellPolygons();
            return;
        }

        void syncCellTiles(map, nextManifest, bounds).catch(() => {
            clearCellPolygons();
            setFetchError(true);
        });
    }, [clearCellPolygons, setRasterOverlayVisible, syncCellTiles]);

    useEffect(() => {
        const map = mapRef.current;
        if (map === null || manifest === null) {
            return;
        }
        if (!isHomeMode) {
            map.fitBounds(manifest.bounds);
        }
        syncOverlay();
    }, [isHomeMode, manifest, syncOverlay]);

    useEffect(() => {
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

                const currentManifest = manifestRef.current;
                const initialCenter =
                    isHomeMode && parsedHomeRef.current !== null
                        ? residenceCellCenter(parsedHomeRef.current.hex)
                        : currentManifest !== null
                          ? centerOfBounds(currentManifest.bounds)
                          : DEFAULT_CENTER;
                const initialZoom = isHomeMode ? HOME_ZOOM : OVERVIEW_ZOOM;

                const map = new google.maps.Map(element, {
                    center: initialCenter,
                    zoom: initialZoom,
                    disableDefaultUI: true,
                    clickableIcons: false,
                    gestureHandling: "cooperative",
                });
                mapRef.current = map;

                if (!isHomeMode && currentManifest !== null) {
                    map.fitBounds(currentManifest.bounds);
                }

                map.addListener("idle", () => {
                    syncOverlay();
                });

                setStatus("ready");
                syncOverlay();

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

            if (resizeObserverRef.current !== null) {
                resizeObserverRef.current.disconnect();
                resizeObserverRef.current = null;
            }

            clearCellPolygons();

            const map = mapRef.current;
            if (map !== null) {
                if (rasterOverlayRef.current !== null) {
                    removeOverlayMapType(map, rasterOverlayRef.current);
                    rasterOverlayRef.current = null;
                    rasterOverlaySourceRef.current = null;
                }
                google.maps.event.clearInstanceListeners(map);
            }
            mapRef.current = null;
        };
    }, [cellSourceKind, clearCellPolygons, isHomeMode, syncOverlay]);

    const legendEntries = buildBandLegendEntries();

    if (cellSourceKind === "deferred") {
        return (
            <div className="affected-area-map-fallback">
                <p className="affected-area-map-fallback-title">{t("deferredTitle")}</p>
                <p>{t("deferredBody")}</p>
            </div>
        );
    }

    if (!isGoogleMapsConfigured(mapsApiKey)) {
        return (
            <div className="affected-area-map-fallback">
                <p className="affected-area-map-fallback-title">{t("unconfiguredTitle")}</p>
                <p>{t("unconfiguredBody")}</p>
            </div>
        );
    }

    return (
        <div className="affected-area-map">
            <div className="affected-area-map-stage">
                <div
                    aria-label={t("ariaLabel")}
                    className="affected-area-map-canvas"
                    ref={mapElRef}
                    role="application"
                />

                {status === "loading" ? (
                    <div className="affected-area-map-overlay-note" role="status">
                        {t("loading")}
                    </div>
                ) : null}
                {status === "error" || fetchError ? (
                    <div className="affected-area-map-overlay-note" role="status">
                        {t("errorBody")}
                    </div>
                ) : null}
                {status === "ready" &&
                fetchDone &&
                !fetchError &&
                manifest !== null &&
                manifest.cellCount === 0 ? (
                    <div className="affected-area-map-overlay-note" role="status">
                        {t("emptyBody")}
                    </div>
                ) : null}
            </div>

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
