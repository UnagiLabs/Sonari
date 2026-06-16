/**
 * Generates the Tohoku 2011 demo affected-area artifacts from the canonical
 * verifier fixture.
 *
 * Canonical source:
 *   nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/affected_cells.json
 *
 * Outputs:
 *   dapp/public/demo/tohoku-2011/affected-cells.json
 *   dapp/public/demo/tohoku-2011/affected-area-manifest.json
 *   dapp/public/demo/tohoku-2011/raster/{z}/{x}/{y}.svg
 *   dapp/public/demo/tohoku-2011/cells/{z}/{x}/{y}.json
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    type AffectedAreaTileManifest,
    type AffectedCellTileFeature,
    boundsIntersect,
    cellBoundaryBounds,
    latLngToWorldPixel,
    type TileCoord,
    tileBounds,
    tileKey,
    tileRangeForBounds,
} from "../dapp/app/claim/affected-area/affected-area-tiles.js";
import { bandColor, type CellBand } from "../dapp/app/claim/catalog/cell-band-rules.js";
import type { LatLng } from "../dapp/app/register/residence/h3-geo.js";

const require = createRequire(import.meta.url);
const { cellToBoundary } = require("../dapp/node_modules/h3-js/dist/h3-js.js") as {
    readonly cellToBoundary: (h3Index: string) => [number, number][];
};

const H3_INDEX_PATTERN = /^(0|[1-9]\d*)$/u;
const VALID_BANDS = new Set([1, 2, 3]);
const BOUNDS_DECIMAL_PLACES = 6;
const SVG_COORDINATE_DECIMAL_PLACES = 2;
const RASTER_FILL_OPACITY = 0.35;
const STYLE_VERSION = 1;
const TILE_SIZE = 256;
const MIN_RASTER_ZOOM = 6;
const MAX_RASTER_ZOOM = 10;
const MIN_CELL_ZOOM = 11;
const CELL_TILE_ZOOM = 11;

const EVENT_UID = "0x552d0b5280b31910b6ff306632e05e9f2c0b4e9176d8ddba77d20a5e22d7a622";
const AFFECTED_CELLS_ROOT = "0x51cd4a4ddc99acbad52b6e5b0003827f9a5b27501f3fc902c8e025a1a92a59ee";

export interface GeneratedAffectedAreaArtifacts {
    readonly affectedCellsJson: string;
    readonly manifest: AffectedAreaTileManifest;
    readonly rasterTiles: ReadonlyMap<string, string>;
    readonly cellTiles: ReadonlyMap<string, string>;
}

interface CanonicalCell {
    readonly decimal: string;
    readonly hex: string;
    readonly band: CellBand;
    readonly boundary: readonly LatLng[];
    readonly bounds: {
        readonly north: number;
        readonly south: number;
        readonly east: number;
        readonly west: number;
    };
}

interface ProjectedCellPath {
    readonly band: CellBand;
    readonly path: string;
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
    const [z, x, y] = parts.map(Number);
    if (z === undefined || x === undefined || y === undefined) {
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

/**
 * Extracts [h3_index, cell_band] tuples from the raw fixture input.
 *
 * Validates every element fail-closed: any malformed entry throws rather than
 * being silently skipped. Input order is preserved (deterministic output).
 */
export function extractAffectedCells(input: unknown): [string, number][] {
    if (typeof input !== "object" || input === null) {
        throw new Error("input must be a non-null object");
    }

    const record = input as Record<string, unknown>;

    if (!("affected_cells" in record)) {
        throw new Error("input is missing required field: affected_cells");
    }

    const raw = record.affected_cells;
    if (!Array.isArray(raw)) {
        throw new Error(`affected_cells must be an array, got ${typeof raw}`);
    }

    const result: [string, number][] = [];

    for (let i = 0; i < raw.length; i += 1) {
        const element = raw[i];

        if (typeof element !== "object" || element === null) {
            throw new Error(`affected_cells[${i}]: expected object, got ${typeof element}`);
        }

        const cell = element as Record<string, unknown>;

        const h3Index = cell.h3_index;
        if (typeof h3Index !== "string") {
            throw new Error(
                `affected_cells[${i}].h3_index must be a string, got ${typeof h3Index}`,
            );
        }
        if (!H3_INDEX_PATTERN.test(h3Index)) {
            throw new Error(
                `affected_cells[${i}].h3_index is not a valid non-negative decimal integer string: ${JSON.stringify(h3Index)}`,
            );
        }

        const cellBand = cell.cell_band;
        if (typeof cellBand !== "number") {
            throw new Error(
                `affected_cells[${i}].cell_band must be a number, got ${typeof cellBand}`,
            );
        }
        if (!Number.isInteger(cellBand)) {
            throw new Error(`affected_cells[${i}].cell_band must be an integer, got ${cellBand}`);
        }
        if (!VALID_BANDS.has(cellBand)) {
            throw new Error(`affected_cells[${i}].cell_band must be 1, 2, or 3, got ${cellBand}`);
        }

        result.push([h3Index, cellBand]);
    }

    return result;
}

function buildCanonicalCells(cells: readonly [string, number][]): CanonicalCell[] {
    return cells.map(([decimal, band]) => {
        const hex = h3DecimalToHex(decimal);
        const boundary = cellToBoundary(hex).map(([lat, lng]) => ({ lat, lng }));
        const bounds = cellBoundaryBounds(boundary);
        return {
            decimal,
            hex,
            band: band as CellBand,
            boundary,
            bounds,
        };
    });
}

export function computeAffectedCellsBounds(cells: readonly [string, number][]) {
    const canonicalCells = buildCanonicalCells(cells);
    if (canonicalCells.length === 0) {
        throw new Error("affected cells must not be empty");
    }

    const bounds = canonicalCells.reduce(
        (acc, cell) => ({
            north: Math.max(acc.north, cell.bounds.north),
            south: Math.min(acc.south, cell.bounds.south),
            east: Math.max(acc.east, cell.bounds.east),
            west: Math.min(acc.west, cell.bounds.west),
        }),
        { north: -90, south: 90, east: -180, west: 180 },
    );

    return {
        north: round(bounds.north, BOUNDS_DECIMAL_PLACES),
        south: round(bounds.south, BOUNDS_DECIMAL_PLACES),
        east: round(bounds.east, BOUNDS_DECIMAL_PLACES),
        west: round(bounds.west, BOUNDS_DECIMAL_PLACES),
    };
}

function buildSvgPath(cell: CanonicalCell, tile: TileCoord): string {
    const originX = tile.x * TILE_SIZE;
    const originY = tile.y * TILE_SIZE;
    const [first, ...rest] = cell.boundary.map((point) => {
        const projected = latLngToWorldPixel(point.lat, point.lng, tile.z, TILE_SIZE);
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
                `<path data-band="${band}" fill="${bandColor(band)}" fill-opacity="${RASTER_FILL_OPACITY}" d="${byBand[band].join("")}"/>`,
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
    cells: readonly [string, number][],
): GeneratedAffectedAreaArtifacts {
    const canonicalCells = buildCanonicalCells(cells);
    const affectedCellsJson = JSON.stringify(cells);
    const sourceSha256 = createHash("sha256").update(affectedCellsJson).digest("hex");
    const bounds = computeAffectedCellsBounds(cells);
    const rasterTilePaths = new Map<string, ProjectedCellPath[]>();
    const cellTileFeatures = new Map<string, AffectedCellTileFeature[]>();

    for (const cell of canonicalCells) {
        for (let zoom = MIN_RASTER_ZOOM; zoom <= MAX_RASTER_ZOOM; zoom += 1) {
            for (const tile of tileRangeForBounds(cell.bounds, zoom)) {
                if (!boundsIntersect(cell.bounds, tileBounds(tile))) {
                    continue;
                }
                const key = tileKey(tile);
                const paths = rasterTilePaths.get(key) ?? [];
                paths.push({ band: cell.band, path: buildSvgPath(cell, tile) });
                rasterTilePaths.set(key, paths);
            }
        }

        for (const tile of tileRangeForBounds(cell.bounds, CELL_TILE_ZOOM)) {
            if (!boundsIntersect(cell.bounds, tileBounds(tile))) {
                continue;
            }
            const key = tileKey(tile);
            const features = cellTileFeatures.get(key) ?? [];
            features.push(featureFromCell(cell));
            cellTileFeatures.set(key, features);
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
        const [z, x, y] = key.split("/").map(Number);
        cellTiles.set(key, JSON.stringify({ z, x, y, features }));
    }

    const manifest: AffectedAreaTileManifest = {
        kind: "tiled-affected-cells",
        eventUid: EVENT_UID,
        affectedCellsRoot: AFFECTED_CELLS_ROOT,
        sourceSha256,
        h3Resolution: 7,
        cellCount: cells.length,
        bounds,
        styleVersion: STYLE_VERSION,
        minRasterZoom: MIN_RASTER_ZOOM,
        maxRasterZoom: MAX_RASTER_ZOOM,
        minCellZoom: MIN_CELL_ZOOM,
        cellTileZoom: CELL_TILE_ZOOM,
        tileSize: TILE_SIZE,
        rasterTileUrlTemplate: "/demo/tohoku-2011/raster/{z}/{x}/{y}.svg",
        cellTileUrlTemplate: "/demo/tohoku-2011/cells/{z}/{x}/{y}.json",
        rasterTileKeys: [...rasterTiles.keys()],
        cellTileKeys: [...cellTiles.keys()],
    };

    return { affectedCellsJson, manifest, rasterTiles, cellTiles };
}

const INPUT_PATH = path.join(
    process.cwd(),
    "nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/affected_cells.json",
);
const OUTPUT_DIR = path.join(process.cwd(), "dapp/public/demo/tohoku-2011");

async function writeTileFiles(
    baseDir: string,
    directory: "raster" | "cells",
    tiles: ReadonlyMap<string, string>,
): Promise<void> {
    for (const [key, content] of tiles) {
        const outputPath = path.join(baseDir, ...tileOutputRelativePath(directory, key));
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, "utf8");
    }
}

async function main(): Promise<void> {
    console.log(`Reading fixture: ${INPUT_PATH}`);
    const raw = await readFile(INPUT_PATH, "utf8");
    const input: unknown = JSON.parse(raw);

    const cells = extractAffectedCells(input);
    console.log(`Extracted ${cells.length} cells`);

    const artifacts = generateAffectedAreaArtifacts(cells);

    await rm(OUTPUT_DIR, { recursive: true, force: true });
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(
        path.join(OUTPUT_DIR, "affected-cells.json"),
        artifacts.affectedCellsJson,
        "utf8",
    );
    await writeFile(
        path.join(OUTPUT_DIR, "affected-area-manifest.json"),
        JSON.stringify(artifacts.manifest),
        "utf8",
    );
    await writeTileFiles(OUTPUT_DIR, "raster", artifacts.rasterTiles);
    await writeTileFiles(OUTPUT_DIR, "cells", artifacts.cellTiles);

    console.log(`Written: ${OUTPUT_DIR}`);
    console.log(`Raster tiles: ${artifacts.rasterTiles.size}`);
    console.log(`Cell tiles: ${artifacts.cellTiles.size}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    await main();
}
