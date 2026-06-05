import { describe, expect, it } from "vitest";
import { proofShardId } from "./shard.js";

// Rust-matched golden vectors from packages/residence-proof-worker/src/proof_shards.test.ts
describe("proofShardId", () => {
    it("returns shard id matching Rust implementation for known h3 indices", async () => {
        expect(await proofShardId(608819013513904127n, 5)).toBe(0);
        expect(await proofShardId(608819013597790207n, 5)).toBe(1);
    });

    it("returns shard id 0 for third h3 index with 5 shards", async () => {
        expect(await proofShardId(608819013681676287n, 5)).toBe(0);
    });

    it("throws when shardCount is zero", async () => {
        await expect(proofShardId(1n, 0)).rejects.toThrow(/shard_count/i);
    });

    it("throws when shardCount is negative", async () => {
        await expect(proofShardId(1n, -1)).rejects.toThrow(/shard_count/i);
    });

    it("throws when shardCount is not an integer", async () => {
        await expect(proofShardId(1n, 1.5)).rejects.toThrow(/shard_count/i);
    });
});
