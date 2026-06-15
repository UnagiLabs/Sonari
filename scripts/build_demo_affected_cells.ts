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
import path from "node:path";
import { pathToFileURL } from "node:url";

const H3_INDEX_PATTERN = /^(0|[1-9]\d*)$/u;
const VALID_BANDS = new Set([1, 2, 3]);

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

const INPUT_PATH = path.join(
    process.cwd(),
    "nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/affected_cells.json",
);
const OUTPUT_PATH = path.join(process.cwd(), "dapp/public/demo/tohoku-2011-affected-cells.json");

async function main(): Promise<void> {
    console.log(`Reading fixture: ${INPUT_PATH}`);
    const raw = await readFile(INPUT_PATH, "utf8");
    const input: unknown = JSON.parse(raw);

    const cells = extractAffectedCells(input);
    console.log(`Extracted ${cells.length} cells`);

    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, JSON.stringify(cells), "utf8");
    console.log(`Written: ${OUTPUT_PATH}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    await main();
}
