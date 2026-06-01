import { describe, expect, it } from "vitest";
import {
    expectedProofShardObjectKey,
    leafHash,
    parseH3Index,
    parseProofShard,
    parseProofShardManifest,
    proofShardId,
    replayProof,
    sha256Hex,
    shapeProofResponse,
    validateProofEntry,
    validateProofShardInventoryEntry,
} from "./proof_shards.js";

const LEAF_ONE = {
    h3_index: "608819013513904127",
    leaf_hash: "0x07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569",
    proof: [
        {
            sibling_on_left: false,
            sibling_hash: "0xfa0172aedc1751590d58bd2c91d8e37aca3b9c4b4a330c7330440b5203806c4e",
        },
        {
            sibling_on_left: false,
            sibling_hash: "0x8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
        },
    ],
} as const;

const LEAF_TWO = {
    h3_index: "608819013597790207",
    leaf_hash: "0xfa0172aedc1751590d58bd2c91d8e37aca3b9c4b4a330c7330440b5203806c4e",
    proof: [
        {
            sibling_on_left: true,
            sibling_hash: "0x07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569",
        },
        {
            sibling_on_left: false,
            sibling_hash: "0x8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
        },
    ],
} as const;

const LEAF_THREE = {
    h3_index: "608819013681676287",
    leaf_hash: "0x8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
    proof: [
        {
            sibling_on_left: true,
            sibling_hash: "0x312e3863ccf00e446423342e1acebdab8e7119ee19dae854904de693225c2678",
        },
    ],
} as const;

const MERKLE_ROOT = "0xa26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020";

const MANIFEST = {
    schema: "sonari.residence.proof_manifest.v1",
    schema_version: 1,
    allowlist_version: 1,
    geo_resolution: 7,
    merkle_root: MERKLE_ROOT,
    shard_count: 5,
    total_proof_count: 3,
    object_key_rule:
        "residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz",
    shards: [
        {
            shard_id: 0,
            object_key: "residence-cells/v1/res7/proofs/shards/00000.json.gz",
            proof_count: 2,
            sha256: "0x1111111111111111111111111111111111111111111111111111111111111111",
            byte_size: 10,
        },
        {
            shard_id: 1,
            object_key: "residence-cells/v1/res7/proofs/shards/00001.json.gz",
            proof_count: 1,
            sha256: "0x2222222222222222222222222222222222222222222222222222222222222222",
            byte_size: 20,
        },
        {
            shard_id: 2,
            object_key: "residence-cells/v1/res7/proofs/shards/00002.json.gz",
            proof_count: 0,
            sha256: "0x3333333333333333333333333333333333333333333333333333333333333333",
            byte_size: 30,
        },
        {
            shard_id: 3,
            object_key: "residence-cells/v1/res7/proofs/shards/00003.json.gz",
            proof_count: 0,
            sha256: "0x4444444444444444444444444444444444444444444444444444444444444444",
            byte_size: 40,
        },
        {
            shard_id: 4,
            object_key: "residence-cells/v1/res7/proofs/shards/00004.json.gz",
            proof_count: 0,
            sha256: "0x5555555555555555555555555555555555555555555555555555555555555555",
            byte_size: 50,
        },
    ],
} as const;

const SHARD = {
    schema: "sonari.residence.proof_shard.v1",
    schema_version: 1,
    allowlist_version: 1,
    geo_resolution: 7,
    merkle_root: MERKLE_ROOT,
    shard_id: 0,
    shard_count: 5,
    proofs: [LEAF_THREE],
} as const;

describe("h3_index parsing", () => {
    it("preserves canonical decimal strings as string and bigint", () => {
        expect(parseH3Index("608819013513904127", 7)).toEqual({
            decimal: "608819013513904127",
            value: 608819013513904127n,
        });
    });

    it("rejects non-canonical decimal strings and u64 overflow", () => {
        for (const value of ["", "-1", "+1", "abc", "1.2", "01", "18446744073709551616"]) {
            expect(() => parseH3Index(value, 7), value).toThrow();
        }
    });

    it("validates the basic H3 cell bit layout for the expected resolution", () => {
        expect(() => parseH3Index("608819013513904127", 6)).toThrow(/resolution/i);
        const wrongMode = (608819013513904127n & ~(0xfn << 59n)) | (2n << 59n);
        expect(() => parseH3Index(wrongMode.toString(), 7)).toThrow(/mode/i);

        const activeDigitSeven = 608819013513904127n | (7n << 42n);
        expect(() => parseH3Index(activeDigitSeven.toString(), 7)).toThrow(/digit/i);

        const unusedDigitNotSeven = 608819013513904127n & ~(7n << 21n);
        expect(() => parseH3Index(unusedDigitNotSeven.toString(), 7)).toThrow(/unused/i);
    });
});

describe("proof shard contracts", () => {
    it("matches Rust golden vectors for leaf hash and proof replay", async () => {
        expect(
            await leafHash({
                h3Index: 608819013513904127n,
                geoResolution: 7,
                allowlistVersion: 1,
            }),
        ).toBe(LEAF_ONE.leaf_hash);
        expect(await replayProof(LEAF_ONE.leaf_hash, LEAF_ONE.proof)).toBe(MERKLE_ROOT);
        expect(await replayProof(LEAF_TWO.leaf_hash, LEAF_TWO.proof)).toBe(MERKLE_ROOT);
        expect(await replayProof(LEAF_THREE.leaf_hash, LEAF_THREE.proof)).toBe(MERKLE_ROOT);
    });

    it("hashes h3_index before assigning proof shard ids", async () => {
        expect(await proofShardId(608819013513904127n, 5)).toBe(0);
        expect(await proofShardId(608819013597790207n, 5)).toBe(1);
        expect(await proofShardId(608819013681676287n, 5)).toBe(0);
        await expect(proofShardId(1n, 0)).rejects.toThrow(/shard_count/i);
    });

    it("builds expected object keys and validates inventory integrity metadata", () => {
        expect(expectedProofShardObjectKey(1, 7, 4)).toBe(
            "residence-cells/v1/res7/proofs/shards/00004.json.gz",
        );
        expect(
            validateProofShardInventoryEntry(MANIFEST.shards[4], {
                allowlistVersion: 1,
                geoResolution: 7,
                shardCount: 5,
            }),
        ).toEqual(MANIFEST.shards[4]);
        expect(() =>
            validateProofShardInventoryEntry(
                { ...MANIFEST.shards[4], object_key: "wrong" },
                { allowlistVersion: 1, geoResolution: 7, shardCount: 5 },
            ),
        ).toThrow(/object_key/i);
    });

    it("computes artifact SHA-256 as lowercase 0x-prefixed hex", async () => {
        const bytes = new TextEncoder().encode("sonari");
        expect(await sha256Hex(bytes)).toBe(
            "0x61e344607f3377da5f894e4b2529086c36323118f6390ac146c876e5a7725c47",
        );
    });
});

describe("manifest and shard parsing", () => {
    it("parses a complete proof manifest with inventory validation", () => {
        expect(parseProofShardManifest(MANIFEST)).toEqual(MANIFEST);
        expect(() =>
            parseProofShardManifest({
                ...MANIFEST,
                shards: [MANIFEST.shards[0]],
            }),
        ).toThrow(/inventory length/i);
    });

    it("parses a shard and rejects metadata mismatches", () => {
        expect(
            parseProofShard(SHARD, {
                allowlistVersion: 1,
                geoResolution: 7,
                merkleRoot: MERKLE_ROOT,
                shardId: 0,
                shardCount: 5,
            }),
        ).toEqual(SHARD);

        expect(() =>
            parseProofShard(
                { ...SHARD, shard_id: 3 },
                {
                    allowlistVersion: 1,
                    geoResolution: 7,
                    merkleRoot: MERKLE_ROOT,
                    shardId: 0,
                    shardCount: 5,
                },
            ),
        ).toThrow(/shard_id/i);
    });
});

describe("proof entry validation and response shaping", () => {
    it("validates h3 assignment, leaf hash, and proof root before shaping a response", async () => {
        const entry = await validateProofEntry(LEAF_THREE, {
            allowlistVersion: 1,
            geoResolution: 7,
            merkleRoot: MERKLE_ROOT,
            shardId: 0,
            shardCount: 5,
        });

        expect(entry.h3Index).toEqual({
            decimal: LEAF_THREE.h3_index,
            value: 608819013681676287n,
        });
        expect(shapeProofResponse(entry, { allowlistVersion: 1, geoResolution: 7 })).toEqual({
            h3_index: LEAF_THREE.h3_index,
            allowlist_version: 1,
            geo_resolution: 7,
            merkle_root: MERKLE_ROOT,
            proof: LEAF_THREE.proof,
        });
    });

    it("rejects tampered proof entries", async () => {
        await expect(
            validateProofEntry(
                { ...LEAF_THREE, leaf_hash: LEAF_ONE.leaf_hash },
                {
                    allowlistVersion: 1,
                    geoResolution: 7,
                    merkleRoot: MERKLE_ROOT,
                    shardId: 0,
                    shardCount: 5,
                },
            ),
        ).rejects.toThrow(/leaf_hash/i);

        await expect(
            validateProofEntry(LEAF_TWO, {
                allowlistVersion: 1,
                geoResolution: 7,
                merkleRoot: MERKLE_ROOT,
                shardId: 0,
                shardCount: 5,
            }),
        ).rejects.toThrow(/belongs to shard_id/i);
    });
});
