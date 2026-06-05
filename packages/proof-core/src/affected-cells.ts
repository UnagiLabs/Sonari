import {
    type AffectedCellLeaf,
    affectedCellLeafHash,
    CellMetric,
    CellsGenerationMethod,
    IntensityScale,
} from "./affected-cell-leaf.js";
import type { PrefixedHex32 } from "./bytes.js";
import {
    merkleLevelsFromLeafHashes,
    merkleRootFromLeafHashes,
    type ProofStep,
    proofStepsFromLevels,
} from "./merkle.js";
import {
    expectArray,
    expectKeys,
    expectNonNegativeSafeInteger,
    expectPositiveSafeInteger,
    expectPrefixedHex32,
    expectRecord,
    expectString,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AffectedCellEntry {
    h3_index: string;
    intensity_value: number;
    cell_band: number;
}

export interface AffectedCellsInput {
    event_uid: PrefixedHex32;
    event_revision: number;
    oracle_version: number;
    geo_resolution: number;
    cells_generation_method: string;
    cell_metric: string;
    cell_aggregation: string;
    intensity_scale: string;
    affected_cells: AffectedCellEntry[];
}

export type ProofDirection = "LEFT" | "RIGHT";

export interface DirectionalProofStep {
    direction: ProofDirection;
    sibling_hash: PrefixedHex32;
}

// ---------------------------------------------------------------------------
// Known enum values
// ---------------------------------------------------------------------------

const KNOWN_CELLS_GENERATION_METHODS: ReadonlySet<string> = new Set(
    Object.values(CellsGenerationMethod),
);
const KNOWN_CELL_METRICS: ReadonlySet<string> = new Set(Object.values(CellMetric));
const KNOWN_INTENSITY_SCALES: ReadonlySet<string> = new Set(Object.values(IntensityScale));
const KNOWN_CELL_AGGREGATIONS: ReadonlySet<string> = new Set(["GRID_POINT_P90"]);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const REQUIRED_TOP_LEVEL_KEYS = [
    "event_uid",
    "event_revision",
    "oracle_version",
    "geo_resolution",
    "cells_generation_method",
    "cell_metric",
    "cell_aggregation",
    "intensity_scale",
    "affected_cells",
] as const;

const REQUIRED_CELL_KEYS = ["h3_index", "intensity_value", "cell_band"] as const;

function validateH3IndexString(name: string, value: string): void {
    // Must be canonical decimal: no leading zeros (only "0" itself may start with "0")
    if (value !== "0" && value.startsWith("0")) {
        throw new Error(`${name} h3_index has leading zero: ${value}`);
    }
    // Must be a valid non-negative integer string
    if (!/^\d+$/.test(value)) {
        throw new Error(`${name} h3_index is not a valid decimal integer: ${value}`);
    }
}

// ---------------------------------------------------------------------------
// Internal helper: sort cells by numeric h3_index ascending
// ---------------------------------------------------------------------------

function sortCellsByH3Index(cells: AffectedCellEntry[]): AffectedCellEntry[] {
    return [...cells].sort((a, b) => {
        const ai = BigInt(a.h3_index);
        const bi = BigInt(b.h3_index);
        if (ai < bi) return -1;
        if (ai > bi) return 1;
        return 0;
    });
}

// ---------------------------------------------------------------------------
// parseAffectedCellsFile
// ---------------------------------------------------------------------------

export function parseAffectedCellsFile(value: unknown): AffectedCellsInput {
    const rec = expectRecord("affected_cells_file", value);
    expectKeys("affected_cells_file", rec, REQUIRED_TOP_LEVEL_KEYS as unknown as string[]);

    const event_uid = expectPrefixedHex32("event_uid", rec.event_uid);
    const event_revision = expectPositiveSafeInteger("event_revision", rec.event_revision);
    const oracle_version = expectPositiveSafeInteger("oracle_version", rec.oracle_version);

    // geo_resolution must be exactly 7
    const geo_resolution_raw = expectNonNegativeSafeInteger("geo_resolution", rec.geo_resolution);
    if (geo_resolution_raw !== 7) {
        throw new Error(`geo_resolution must be 7, got ${geo_resolution_raw}`);
    }

    // Enum string validations
    const cells_generation_method = expectString(
        "cells_generation_method",
        rec.cells_generation_method,
    );
    if (!KNOWN_CELLS_GENERATION_METHODS.has(cells_generation_method)) {
        throw new Error(`Unknown cells_generation_method: ${cells_generation_method}`);
    }

    const cell_metric = expectString("cell_metric", rec.cell_metric);
    if (!KNOWN_CELL_METRICS.has(cell_metric)) {
        throw new Error(`Unknown cell_metric: ${cell_metric}`);
    }

    const cell_aggregation = expectString("cell_aggregation", rec.cell_aggregation);
    if (!KNOWN_CELL_AGGREGATIONS.has(cell_aggregation)) {
        throw new Error(`Unknown cell_aggregation: ${cell_aggregation}`);
    }

    const intensity_scale = expectString("intensity_scale", rec.intensity_scale);
    if (!KNOWN_INTENSITY_SCALES.has(intensity_scale)) {
        throw new Error(`Unknown intensity_scale: ${intensity_scale}`);
    }

    // affected_cells: must be non-empty array
    const rawCells = expectArray("affected_cells", rec.affected_cells);
    if (rawCells.length === 0) {
        throw new Error("affected_cells must have at least 1 item");
    }

    // Validate each cell
    const affected_cells: AffectedCellEntry[] = rawCells.map((rawCell, idx) => {
        const cellRec = expectRecord(`affected_cells[${idx}]`, rawCell);
        expectKeys(`affected_cells[${idx}]`, cellRec, REQUIRED_CELL_KEYS as unknown as string[]);

        const h3_index = expectString(`affected_cells[${idx}].h3_index`, cellRec.h3_index);
        validateH3IndexString(`affected_cells[${idx}]`, h3_index);

        const intensity_value = expectNonNegativeSafeInteger(
            `affected_cells[${idx}].intensity_value`,
            cellRec.intensity_value,
        );

        const cell_band = expectNonNegativeSafeInteger(
            `affected_cells[${idx}].cell_band`,
            cellRec.cell_band,
        );
        if (cell_band < 1 || cell_band > 3) {
            throw new Error(
                `affected_cells[${idx}].cell_band must be in range 1..3, got ${cell_band}`,
            );
        }

        return { h3_index, intensity_value, cell_band };
    });

    // Verify numeric h3_index ascending order (fail-closed)
    const h3Values = affected_cells.map((c) => BigInt(c.h3_index));
    for (let i = 1; i < h3Values.length; i++) {
        const curr = h3Values[i];
        const prev = h3Values[i - 1];
        if (curr === undefined || prev === undefined) {
            throw new Error(`Unexpected undefined h3_index at index ${i}`);
        }
        if (curr <= prev) {
            if (curr === prev) {
                const cell = affected_cells[i];
                if (cell === undefined) {
                    throw new Error(`Unexpected undefined cell at index ${i}`);
                }
                throw new Error(`affected_cells contains duplicate h3_index: ${cell.h3_index}`);
            }
            throw new Error(
                `affected_cells is not sorted by numeric h3_index (index ${i - 1} >= index ${i})`,
            );
        }
    }

    // Check for duplicates (catches any remaining duplicates via Set size comparison)
    if (new Set(h3Values).size !== h3Values.length) {
        throw new Error("affected_cells contains duplicate h3_index values");
    }

    return {
        event_uid,
        event_revision,
        oracle_version,
        geo_resolution: geo_resolution_raw,
        cells_generation_method,
        cell_metric,
        cell_aggregation,
        intensity_scale,
        affected_cells,
    };
}

// ---------------------------------------------------------------------------
// affectedCellLeavesFromInput
// ---------------------------------------------------------------------------

export function affectedCellLeavesFromInput(input: AffectedCellsInput): AffectedCellLeaf[] {
    // Defensively sort by numeric h3_index (input should already be sorted after parseAffectedCellsFile)
    const sorted = sortCellsByH3Index(input.affected_cells);

    // Check for duplicates in the sorted list
    for (let i = 1; i < sorted.length; i++) {
        const curr = sorted[i];
        const prev = sorted[i - 1];
        if (curr === undefined || prev === undefined) {
            throw new Error(`Unexpected undefined cell at index ${i}`);
        }
        if (curr.h3_index === prev.h3_index) {
            throw new Error(`Duplicate h3_index detected in leaves: ${curr.h3_index}`);
        }
    }

    return sorted.map(
        (cell): AffectedCellLeaf => ({
            event_uid: input.event_uid,
            event_revision: input.event_revision,
            h3_index: BigInt(cell.h3_index),
            geo_resolution: input.geo_resolution,
            cell_metric: input.cell_metric as AffectedCellLeaf["cell_metric"],
            intensity_value: cell.intensity_value,
            intensity_scale: input.intensity_scale as AffectedCellLeaf["intensity_scale"],
            cell_band: cell.cell_band,
            cells_generation_method:
                input.cells_generation_method as AffectedCellLeaf["cells_generation_method"],
            oracle_version: BigInt(input.oracle_version),
        }),
    );
}

// ---------------------------------------------------------------------------
// affectedCellsLeafHashes
// ---------------------------------------------------------------------------

export async function affectedCellsLeafHashes(
    input: AffectedCellsInput,
): Promise<{ h3_index: string; leaf_hash: PrefixedHex32 }[]> {
    const leaves = affectedCellLeavesFromInput(input);
    const results: { h3_index: string; leaf_hash: PrefixedHex32 }[] = [];
    // Use original string from affected_cells (sorted order)
    const sortedCells = sortCellsByH3Index(input.affected_cells);
    for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i];
        const cell = sortedCells[i];
        if (leaf === undefined || cell === undefined) {
            throw new Error(`Unexpected undefined at index ${i}`);
        }
        const leaf_hash = await affectedCellLeafHash(leaf);
        results.push({ h3_index: cell.h3_index, leaf_hash });
    }
    return results;
}

// ---------------------------------------------------------------------------
// affectedCellsRoot
// ---------------------------------------------------------------------------

export async function affectedCellsRoot(input: AffectedCellsInput): Promise<PrefixedHex32> {
    const hashes = await affectedCellsLeafHashes(input);
    return merkleRootFromLeafHashes(hashes.map((h) => h.leaf_hash));
}

// ---------------------------------------------------------------------------
// affectedCellProofSteps
// ---------------------------------------------------------------------------

export async function affectedCellProofSteps(
    input: AffectedCellsInput,
    h3Index: string,
): Promise<ProofStep[]> {
    const sortedCells = sortCellsByH3Index(input.affected_cells);

    const leafIndex = sortedCells.findIndex((c) => c.h3_index === h3Index);
    if (leafIndex === -1) {
        throw new Error(`h3_index ${h3Index} not found in affected_cells`);
    }

    const hashes = await affectedCellsLeafHashes(input);
    const leafHashes = hashes.map((h) => h.leaf_hash);
    const levels = await merkleLevelsFromLeafHashes(leafHashes);
    return proofStepsFromLevels(levels, leafIndex);
}

// ---------------------------------------------------------------------------
// Proof direction conversion
// ---------------------------------------------------------------------------

export function proofStepToDirectional(step: ProofStep): DirectionalProofStep {
    return {
        direction: step.sibling_on_left ? "LEFT" : "RIGHT",
        sibling_hash: step.sibling_hash,
    };
}

export function directionalToProofStep(step: DirectionalProofStep): ProofStep {
    return {
        sibling_on_left: step.direction === "LEFT",
        sibling_hash: step.sibling_hash,
    };
}
