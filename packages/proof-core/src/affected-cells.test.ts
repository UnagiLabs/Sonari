import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    type AffectedCellsInput,
    affectedCellLeavesFromInput,
    affectedCellProofSteps,
    affectedCellsLeafHashes,
    affectedCellsRoot,
    type DirectionalProofStep,
    directionalToProofStep,
    parseAffectedCellsFile,
    proofStepToDirectional,
} from "./affected-cells.js";
import { replayProof } from "./merkle.js";

// ---------------------------------------------------------------------------
// Load fixtures
// ---------------------------------------------------------------------------

function loadJson(relPath: string): unknown {
    const url = new URL(relPath, import.meta.url);
    return JSON.parse(readFileSync(url, "utf-8"));
}

const affectedJson = loadJson("../../../schemas/examples/affected_cells.json");
const expectedHashes = loadJson("../../../schemas/examples/expected_hashes.json") as {
    affected_cells_root: string;
    leaf_hashes: { h3_index: string; leaf_hash: string }[];
};
const sampleProof = loadJson("../../../schemas/examples/sample_proof.json") as {
    target_leaf: { h3_index: string; leaf_hash: string };
    proof: { direction: string; sibling_hash: string }[];
    expected_root: string;
};

// ---------------------------------------------------------------------------
// parseAffectedCellsFile
// ---------------------------------------------------------------------------

describe("parseAffectedCellsFile", () => {
    it("parses valid affected_cells.json without throwing", () => {
        expect(() => parseAffectedCellsFile(affectedJson)).not.toThrow();
    });

    it("returns structured input with top-level fields", () => {
        const input = parseAffectedCellsFile(affectedJson);
        expect(input.event_uid).toBe(
            "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
        );
        expect(input.event_revision).toBe(1);
        expect(input.oracle_version).toBe(1);
        expect(input.geo_resolution).toBe(7);
        expect(input.cells_generation_method).toBe("shakemap_gridxml_h3_grid_point_p90_v1");
        expect(input.cell_metric).toBe("USGS_MMI");
        expect(input.cell_aggregation).toBe("GRID_POINT_P90");
        expect(input.intensity_scale).toBe("MMI_X100");
        expect(input.affected_cells).toHaveLength(2);
    });

    it("throws for missing event_uid", () => {
        const bad = { ...(affectedJson as object), event_uid: undefined };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for invalid event_uid (non-hex)", () => {
        const bad = { ...(affectedJson as object), event_uid: "not-a-hex" };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for non-positive event_revision", () => {
        const bad = { ...(affectedJson as object), event_revision: 0 };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for non-positive oracle_version", () => {
        const bad = { ...(affectedJson as object), oracle_version: 0 };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for geo_resolution !== 7", () => {
        const bad = { ...(affectedJson as object), geo_resolution: 8 };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for unknown cells_generation_method", () => {
        const bad = { ...(affectedJson as object), cells_generation_method: "unknown_method" };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for unknown cell_metric", () => {
        const bad = { ...(affectedJson as object), cell_metric: "UNKNOWN" };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for unknown intensity_scale", () => {
        const bad = { ...(affectedJson as object), intensity_scale: "UNKNOWN_SCALE" };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for empty affected_cells array", () => {
        const bad = { ...(affectedJson as object), affected_cells: [] };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for h3_index with leading zero (non-canonical)", () => {
        const input = affectedJson as AffectedCellsInput;
        const firstCell = input.affected_cells[0];
        if (firstCell === undefined) throw new Error("No cells in fixture");
        const badCells = [{ ...firstCell, h3_index: "0608819013513904127" }];
        const bad = { ...(affectedJson as object), affected_cells: badCells };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for duplicate h3_index values", () => {
        const input = affectedJson as AffectedCellsInput;
        const cell = input.affected_cells[0];
        if (cell === undefined) throw new Error("No cells in fixture");
        const bad = {
            ...(affectedJson as object),
            affected_cells: [cell, cell],
        };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for cells not in ascending numeric h3_index order (descending input)", () => {
        const input = affectedJson as AffectedCellsInput;
        const reversed = [...input.affected_cells].reverse();
        const bad = { ...(affectedJson as object), affected_cells: reversed };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for cell_band = 0 (out of range)", () => {
        const input = affectedJson as AffectedCellsInput;
        const firstCell = input.affected_cells[0];
        const secondCell = input.affected_cells[1];
        if (firstCell === undefined || secondCell === undefined)
            throw new Error("Not enough cells in fixture");
        const badCells = [{ ...firstCell, cell_band: 0 }, secondCell];
        const bad = { ...(affectedJson as object), affected_cells: badCells };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for cell_band = 4 (out of range)", () => {
        const input = affectedJson as AffectedCellsInput;
        const firstCell = input.affected_cells[0];
        const secondCell = input.affected_cells[1];
        if (firstCell === undefined || secondCell === undefined)
            throw new Error("Not enough cells in fixture");
        const badCells = [{ ...firstCell, cell_band: 4 }, secondCell];
        const bad = { ...(affectedJson as object), affected_cells: badCells };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for negative intensity_value", () => {
        const input = affectedJson as AffectedCellsInput;
        const firstCell = input.affected_cells[0];
        const secondCell = input.affected_cells[1];
        if (firstCell === undefined || secondCell === undefined)
            throw new Error("Not enough cells in fixture");
        const badCells = [{ ...firstCell, intensity_value: -1 }, secondCell];
        const bad = { ...(affectedJson as object), affected_cells: badCells };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });

    it("throws for intensity_value above u16 range", () => {
        const input = affectedJson as AffectedCellsInput;
        const firstCell = input.affected_cells[0];
        const secondCell = input.affected_cells[1];
        if (firstCell === undefined || secondCell === undefined)
            throw new Error("Not enough cells in fixture");
        const badCells = [{ ...firstCell, intensity_value: 65536 }, secondCell];
        const bad = { ...(affectedJson as object), affected_cells: badCells };
        expect(() => parseAffectedCellsFile(bad)).toThrow();
    });
});

// ---------------------------------------------------------------------------
// affectedCellLeavesFromInput
// ---------------------------------------------------------------------------

describe("affectedCellLeavesFromInput", () => {
    it("returns leaves in numeric h3_index ascending order", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const leaves = affectedCellLeavesFromInput(input);
        expect(leaves).toHaveLength(2);
        expect(leaves[0]?.h3_index).toBe(608819013513904127n);
        expect(leaves[1]?.h3_index).toBe(608819013597790207n);
    });
});

// ---------------------------------------------------------------------------
// affectedCellsLeafHashes — golden vector anchor
// ---------------------------------------------------------------------------

describe("affectedCellsLeafHashes", () => {
    it("returns leaf hashes matching expected_hashes.json in order", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const hashes = affectedCellsLeafHashes(input);
        expect(hashes).toHaveLength(expectedHashes.leaf_hashes.length);
        for (let i = 0; i < hashes.length; i++) {
            expect(hashes[i]?.h3_index).toBe(expectedHashes.leaf_hashes[i]?.h3_index);
            expect(hashes[i]?.leaf_hash).toBe(expectedHashes.leaf_hashes[i]?.leaf_hash);
        }
    });
});

// ---------------------------------------------------------------------------
// affectedCellsRoot — golden vector anchor
// ---------------------------------------------------------------------------

describe("affectedCellsRoot", () => {
    it("returns the expected_hashes.affected_cells_root golden value", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const root = affectedCellsRoot(input);
        expect(root).toBe(expectedHashes.affected_cells_root);
        // Explicitly: 0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f
        expect(root).toBe("0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f");
    });
});

// ---------------------------------------------------------------------------
// affectedCellProofSteps + directional conversion — golden vector anchor
// ---------------------------------------------------------------------------

describe("affectedCellProofSteps", () => {
    it("generates proof for target cell matching sample_proof.json direction format", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const targetH3 = sampleProof.target_leaf.h3_index; // "608819013597790207"
        const steps = affectedCellProofSteps(input, targetH3);
        const directional = steps.map(proofStepToDirectional);
        expect(directional).toHaveLength(sampleProof.proof.length);
        for (let i = 0; i < directional.length; i++) {
            expect(directional[i]?.direction).toBe(sampleProof.proof[i]?.direction);
            expect(directional[i]?.sibling_hash).toBe(sampleProof.proof[i]?.sibling_hash);
        }
    });

    it("throws for h3_index not present in the input", () => {
        const input = parseAffectedCellsFile(affectedJson);
        expect(() => affectedCellProofSteps(input, "9999999999999999999")).toThrow();
    });

    it("replaying proof with converted steps reproduces the root", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const root = affectedCellsRoot(input);
        const targetH3 = sampleProof.target_leaf.h3_index;
        const leafHash = sampleProof.target_leaf.leaf_hash;
        const steps = affectedCellProofSteps(input, targetH3);
        const replayed = replayProof(leafHash, steps);
        expect(replayed).toBe(root);
    });
});

// ---------------------------------------------------------------------------
// proofStepToDirectional / directionalToProofStep round-trip
// ---------------------------------------------------------------------------

describe("proofStepToDirectional / directionalToProofStep round-trip", () => {
    it("sibling_on_left=true maps to direction=LEFT", () => {
        const step = {
            sibling_on_left: true,
            sibling_hash:
                "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f" as const,
        };
        const d = proofStepToDirectional(step);
        expect(d.direction).toBe("LEFT");
        expect(d.sibling_hash).toBe(step.sibling_hash);
    });

    it("sibling_on_left=false maps to direction=RIGHT", () => {
        const step = {
            sibling_on_left: false,
            sibling_hash:
                "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f" as const,
        };
        const d = proofStepToDirectional(step);
        expect(d.direction).toBe("RIGHT");
    });

    it("direction=LEFT maps to sibling_on_left=true", () => {
        const d: DirectionalProofStep = {
            direction: "LEFT",
            sibling_hash: "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
        };
        const step = directionalToProofStep(d);
        expect(step.sibling_on_left).toBe(true);
        expect(step.sibling_hash).toBe(d.sibling_hash);
    });

    it("direction=RIGHT maps to sibling_on_left=false", () => {
        const d: DirectionalProofStep = {
            direction: "RIGHT",
            sibling_hash: "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
        };
        const step = directionalToProofStep(d);
        expect(step.sibling_on_left).toBe(false);
    });

    it("round-trip proofStep -> directional -> proofStep is identity", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const steps = affectedCellProofSteps(input, sampleProof.target_leaf.h3_index);
        for (const step of steps) {
            const roundTripped = directionalToProofStep(proofStepToDirectional(step));
            expect(roundTripped.sibling_on_left).toBe(step.sibling_on_left);
            expect(roundTripped.sibling_hash).toBe(step.sibling_hash);
        }
    });

    it("round-trip directional -> proofStep -> directional is identity", () => {
        for (const d of sampleProof.proof as DirectionalProofStep[]) {
            const roundTripped = proofStepToDirectional(directionalToProofStep(d));
            expect(roundTripped.direction).toBe(d.direction);
            expect(roundTripped.sibling_hash).toBe(d.sibling_hash);
        }
    });
});
