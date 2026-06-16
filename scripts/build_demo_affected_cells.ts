/**
 * build_demo_affected_cells.ts
 *
 * Generates dapp/public/demo/tohoku-2011-affected-cells.json from the real fixture.
 *
 * Source:
 *   nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/affected_cells.json
 *
 * Generation:
 *   Reads the full affected_cells array and strips each entry down to
 *   [h3_index, cell_band] tuples (dropping intensity_value and other fields).
 *   Output is a compact JSON array (no indentation) to keep file size small.
 *
 * Contract notes:
 *   - event_uid and affected_cells_root are NOT included in this asset.
 *     They are carried by the claim catalog (dapp/app/claim/catalog/) for
 *     display/passthrough only; verification happens at the contract layer,
 *     never here.
 *   - This asset is intended for lazy fetch by the map component (issue #383),
 *     so that large cell data is NOT statically imported into the JS bundle.
 *   - h3_index values are decimal u64 strings (not hex).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bandColor, type CellBand } from "../dapp/app/claim/catalog/cell-band-rules.js";

const require = createRequire(import.meta.url);
const { cellToBoundary } = require("../dapp/node_modules/h3-js/dist/h3-js.js") as {
    readonly cellToBoundary: (h3Index: string) => [number, number][];
};

const H3_INDEX_PATTERN = /^(0|[1-9]\d*)$/u;
const VALID_BANDS = new Set([1, 2, 3]);
const OVERLAY_WIDTH = 1600;
const COORDINATE_DECIMAL_PLACES = 2;
const BOUNDS_DECIMAL_PLACES = 6;
const BAND_FILL_OPACITY = 0.55;

export interface OverlayBounds {
    readonly north: number;
    readonly south: number;
    readonly east: number;
    readonly west: number;
}

interface ProjectedPoint {
    readonly x: number;
    readonly y: number;
}

function h3DecimalToHex(decimal: string): string {
    return BigInt(decimal).toString(16);
}

function round(value: number, decimalPlaces: number): number {
    const factor = 10 ** decimalPlaces;
    return Math.round(value * factor) / factor;
}

function formatSvgNumber(value: number): string {
    return round(value, COORDINATE_DECIMAL_PLACES).toFixed(COORDINATE_DECIMAL_PLACES);
}

function mercatorY(lat: number): number {
    const sin = Math.sin((lat * Math.PI) / 180);
    return Math.log((1 + sin) / (1 - sin)) / 2;
}

function degreesToRadians(value: number): number {
    return (value * Math.PI) / 180;
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

        // Validate h3_index
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

        // Validate cell_band
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

export function computeAffectedCellsBounds(cells: readonly [string, number][]): OverlayBounds {
    if (cells.length === 0) {
        throw new Error("affected cells must not be empty");
    }

    let north = -90;
    let south = 90;
    let east = -180;
    let west = 180;

    for (const [decimal] of cells) {
        const boundary = cellToBoundary(h3DecimalToHex(decimal));
        for (const [lat, lng] of boundary) {
            north = Math.max(north, lat);
            south = Math.min(south, lat);
            east = Math.max(east, lng);
            west = Math.min(west, lng);
        }
    }

    return {
        north: round(north, BOUNDS_DECIMAL_PLACES),
        south: round(south, BOUNDS_DECIMAL_PLACES),
        east: round(east, BOUNDS_DECIMAL_PLACES),
        west: round(west, BOUNDS_DECIMAL_PLACES),
    };
}

function projectPoint(
    lat: number,
    lng: number,
    bounds: OverlayBounds,
    height: number,
): ProjectedPoint {
    const northY = mercatorY(bounds.north);
    const southY = mercatorY(bounds.south);
    return {
        x: ((lng - bounds.west) / (bounds.east - bounds.west)) * OVERLAY_WIDTH,
        y: ((northY - mercatorY(lat)) / (northY - southY)) * height,
    };
}

function buildCellPath(decimal: string, bounds: OverlayBounds, height: number): string {
    const points = cellToBoundary(h3DecimalToHex(decimal)).map(([lat, lng]) =>
        projectPoint(lat, lng, bounds, height),
    );
    const [first, ...rest] = points;
    if (first === undefined) {
        throw new Error(`cell ${decimal} has no boundary points`);
    }

    const commands = [
        `M${formatSvgNumber(first.x)} ${formatSvgNumber(first.y)}`,
        ...rest.map((point) => `L${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`),
        "Z",
    ];
    return commands.join("");
}

export function generateBandOverlaySvg(cells: readonly [string, number][]): {
    readonly bounds: OverlayBounds;
    readonly svg: string;
} {
    const bounds = computeAffectedCellsBounds(cells);
    const height = Math.max(
        1,
        Math.round(
            OVERLAY_WIDTH *
                ((mercatorY(bounds.north) - mercatorY(bounds.south)) /
                    degreesToRadians(bounds.east - bounds.west)),
        ),
    );
    const paths: Record<CellBand, string[]> = {
        1: [],
        2: [],
        3: [],
    };

    for (const [decimal, band] of cells) {
        paths[band as CellBand].push(buildCellPath(decimal, bounds, height));
    }

    const pathElements = ([1, 2, 3] as const)
        .filter((band) => paths[band].length > 0)
        .map(
            (band) =>
                `<path data-band="${band}" fill="${bandColor(band)}" fill-opacity="${BAND_FILL_OPACITY}" d="${paths[band].join("")}"/>`,
        )
        .join("");

    return {
        bounds,
        svg: [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${OVERLAY_WIDTH}" height="${height}" viewBox="0 0 ${OVERLAY_WIDTH} ${height}">`,
            pathElements,
            "</svg>\n",
        ].join(""),
    };
}

const INPUT_PATH = path.join(
    process.cwd(),
    "nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/affected_cells.json",
);
const OUTPUT_PATH = path.join(process.cwd(), "dapp/public/demo/tohoku-2011-affected-cells.json");
const OVERLAY_OUTPUT_PATH = path.join(
    process.cwd(),
    "dapp/public/demo/tohoku-2011-band-overlay.svg",
);

async function main(): Promise<void> {
    console.log(`Reading fixture: ${INPUT_PATH}`);
    const raw = await readFile(INPUT_PATH, "utf8");
    const input: unknown = JSON.parse(raw);

    const cells = extractAffectedCells(input);
    console.log(`Extracted ${cells.length} cells`);

    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, JSON.stringify(cells), "utf8");
    console.log(`Written: ${OUTPUT_PATH}`);

    const overlay = generateBandOverlaySvg(cells);
    await writeFile(OVERLAY_OUTPUT_PATH, overlay.svg, "utf8");
    console.log(`Written: ${OVERLAY_OUTPUT_PATH}`);
    console.log(`Overlay bounds: ${JSON.stringify(overlay.bounds)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    await main();
}
