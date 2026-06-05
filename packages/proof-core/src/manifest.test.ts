import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAffectedCellsFile } from "./affected-cells.js";
import { buildProofEntries, buildProofManifest, buildProofShardGroups } from "./manifest.js";

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
    it("returns one entry per affected cell", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const entries = await buildProofEntries(input);
        expect(entries).toHaveLength(2);
    });

    it("each entry has h3_index, leaf_hash, and proof array", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const entries = await buildProofEntries(input);
        for (const entry of entries) {
            expect(typeof entry.h3_index).toBe("string");
            expect(typeof entry.leaf_hash).toBe("string");
            expect(Array.isArray(entry.proof)).toBe(true);
        }
    });

    it("leaf_hashes match expected_hashes.json golden values", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const entries = await buildProofEntries(input);
        for (let i = 0; i < entries.length; i++) {
            expect(entries[i]?.h3_index).toBe(expectedHashes.leaf_hashes[i]?.h3_index);
            expect(entries[i]?.leaf_hash).toBe(expectedHashes.leaf_hashes[i]?.leaf_hash);
        }
    });

    it("entries are in numeric h3_index ascending order", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const entries = await buildProofEntries(input);
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
    it("returns only non-empty shards (proof_count > 0)", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups = await buildProofShardGroups(input, SHARD_COUNT);
        for (const group of groups) {
            expect(group.proof_count).toBeGreaterThan(0);
            expect(group.proofs.length).toBe(group.proof_count);
        }
    });

    it("total proof_count across shards equals total number of cells", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups = await buildProofShardGroups(input, SHARD_COUNT);
        const total = groups.reduce((sum, g) => sum + g.proof_count, 0);
        expect(total).toBe(2);
    });

    it("shards are returned in shard_id ascending order", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups = await buildProofShardGroups(input, SHARD_COUNT);
        for (let i = 1; i < groups.length; i++) {
            expect(groups[i]?.shard_id).toBeGreaterThan(groups[i - 1]?.shard_id ?? -1);
        }
    });

    it("each shard has valid sha256 (0x-prefixed 32-byte hex) and byte_size > 0", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups = await buildProofShardGroups(input, SHARD_COUNT);
        for (const group of groups) {
            expect(group.sha256).toMatch(/^0x[0-9a-f]{64}$/);
            expect(group.byte_size).toBeGreaterThan(0);
        }
    });

    it("sha256 and byte_size are deterministic (same output on two calls)", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups1 = await buildProofShardGroups(input, SHARD_COUNT);
        const groups2 = await buildProofShardGroups(input, SHARD_COUNT);
        expect(groups1.length).toBe(groups2.length);
        for (let i = 0; i < groups1.length; i++) {
            expect(groups1[i]?.sha256).toBe(groups2[i]?.sha256);
            expect(groups1[i]?.byte_size).toBe(groups2[i]?.byte_size);
        }
    });

    it("each shard contains proofs in numeric h3_index ascending order", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const groups = await buildProofShardGroups(input, SHARD_COUNT);
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
    it("merkle_root matches expected_hashes.json golden value", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = await buildProofManifest(input, SHARD_COUNT);
        expect(manifest.merkle_root).toBe(expectedHashes.affected_cells_root);
        expect(manifest.merkle_root).toBe(
            "0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f",
        );
    });

    it("shard_count equals the provided value", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = await buildProofManifest(input, SHARD_COUNT);
        expect(manifest.shard_count).toBe(SHARD_COUNT);
    });

    it("total_proof_count equals number of affected cells", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = await buildProofManifest(input, SHARD_COUNT);
        expect(manifest.total_proof_count).toBe(2);
    });

    it("sum of shard proof_counts equals total_proof_count", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = await buildProofManifest(input, SHARD_COUNT);
        const sum = manifest.shards.reduce((acc, s) => acc + s.proof_count, 0);
        expect(sum).toBe(manifest.total_proof_count);
    });

    it("manifest shards do not contain proofs field (only summary fields)", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = await buildProofManifest(input, SHARD_COUNT);
        for (const shard of manifest.shards) {
            expect("proofs" in shard).toBe(false);
            expect(typeof shard.shard_id).toBe("number");
            expect(typeof shard.proof_count).toBe("number");
            expect(typeof shard.sha256).toBe("string");
            expect(typeof shard.byte_size).toBe("number");
        }
    });

    it("manifest shards are in shard_id ascending order", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = await buildProofManifest(input, SHARD_COUNT);
        for (let i = 1; i < manifest.shards.length; i++) {
            expect(manifest.shards[i]?.shard_id).toBeGreaterThan(
                manifest.shards[i - 1]?.shard_id ?? -1,
            );
        }
    });

    it("is deterministic (two calls produce identical manifests)", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const m1 = await buildProofManifest(input, SHARD_COUNT);
        const m2 = await buildProofManifest(input, SHARD_COUNT);
        expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
    });

    it("manifest does not reference any schema string or R2 key", async () => {
        const input = parseAffectedCellsFile(affectedJson);
        const manifest = await buildProofManifest(input, SHARD_COUNT);
        const serialized = JSON.stringify(manifest);
        expect(serialized).not.toContain("sonari.affected");
        expect(serialized).not.toContain("r2://");
        expect(serialized).not.toContain("gzip");
    });
});
