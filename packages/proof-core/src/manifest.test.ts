import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { affectedCellProofSteps, parseAffectedCellsFile } from "./affected-cells.js";
import { buildProofEntries, buildProofManifest, buildProofShardGroups } from "./manifest.js";
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

// ---------------------------------------------------------------------------
// buildProofEntries
// ---------------------------------------------------------------------------

describe("buildProofEntries", () => {
    it("returns one entry per affected cell", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const entries = buildProofEntries(input);
        expect(entries).toHaveLength(2);
    });

    it("each entry has h3_index, leaf_hash, and proof array", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const entries = buildProofEntries(input);
        for (const entry of entries) {
            expect(typeof entry.h3_index).toBe("string");
            expect(typeof entry.leaf_hash).toBe("string");
            expect(Array.isArray(entry.proof)).toBe(true);
        }
    });

    it("leaf_hashes match expected_hashes.json golden values", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const entries = buildProofEntries(input);
        for (let i = 0; i < entries.length; i++) {
            expect(entries[i]?.h3_index).toBe(expectedHashes.leaf_hashes[i]?.h3_index);
            expect(entries[i]?.leaf_hash).toBe(expectedHashes.leaf_hashes[i]?.leaf_hash);
        }
    });

    it("entries are in numeric h3_index ascending order", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const entries = buildProofEntries(input);
        for (let i = 1; i < entries.length; i++) {
            const prev = BigInt(entries[i - 1]?.h3_index ?? "0");
            const curr = BigInt(entries[i]?.h3_index ?? "0");
            expect(curr > prev).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// buildProofShardGroups
// ---------------------------------------------------------------------------

const SHARD_COUNT = 4;

describe("buildProofShardGroups", () => {
    it("returns only non-empty shards (proof_count > 0)", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups = buildProofShardGroups(input, SHARD_COUNT);
        for (const group of groups) {
            expect(group.proof_count).toBeGreaterThan(0);
            expect(group.proofs.length).toBe(group.proof_count);
        }
    });

    it("total proof_count across shards equals total number of cells", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups = buildProofShardGroups(input, SHARD_COUNT);
        const total = groups.reduce((sum, g) => sum + g.proof_count, 0);
        expect(total).toBe(2);
    });

    it("shards are returned in shard_id ascending order", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups = buildProofShardGroups(input, SHARD_COUNT);
        for (let i = 1; i < groups.length; i++) {
            expect(groups[i]?.shard_id).toBeGreaterThan(groups[i - 1]?.shard_id ?? -1);
        }
    });

    it("each shard has valid sha256 (0x-prefixed 32-byte hex) and byte_size > 0", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups = buildProofShardGroups(input, SHARD_COUNT);
        for (const group of groups) {
            expect(group.sha256).toMatch(/^0x[0-9a-f]{64}$/);
            expect(group.byte_size).toBeGreaterThan(0);
        }
    });

    it("sha256 and byte_size are deterministic (same output on two calls)", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups1 = buildProofShardGroups(input, SHARD_COUNT);
        const groups2 = buildProofShardGroups(input, SHARD_COUNT);
        expect(groups1.length).toBe(groups2.length);
        for (let i = 0; i < groups1.length; i++) {
            expect(groups1[i]?.sha256).toBe(groups2[i]?.sha256);
            expect(groups1[i]?.byte_size).toBe(groups2[i]?.byte_size);
        }
    });

    it("each shard contains proofs in numeric h3_index ascending order", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups = buildProofShardGroups(input, SHARD_COUNT);
        for (const group of groups) {
            for (let i = 1; i < group.proofs.length; i++) {
                const prev = BigInt(group.proofs[i - 1]?.h3_index ?? "0");
                const curr = BigInt(group.proofs[i]?.h3_index ?? "0");
                expect(curr > prev).toBe(true);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// buildProofManifest
// ---------------------------------------------------------------------------

describe("buildProofManifest", () => {
    it("merkle_root matches expected_hashes.json golden value", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = buildProofManifest(input, SHARD_COUNT);
        expect(manifest.merkle_root).toBe(expectedHashes.affected_cells_root);
        expect(manifest.merkle_root).toBe(
            "0xa7242156cf099521ac01790b775f32003ca571a7ef30a88e2e5034c71547a642",
        );
    });

    it("shard_count equals the provided value", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = buildProofManifest(input, SHARD_COUNT);
        expect(manifest.shard_count).toBe(SHARD_COUNT);
    });

    it("total_proof_count equals number of affected cells", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = buildProofManifest(input, SHARD_COUNT);
        expect(manifest.total_proof_count).toBe(2);
    });

    it("sum of shard proof_counts equals total_proof_count", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = buildProofManifest(input, SHARD_COUNT);
        const sum = manifest.shards.reduce((acc, s) => acc + s.proof_count, 0);
        expect(sum).toBe(manifest.total_proof_count);
    });

    it("manifest shards do not contain proofs field (only summary fields)", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = buildProofManifest(input, SHARD_COUNT);
        for (const shard of manifest.shards) {
            expect("proofs" in shard).toBe(false);
            expect(typeof shard.shard_id).toBe("number");
            expect(typeof shard.proof_count).toBe("number");
            expect(typeof shard.sha256).toBe("string");
            expect(typeof shard.byte_size).toBe("number");
        }
    });

    it("manifest shards are in shard_id ascending order", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = buildProofManifest(input, SHARD_COUNT);
        for (let i = 1; i < manifest.shards.length; i++) {
            expect(manifest.shards[i]?.shard_id).toBeGreaterThan(
                manifest.shards[i - 1]?.shard_id ?? -1,
            );
        }
    });

    it("is deterministic (two calls produce identical manifests)", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const m1 = buildProofManifest(input, SHARD_COUNT);
        const m2 = buildProofManifest(input, SHARD_COUNT);
        expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
    });

    it("manifest does not reference any schema string or R2 key", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = buildProofManifest(input, SHARD_COUNT);
        const serialized = JSON.stringify(manifest);
        expect(serialized).not.toContain("sonari.affected");
        expect(serialized).not.toContain("r2://");
        expect(serialized).not.toContain("gzip");
    });
});

// ---------------------------------------------------------------------------
// Characterization tests for buildProofEntries (proof step列の固定 - STEP 3 安全網)
// ---------------------------------------------------------------------------

// Hand-crafted 3-cell fixture (multi-level tree, odd-leaf promotion)
// All cells satisfy parse constraints: h3_index ascending, no duplicates,
// geo_resolution=7, cell_band 1..3, intensity_value <= 65535
const THREE_CELL_JSON = {
    event_uid: "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
    event_revision: 1,
    oracle_version: 1,
    geo_resolution: 7,
    cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
    cell_metric: "USGS_MMI",
    cell_aggregation: "GRID_POINT_P90",
    intensity_scale: "MMI_X100",
    affected_cells: [
        { h3_index: "608819013513904127", intensity_value: 831, cell_band: 3 },
        { h3_index: "608819013597790207", intensity_value: 723, cell_band: 1 },
        { h3_index: "608819013681676287", intensity_value: 500, cell_band: 2 },
    ],
};

describe("buildProofEntries – characterization (STEP 3 安全網)", () => {
    // ---------------------------------------------------------------------------
    // (a) 独立参照との一致: 3セル入力で buildProofEntries の出力が
    //     affectedCellProofSteps 個別APIから組み立てた参照 ProofEntry 配列と完全一致する
    // ---------------------------------------------------------------------------
    it("3-cell: matches reference ProofEntry array built from affectedCellProofSteps", () => {
        const input = parseAffectedCellsFile(THREE_CELL_JSON);
        const entries = buildProofEntries(input);

        const refEntries = entries.map((e) => ({
            h3_index: e.h3_index,
            leaf_hash: e.leaf_hash,
            proof: affectedCellProofSteps(input, e.h3_index),
        }));

        expect(entries).toEqual(refEntries);
    });

    // ---------------------------------------------------------------------------
    // (b) 固定スナップショット: 3セル入力で buildProofEntries の全フィールドをハードコード固定
    //     (leaf_hash + proof step列 を含む)
    // ---------------------------------------------------------------------------
    it("3-cell: full output matches hardcoded snapshot (proof steps included)", () => {
        const input = parseAffectedCellsFile(THREE_CELL_JSON);
        const entries = buildProofEntries(input);

        expect(entries).toEqual([
            {
                h3_index: "608819013513904127",
                leaf_hash: "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
                proof: [
                    {
                        sibling_on_left: false,
                        sibling_hash:
                            "0xbc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f",
                    },
                    {
                        sibling_on_left: false,
                        sibling_hash:
                            "0x2c4d904fb8f69d0dc30e0c0ac71160044eea96df3898a87e7243e65cf6f9b609",
                    },
                ],
            },
            {
                h3_index: "608819013597790207",
                leaf_hash: "0xbc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f",
                proof: [
                    {
                        sibling_on_left: true,
                        sibling_hash:
                            "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
                    },
                    {
                        sibling_on_left: false,
                        sibling_hash:
                            "0x2c4d904fb8f69d0dc30e0c0ac71160044eea96df3898a87e7243e65cf6f9b609",
                    },
                ],
            },
            {
                h3_index: "608819013681676287",
                leaf_hash: "0x2c4d904fb8f69d0dc30e0c0ac71160044eea96df3898a87e7243e65cf6f9b609",
                proof: [
                    {
                        sibling_on_left: true,
                        sibling_hash:
                            "0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f",
                    },
                ],
            },
        ]);
    });

    // ---------------------------------------------------------------------------
    // (c) 2セル fixture のフルスナップショット固定（既存 fixture、proof step列を追加固定）
    // ---------------------------------------------------------------------------
    it("2-cell fixture: full output matches hardcoded snapshot (proof steps included)", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const entries = buildProofEntries(input);

        expect(entries).toEqual([
            {
                h3_index: "608819013547458559",
                leaf_hash: "0xd70aa6ea6ea477da0563464bd56111d5711d0fdb4bd769d5ffa73bff92ebfaa5",
                proof: [
                    {
                        sibling_on_left: false,
                        sibling_hash:
                            "0xa52fea29a73e5c0aff5f2f209f446d9b4e1e3ccfd4df5688f6991e7e485631d1",
                    },
                ],
            },
            {
                h3_index: "608819013614567423",
                leaf_hash: "0xa52fea29a73e5c0aff5f2f209f446d9b4e1e3ccfd4df5688f6991e7e485631d1",
                proof: [
                    {
                        sibling_on_left: true,
                        sibling_hash:
                            "0xd70aa6ea6ea477da0563464bd56111d5711d0fdb4bd769d5ffa73bff92ebfaa5",
                    },
                ],
            },
        ]);
    });

    // ---------------------------------------------------------------------------
    // (d) replayProof で全 entry が root に整合することを確認
    // ---------------------------------------------------------------------------
    it("3-cell: each proof replays to the same merkle root", () => {
        const input = parseAffectedCellsFile(THREE_CELL_JSON);
        const entries = buildProofEntries(input);
        // 3-cell root: pair(leaf0,leaf1) then promote leaf2 => root = internalHash(pair01, leaf2)
        // The first entry's proof step[1].sibling_hash is leaf2 hash, and replaying both steps
        // should produce the same root for all entries.
        const roots = entries.map((e) => replayProof(e.leaf_hash, e.proof));
        expect(roots[0]).toBe(roots[1]);
        expect(roots[0]).toBe(roots[2]);
    });

    it("2-cell fixture: each proof replays to the same merkle root (golden root)", () => {
        const input = parseAffectedCellsFile(affectedJson);
        const entries = buildProofEntries(input);
        const GOLDEN_ROOT = "0xa7242156cf099521ac01790b775f32003ca571a7ef30a88e2e5034c71547a642";
        for (const entry of entries) {
            expect(replayProof(entry.leaf_hash, entry.proof)).toBe(GOLDEN_ROOT);
        }
    });
});
