import { describe, expect, it } from "vitest";
import {
    type AffectedCellEntry,
    type AffectedCellsInput,
    parseAffectedCellsFile,
} from "./affected-cells.js";
import { affectedCellsRoot, buildProofEntries } from "./index.js";
import { replayProof } from "./merkle.js";

// ---------------------------------------------------------------------------
// Synthetic large-scale input helper
// ---------------------------------------------------------------------------

/**
 * Generate a synthetic AffectedCellsInput with `count` cells.
 *
 * Constraints satisfied:
 * - h3_index: decimal string, no leading zeros, strictly ascending, no duplicates,
 *   within u64 range (base ~= 608819013513904127, stepping by 83968)
 * - geo_resolution: 7
 * - cell_band: cycles through 1, 2, 3
 * - intensity_value: 0..65535 (cycles using modulo)
 * - enum values: taken from affected-cell-leaf.ts and affected-cells.ts valid sets
 */
export function generateLargeScaleInput(count: number): AffectedCellsInput {
    if (count < 1) {
        throw new Error("count must be >= 1");
    }

    // Base h3 index: a real H3 resolution-7 cell index value
    // Use a known valid value from fixtures and step by a fixed interval
    const H3_BASE = 608819013513904127n;
    // Step large enough to ensure no collisions and stay ascending
    const H3_STEP = 83968n;
    // u64 max = 18446744073709551615n
    const U64_MAX = 18446744073709551615n;

    const affected_cells: AffectedCellEntry[] = [];
    for (let i = 0; i < count; i++) {
        const h3Value = H3_BASE + BigInt(i) * H3_STEP;
        if (h3Value > U64_MAX) {
            throw new Error(`h3_index overflow at index ${i}: ${h3Value}`);
        }
        affected_cells.push({
            h3_index: h3Value.toString(),
            intensity_value: (i * 17) % 65536,
            cell_band: ((i % 3) + 1) as 1 | 2 | 3,
        });
    }

    const raw = {
        event_uid: "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
        event_revision: 1,
        oracle_version: 1,
        geo_resolution: 7,
        cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
        cell_metric: "USGS_MMI",
        cell_aggregation: "GRID_POINT_P90",
        intensity_scale: "MMI_X100",
        affected_cells,
    };

    // Validate via parse to guarantee all constraints are satisfied
    return parseAffectedCellsFile(raw);
}

// ---------------------------------------------------------------------------
// Small-scale smoke: 8 cells – proof/root consistency
// ---------------------------------------------------------------------------

describe("large-scale regression – 8-cell smoke", () => {
    it("all 8 proofs replay to the same merkle root", () => {
        const input = generateLargeScaleInput(8);
        const root = affectedCellsRoot(input);
        const entries = buildProofEntries(input);

        expect(entries).toHaveLength(8);
        for (const entry of entries) {
            expect(replayProof(entry.leaf_hash, entry.proof)).toBe(root);
        }
    });
});

// ---------------------------------------------------------------------------
// Large-scale regression: 4000 cells
// ---------------------------------------------------------------------------

describe("large-scale regression – 4000 cells", () => {
    it("generateLargeScaleInput(4000) passes parseAffectedCellsFile validation", () => {
        // generateLargeScaleInput internally calls parseAffectedCellsFile; if it throws,
        // the test fails with a descriptive message.
        expect(() => generateLargeScaleInput(4000)).not.toThrow();
    });

    it("buildProofEntries completes for 4000 cells and returns correct count", () => {
        const input = generateLargeScaleInput(4000);
        const entries = buildProofEntries(input);
        expect(entries).toHaveLength(4000);
    });

    it("all 4000 cell proofs replay to the affectedCellsRoot (Merkle consistency)", () => {
        const input = generateLargeScaleInput(4000);

        const start = Date.now();
        const root = affectedCellsRoot(input);
        const entries = buildProofEntries(input);
        const elapsed = Date.now() - start;

        console.log(`[large-scale] 4000 cells: root+entries computed in ${elapsed}ms`);

        expect(entries).toHaveLength(4000);
        for (const entry of entries) {
            const replayed = replayProof(entry.leaf_hash, entry.proof);
            expect(replayed).toBe(root);
        }
    });
});
