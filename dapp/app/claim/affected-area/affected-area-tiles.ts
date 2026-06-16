import { parseH3Index } from "@sonari/proof-core";
import { type CellBand, parseCellBand } from "../catalog/cell-band-rules";
import {
    RESIDENCE_H3_RESOLUTION,
    h3DecimalToHex,
    type LatLng,
    type ViewportBounds,
} from "../../register/residence/h3-geo";
import type { AffectedCell } from "./affected-cells";

export interface AffectedAreaTileManifest {
    readonly kind: "tiled-affected-cells";
    readonly eventUid: string;
    readonly affectedCellsRoot: string;
    readonly sourceSha256: string;
    readonly h3Resolution: 7;
    readonly cellCount: number;
    readonly bounds: ViewportBounds;
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

export interface AffectedCellTileFeature extends AffectedCell {
    readonly boundary: readonly LatLng[];
    readonly bounds: ViewportBounds;
}

export interface AffectedCellTile {
    readonly z: number;
    readonly x: number;
    readonly y: number;
    readonly features: readonly AffectedCellTileFeature[];
}

export interface TileCoord {
    readonly z: number;
    readonly x: number;
    readonly y: number;
}

export type AffectedAreaLayerMode = "raster" | "cells";

export const TRANSPARENT_TILE_DATA_URI =
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22256%22%20height%3D%22256%22%20viewBox%3D%220%200%20256%20256%22/%3E";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseFiniteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseNonNegativeInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parsePositiveInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function parseNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseStringArray(value: unknown): readonly string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const result: string[] = [];
    for (const item of value) {
        if (typeof item !== "string" || item.length === 0) {
            return null;
        }
        result.push(item);
    }
    return result;
}

function parseBounds(value: unknown): ViewportBounds | null {
    if (!isRecord(value)) {
        return null;
    }
    const north = parseFiniteNumber(value["north"]);
    const south = parseFiniteNumber(value["south"]);
    const east = parseFiniteNumber(value["east"]);
    const west = parseFiniteNumber(value["west"]);
    if (north === null || south === null || east === null || west === null) {
        return null;
    }
    if (north < south || east < west) {
        return null;
    }
    return { north, south, east, west };
}

export function parseAffectedAreaTileManifest(input: unknown): AffectedAreaTileManifest | null {
    if (!isRecord(input) || input["kind"] !== "tiled-affected-cells") {
        return null;
    }

    const eventUid = parseNonEmptyString(input["eventUid"]);
    const affectedCellsRoot = parseNonEmptyString(input["affectedCellsRoot"]);
    const sourceSha256 = parseNonEmptyString(input["sourceSha256"]);
    const h3Resolution = parseNonNegativeInteger(input["h3Resolution"]);
    const cellCount = parseNonNegativeInteger(input["cellCount"]);
    const bounds = parseBounds(input["bounds"]);
    const styleVersion = parsePositiveInteger(input["styleVersion"]);
    const minRasterZoom = parseNonNegativeInteger(input["minRasterZoom"]);
    const maxRasterZoom = parseNonNegativeInteger(input["maxRasterZoom"]);
    const minCellZoom = parseNonNegativeInteger(input["minCellZoom"]);
    const cellTileZoom = parseNonNegativeInteger(input["cellTileZoom"]);
    const tileSize = parsePositiveInteger(input["tileSize"]);
    const rasterTileUrlTemplate = parseNonEmptyString(input["rasterTileUrlTemplate"]);
    const cellTileUrlTemplate = parseNonEmptyString(input["cellTileUrlTemplate"]);
    const rasterTileKeys = parseStringArray(input["rasterTileKeys"]);
    const cellTileKeys = parseStringArray(input["cellTileKeys"]);

    if (
        eventUid === null ||
        affectedCellsRoot === null ||
        sourceSha256 === null ||
        h3Resolution !== RESIDENCE_H3_RESOLUTION ||
        cellCount === null ||
        bounds === null ||
        styleVersion === null ||
        minRasterZoom === null ||
        maxRasterZoom === null ||
        minCellZoom === null ||
        cellTileZoom === null ||
        tileSize !== 256 ||
        rasterTileUrlTemplate === null ||
        cellTileUrlTemplate === null ||
        rasterTileKeys === null ||
        cellTileKeys === null
    ) {
        return null;
    }
    if (!SHA256_HEX_PATTERN.test(sourceSha256) || minRasterZoom > maxRasterZoom) {
        return null;
    }
    if (!rasterTileUrlTemplate.includes("{z}") || !rasterTileUrlTemplate.includes("{x}") || !rasterTileUrlTemplate.includes("{y}")) {
        return null;
    }
    if (!cellTileUrlTemplate.includes("{z}") || !cellTileUrlTemplate.includes("{x}") || !cellTileUrlTemplate.includes("{y}")) {
        return null;
    }

    return {
        kind: "tiled-affected-cells",
        eventUid,
        affectedCellsRoot,
        sourceSha256,
        h3Resolution,
        cellCount,
        bounds,
        styleVersion,
        minRasterZoom,
        maxRasterZoom,
        minCellZoom,
        cellTileZoom,
        tileSize,
        rasterTileUrlTemplate,
        cellTileUrlTemplate,
        rasterTileKeys,
        cellTileKeys,
    };
}

export function tileKey(coord: TileCoord): string {
    return `${coord.z}/${coord.x}/${coord.y}`;
}

export function tileUrlFromTemplate(template: string, coord: TileCoord): string {
    return template
        .replaceAll("{z}", String(coord.z))
        .replaceAll("{x}", String(coord.x))
        .replaceAll("{y}", String(coord.y));
}

export function rasterTileUrlForManifest(
    manifest: AffectedAreaTileManifest,
    coord: TileCoord,
): string {
    if (!new Set(manifest.rasterTileKeys).has(tileKey(coord))) {
        return TRANSPARENT_TILE_DATA_URI;
    }
    return tileUrlFromTemplate(manifest.rasterTileUrlTemplate, coord);
}

function clampLatitude(lat: number): number {
    return Math.max(-85.05112878, Math.min(85.05112878, lat));
}

export function lngToTileX(lng: number, zoom: number): number {
    const scale = 2 ** zoom;
    return Math.floor(((lng + 180) / 360) * scale);
}

export function latToTileY(lat: number, zoom: number): number {
    const clamped = clampLatitude(lat);
    const latRad = (clamped * Math.PI) / 180;
    const scale = 2 ** zoom;
    return Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale,
    );
}

export function latLngToWorldPixel(lat: number, lng: number, zoom: number, tileSize = 256): {
    readonly x: number;
    readonly y: number;
} {
    const clamped = clampLatitude(lat);
    const sin = Math.sin((clamped * Math.PI) / 180);
    const scale = tileSize * 2 ** zoom;
    return {
        x: ((lng + 180) / 360) * scale,
        y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
    };
}

export function tileBounds(coord: TileCoord): ViewportBounds {
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

export function tileRangeForBounds(bounds: ViewportBounds, zoom: number): readonly TileCoord[] {
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

export function cellBoundaryBounds(boundary: readonly LatLng[]): ViewportBounds {
    let bounds: ViewportBounds | null = null;
    for (const { lat, lng } of boundary) {
        if (bounds === null) {
            bounds = { north: lat, south: lat, east: lng, west: lng };
            continue;
        }
        bounds = {
            north: Math.max(bounds.north, lat),
            south: Math.min(bounds.south, lat),
            east: Math.max(bounds.east, lng),
            west: Math.min(bounds.west, lng),
        };
    }
    if (bounds === null) {
        throw new Error("cell boundary must not be empty");
    }
    return bounds;
}

export function boundsIntersect(a: ViewportBounds, b: ViewportBounds): boolean {
    return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

export function cellTileKeysForViewport(
    manifest: AffectedAreaTileManifest,
    bounds: ViewportBounds,
): readonly string[] {
    const existing = new Set(manifest.cellTileKeys);
    return tileRangeForBounds(bounds, manifest.cellTileZoom)
        .map(tileKey)
        .filter((key) => existing.has(key));
}

export function selectAffectedAreaLayerModeForZoom(
    zoom: number,
    manifest: Pick<AffectedAreaTileManifest, "minCellZoom">,
): AffectedAreaLayerMode {
    return zoom >= manifest.minCellZoom ? "cells" : "raster";
}

function parseLatLng(value: unknown): LatLng | null {
    if (!isRecord(value)) {
        return null;
    }
    const lat = parseFiniteNumber(value["lat"]);
    const lng = parseFiniteNumber(value["lng"]);
    if (lat === null || lng === null) {
        return null;
    }
    return { lat, lng };
}

function parseTileFeature(value: unknown): AffectedCellTileFeature | null {
    if (!isRecord(value)) {
        return null;
    }
    const decimal = parseNonEmptyString(value["decimal"]);
    const hex = parseNonEmptyString(value["hex"]);
    const band = parseCellBand(value["band"]);
    const bounds = parseBounds(value["bounds"]);
    if (decimal === null || hex === null || band === null || bounds === null) {
        return null;
    }
    try {
        parseH3Index(decimal, RESIDENCE_H3_RESOLUTION);
    } catch {
        return null;
    }
    if (h3DecimalToHex(decimal) !== hex) {
        return null;
    }
    if (!Array.isArray(value["boundary"])) {
        return null;
    }
    const boundary: LatLng[] = [];
    for (const point of value["boundary"]) {
        const parsed = parseLatLng(point);
        if (parsed === null) {
            return null;
        }
        boundary.push(parsed);
    }
    if (boundary.length === 0) {
        return null;
    }
    return { decimal, hex, band, boundary, bounds };
}

export function parseAffectedCellTile(input: unknown): AffectedCellTile | null {
    if (!isRecord(input)) {
        return null;
    }
    const z = parseNonNegativeInteger(input["z"]);
    const x = parseNonNegativeInteger(input["x"]);
    const y = parseNonNegativeInteger(input["y"]);
    if (z === null || x === null || y === null || !Array.isArray(input["features"])) {
        return null;
    }

    const features: AffectedCellTileFeature[] = [];
    for (const feature of input["features"]) {
        const parsed = parseTileFeature(feature);
        if (parsed === null) {
            return null;
        }
        features.push(parsed);
    }

    return { z, x, y, features };
}

export function dedupeCellTileFeatures(
    features: readonly AffectedCellTileFeature[],
): AffectedCellTileFeature[] {
    const seen = new Set<string>();
    const result: AffectedCellTileFeature[] = [];
    for (const feature of features) {
        if (seen.has(feature.decimal)) {
            continue;
        }
        seen.add(feature.decimal);
        result.push(feature);
    }
    return result;
}

export function featureToAffectedCell(feature: AffectedCellTileFeature): AffectedCell {
    return {
        decimal: feature.decimal,
        hex: feature.hex,
        band: feature.band as CellBand,
    };
}
