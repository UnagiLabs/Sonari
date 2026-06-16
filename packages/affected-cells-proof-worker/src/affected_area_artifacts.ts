import {
    affectedCellsRoot,
    parseAffectedCellsFile,
    sha256Hex,
    type AffectedCellsInput,
} from "@sonari/proof-core";
import { cellToBoundary } from "h3-js";

type CellBand = 1 | 2 | 3;

export interface AffectedAreaBounds {
    readonly north: number;
    readonly south: number;
    readonly east: number;
    readonly west: number;
}

export interface AffectedAreaLatLng {
    readonly lat: number;
    readonly lng: number;
}

export interface AffectedAreaTileManifest {
    readonly kind: "tiled-affected-cells";
    readonly eventUid: string;
    readonly affectedCellsRoot: string;
    readonly sourceSha256: string;
    readonly h3Resolution: 7;
    readonly cellCount: number;
    readonly bounds: AffectedAreaBounds;
    readonly styleVersion: number;
    readonly minRasterZoom: number;
    readonly maxRasterZoom: number;
    readonly minCellZoom: number;
    readonly cellTileZoom: number;
    readonly tileSize: 256;
    readonly rasterTileUrlTemplate: string;
    readonly cellTileUrlTemplate: string;
    readonly rasterTileKeys: readonly string[];
    readonly cellTileKeys: readonly string[];
}

export interface AffectedCellTileFeature {
    readonly decimal: string;
    readonly hex: string;
    readonly band: CellBand;
    readonly boundary: readonly AffectedAreaLatLng[];
    readonly bounds: AffectedAreaBounds;
}

export interface GeneratedAffectedAreaArtifacts {
    readonly affectedCellsJson: string;
    readonly manifest: AffectedAreaTileManifest;
    readonly rasterTiles: ReadonlyMap<string, string>;
    readonly cellTiles: ReadonlyMap<string, string>;
}

export interface GenerateAffectedAreaArtifactsParams {
    readonly bytes: Uint8Array;
    readonly affectedCellsRoot: string;
    readonly baseUrl: string;
}

interface CanonicalCell {
    readonly decimal: string;
    readonly hex: string;
    readonly band: CellBand;
    readonly boundary: readonly AffectedAreaLatLng[];
    readonly bounds: AffectedAreaBounds;
    readonly tileBounds: readonly AffectedAreaBounds[];
}

interface TileCoord {
    readonly z: number;
    readonly x: number;
    readonly y: number;
}

interface ProjectedCellPath {
    readonly band: CellBand;
    readonly path: string;
}

const BAND_COLOR: Readonly<Record<CellBand, string>> = {
    1: "#fde68a",
    2: "#f97316",
    3: "#dc2626",
};

const BOUNDS_DECIMAL_PLACES = 6;
const SVG_COORDINATE_DECIMAL_PLACES = 2;
const RASTER_FILL_OPACITY = 0.35;
const STYLE_VERSION = 1;
const TILE_SIZE = 256;
const MIN_RASTER_ZOOM = 6;
const MAX_RASTER_ZOOM = 10;
const MIN_CELL_ZOOM = 11;
const CELL_TILE_ZOOM = 11;

export function normalizeAffectedAreaBaseUrl(value: string | undefined): string | null {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0) {
        return null;
    }
    return trimmed.replace(/\/+$/u, "");
}

function affectedAreaR2ObjectPrefix(eventUid: string, eventRevision: number): string {
    return `affected-area/events/${eventUid}/revisions/${eventRevision}`;
}

function affectedAreaTileUrlTemplate(
    baseUrl: string,
    input: Pick<AffectedCellsInput, "event_uid" | "event_revision">,
    kind: "raster" | "cells",
): string {
    const extension = kind === "raster" ? "svg" : "json";
    return `${baseUrl}/${affectedAreaR2ObjectPrefix(input.event_uid, input.event_revision)}/${kind}/{z}/{x}/{y}.${extension}`;
}

function h3DecimalToHex(decimal: string): string {
    return BigInt(decimal).toString(16);
}

function round(value: number, decimalPlaces: number): number {
    const factor = 10 ** decimalPlaces;
    return Math.round(value * factor) / factor;
}

function formatSvgNumber(value: number): string {
    return round(value, SVG_COORDINATE_DECIMAL_PLACES).toFixed(SVG_COORDINATE_DECIMAL_PLACES);
}

function parseTileKeyParts(key: string): readonly [number, number, number] {
    const parts = key.split("/");
    if (parts.length !== 3) {
        throw new Error(`invalid tile key: ${key}`);
    }
    const z = Number(parts[0]);
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
        throw new Error(`invalid tile key: ${key}`);
    }
    return [z, x, y];
}

function sortTileKeys(a: string, b: string): number {
    const [az, ax, ay] = parseTileKeyParts(a);
    const [bz, bx, by] = parseTileKeyParts(b);
    return az - bz || ax - bx || ay - by;
}

export function tileOutputRelativePath(
    directory: "raster" | "cells",
    key: string,
): readonly string[] {
    const [z, x, y] = parseTileKeyParts(key);
    const extension = directory === "raster" ? "svg" : "json";
    return [directory, String(z), String(x), `${y}.${extension}`];
}

function canonicalAffectedCellsJson(input: AffectedCellsInput): string {
    return JSON.stringify({
        event_uid: input.event_uid,
        event_revision: input.event_revision,
        oracle_version: input.oracle_version,
        geo_resolution: input.geo_resolution,
        cells_generation_method: input.cells_generation_method,
        cell_metric: input.cell_metric,
        cell_aggregation: input.cell_aggregation,
        intensity_scale: input.intensity_scale,
        affected_cells: input.affected_cells.map((cell) => ({
            h3_index: cell.h3_index,
            intensity_value: cell.intensity_value,
            cell_band: cell.cell_band,
        })),
    });
}

function parseCanonicalSource(bytes: Uint8Array): AffectedCellsInput {
    try {
        return parseAffectedCellsFile(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`affected_cells file is invalid: ${message}`);
    }
}

function toCellBand(value: number): CellBand {
    if (value !== 1 && value !== 2 && value !== 3) {
        throw new Error(`cell_band must be 1, 2, or 3, got ${value}`);
    }
    return value;
}

function buildCanonicalCells(input: AffectedCellsInput): CanonicalCell[] {
    return input.affected_cells.map((cell) => {
        const decimal = cell.h3_index;
        const hex = h3DecimalToHex(decimal);
        const boundary = cellToBoundary(hex).map(([lat, lng]) => ({ lat, lng }));
        const { bounds, tileBounds } = cellBoundaryBounds(boundary);
        return {
            decimal,
            hex,
            band: toCellBand(cell.cell_band),
            boundary,
            bounds,
            tileBounds,
        };
    });
}

function computeAffectedCellsBounds(cells: readonly CanonicalCell[]): AffectedAreaBounds {
    if (cells.length === 0) {
        throw new Error("affected cells must not be empty");
    }

    const latBounds = cells.reduce(
        (acc, cell) => ({
            north: Math.max(acc.north, cell.bounds.north),
            south: Math.min(acc.south, cell.bounds.south),
        }),
        { north: -90, south: 90 },
    );
    const lngBounds = minimalLongitudeSpan(
        cells.flatMap((cell) => cell.boundary.map((point) => point.lng)),
    );

    return {
        north: round(latBounds.north, BOUNDS_DECIMAL_PLACES),
        south: round(latBounds.south, BOUNDS_DECIMAL_PLACES),
        east: round(lngBounds.east, BOUNDS_DECIMAL_PLACES),
        west: round(lngBounds.west, BOUNDS_DECIMAL_PLACES),
    };
}

function minimalLongitudeSpan(lngs: readonly number[]): { readonly west: number; readonly east: number } {
    if (lngs.length === 0) {
        throw new Error("cell boundary must not be empty");
    }
    const sorted = [...lngs].sort((a, b) => a - b);
    const first = sorted[0];
    if (first === undefined) {
        throw new Error("cell boundary longitude is missing");
    }
    let largestGap = -1;
    let westIndex = 0;

    for (let i = 0; i < sorted.length; i += 1) {
        const current = sorted[i];
        const next = i === sorted.length - 1 ? first + 360 : sorted[i + 1];
        if (current === undefined || next === undefined) {
            throw new Error("cell boundary longitude is missing");
        }
        const gap = next - current;
        if (gap > largestGap) {
            largestGap = gap;
            westIndex = (i + 1) % sorted.length;
        }
    }

    const west = sorted[westIndex];
    const eastRaw = sorted[(westIndex + sorted.length - 1) % sorted.length];
    if (west === undefined || eastRaw === undefined) {
        throw new Error("cell boundary longitude is missing");
    }

    return { west, east: eastRaw < west ? eastRaw + 360 : eastRaw };
}

function splitLongitudeBounds(bounds: AffectedAreaBounds): readonly AffectedAreaBounds[] {
    if (bounds.east <= 180) {
        return [bounds];
    }
    return [
        { ...bounds, east: 180 },
        { ...bounds, west: -180, east: bounds.east - 360 },
    ];
}

function cellBoundaryBounds(boundary: readonly AffectedAreaLatLng[]): {
    readonly bounds: AffectedAreaBounds;
    readonly tileBounds: readonly AffectedAreaBounds[];
} {
    let latBounds: Pick<AffectedAreaBounds, "north" | "south"> | null = null;
    const lngs: number[] = [];
    for (const { lat, lng } of boundary) {
        lngs.push(lng);
        if (latBounds === null) {
            latBounds = { north: lat, south: lat };
            continue;
        }
        latBounds = {
            north: Math.max(latBounds.north, lat),
            south: Math.min(latBounds.south, lat),
        };
    }
    if (latBounds === null) {
        throw new Error("cell boundary must not be empty");
    }
    const lngBounds = minimalLongitudeSpan(lngs);
    const bounds = {
        north: latBounds.north,
        south: latBounds.south,
        east: lngBounds.east,
        west: lngBounds.west,
    };
    return { bounds, tileBounds: splitLongitudeBounds(bounds) };
}

function boundsIntersect(a: AffectedAreaBounds, b: AffectedAreaBounds): boolean {
    return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

function clampLatitude(lat: number): number {
    return Math.max(-85.05112878, Math.min(85.05112878, lat));
}

function lngToTileX(lng: number, zoom: number): number {
    const scale = 2 ** zoom;
    return Math.floor(((lng + 180) / 360) * scale);
}

function latToTileY(lat: number, zoom: number): number {
    const clamped = clampLatitude(lat);
    const latRad = (clamped * Math.PI) / 180;
    const scale = 2 ** zoom;
    return Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale,
    );
}

function latLngToWorldPixel(
    lat: number,
    lng: number,
    zoom: number,
    tileSize = TILE_SIZE,
): { readonly x: number; readonly y: number } {
    const clamped = clampLatitude(lat);
    const sin = Math.sin((clamped * Math.PI) / 180);
    const scale = tileSize * 2 ** zoom;
    return {
        x: ((lng + 180) / 360) * scale,
        y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
    };
}

function tileCenterLng(tile: TileCoord): number {
    const scale = 2 ** tile.z;
    return (((tile.x + 0.5) / scale) * 360) - 180;
}

function lngClosestToReference(lng: number, reference: number): number {
    const candidates = [lng - 360, lng, lng + 360];
    return candidates.reduce((best, candidate) =>
        Math.abs(candidate - reference) < Math.abs(best - reference) ? candidate : best,
    );
}

function tileBounds(coord: TileCoord): AffectedAreaBounds {
    const scale = 2 ** coord.z;
    const west = (coord.x / scale) * 360 - 180;
    const east = ((coord.x + 1) / scale) * 360 - 180;
    const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * coord.y) / scale)));
    const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (coord.y + 1)) / scale)));
    return {
        north: (northRad * 180) / Math.PI,
        south: (southRad * 180) / Math.PI,
        east,
        west,
    };
}

function tileRangeForBounds(bounds: AffectedAreaBounds, zoom: number): readonly TileCoord[] {
    const scale = 2 ** zoom;
    const minX = Math.max(0, Math.min(scale - 1, lngToTileX(bounds.west, zoom)));
    const maxX = Math.max(0, Math.min(scale - 1, lngToTileX(bounds.east, zoom)));
    const minY = Math.max(0, Math.min(scale - 1, latToTileY(bounds.north, zoom)));
    const maxY = Math.max(0, Math.min(scale - 1, latToTileY(bounds.south, zoom)));

    const result: TileCoord[] = [];
    for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
            result.push({ z: zoom, x, y });
        }
    }
    return result;
}

function tileKey(coord: TileCoord): string {
    return `${coord.z}/${coord.x}/${coord.y}`;
}

function buildSvgPath(cell: CanonicalCell, tile: TileCoord): string {
    const originX = tile.x * TILE_SIZE;
    const originY = tile.y * TILE_SIZE;
    const referenceLng = tileCenterLng(tile);
    const [first, ...rest] = cell.boundary.map((point) => {
        const projected = latLngToWorldPixel(
            point.lat,
            lngClosestToReference(point.lng, referenceLng),
            tile.z,
            TILE_SIZE,
        );
        return {
            x: projected.x - originX,
            y: projected.y - originY,
        };
    });

    if (first === undefined) {
        throw new Error(`cell ${cell.decimal} has no boundary points`);
    }

    return [
        `M${formatSvgNumber(first.x)} ${formatSvgNumber(first.y)}`,
        ...rest.map((point) => `L${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`),
        "Z",
    ].join("");
}

function buildRasterSvg(paths: readonly ProjectedCellPath[]): string {
    const byBand: Record<CellBand, string[]> = {
        1: [],
        2: [],
        3: [],
    };
    for (const cellPath of paths) {
        byBand[cellPath.band].push(cellPath.path);
    }

    const pathElements = ([1, 2, 3] as const)
        .filter((band) => byBand[band].length > 0)
        .map(
            (band) =>
                `<path data-band="${band}" fill="${BAND_COLOR[band]}" fill-opacity="${RASTER_FILL_OPACITY}" d="${byBand[band].join("")}"/>`,
        )
        .join("");

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_SIZE}" height="${TILE_SIZE}" viewBox="0 0 ${TILE_SIZE} ${TILE_SIZE}">`,
        pathElements,
        "</svg>\n",
    ].join("");
}

function featureFromCell(cell: CanonicalCell): AffectedCellTileFeature {
    return {
        decimal: cell.decimal,
        hex: cell.hex,
        band: cell.band,
        boundary: cell.boundary,
        bounds: cell.bounds,
    };
}

export function generateAffectedAreaArtifacts(
    params: GenerateAffectedAreaArtifactsParams,
): GeneratedAffectedAreaArtifacts {
    const baseUrl = normalizeAffectedAreaBaseUrl(params.baseUrl);
    if (baseUrl === null) {
        throw new Error("baseUrl is required");
    }

    const input = parseCanonicalSource(params.bytes);
    const computedRoot = affectedCellsRoot(input);
    if (computedRoot !== params.affectedCellsRoot) {
        throw new Error(
            `affected_cells_root mismatch: computed=${computedRoot}, expected=${params.affectedCellsRoot}`,
        );
    }

    const canonicalCells = buildCanonicalCells(input);
    const affectedCellsJson = canonicalAffectedCellsJson(input);
    const sourceSha256 = sha256Hex(new TextEncoder().encode(affectedCellsJson)).slice(2);
    const bounds = computeAffectedCellsBounds(canonicalCells);
    const rasterTilePaths = new Map<string, ProjectedCellPath[]>();
    const cellTileFeatures = new Map<string, AffectedCellTileFeature[]>();

    for (const cell of canonicalCells) {
        for (let zoom = MIN_RASTER_ZOOM; zoom <= MAX_RASTER_ZOOM; zoom += 1) {
            for (const boundsPart of cell.tileBounds) {
                for (const tile of tileRangeForBounds(boundsPart, zoom)) {
                    if (!boundsIntersect(boundsPart, tileBounds(tile))) {
                        continue;
                    }
                    const key = tileKey(tile);
                    const paths = rasterTilePaths.get(key) ?? [];
                    paths.push({ band: cell.band, path: buildSvgPath(cell, tile) });
                    rasterTilePaths.set(key, paths);
                }
            }
        }

        for (const boundsPart of cell.tileBounds) {
            for (const tile of tileRangeForBounds(boundsPart, CELL_TILE_ZOOM)) {
                if (!boundsIntersect(boundsPart, tileBounds(tile))) {
                    continue;
                }
                const key = tileKey(tile);
                const features = cellTileFeatures.get(key) ?? [];
                features.push(featureFromCell(cell));
                cellTileFeatures.set(key, features);
            }
        }
    }

    const rasterTiles = new Map<string, string>();
    for (const [key, paths] of [...rasterTilePaths.entries()].sort(([a], [b]) =>
        sortTileKeys(a, b),
    )) {
        rasterTiles.set(key, buildRasterSvg(paths));
    }

    const cellTiles = new Map<string, string>();
    for (const [key, features] of [...cellTileFeatures.entries()].sort(([a], [b]) =>
        sortTileKeys(a, b),
    )) {
        const [z, x, y] = parseTileKeyParts(key);
        cellTiles.set(key, JSON.stringify({ z, x, y, features }));
    }

    const manifest: AffectedAreaTileManifest = {
        kind: "tiled-affected-cells",
        eventUid: input.event_uid,
        affectedCellsRoot: params.affectedCellsRoot,
        sourceSha256,
        h3Resolution: 7,
        cellCount: input.affected_cells.length,
        bounds,
        styleVersion: STYLE_VERSION,
        minRasterZoom: MIN_RASTER_ZOOM,
        maxRasterZoom: MAX_RASTER_ZOOM,
        minCellZoom: MIN_CELL_ZOOM,
        cellTileZoom: CELL_TILE_ZOOM,
        tileSize: TILE_SIZE,
        rasterTileUrlTemplate: affectedAreaTileUrlTemplate(baseUrl, input, "raster"),
        cellTileUrlTemplate: affectedAreaTileUrlTemplate(baseUrl, input, "cells"),
        rasterTileKeys: [...rasterTiles.keys()],
        cellTileKeys: [...cellTiles.keys()],
    };

    return { affectedCellsJson, manifest, rasterTiles, cellTiles };
}
