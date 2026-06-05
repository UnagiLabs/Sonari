import { bytesToBigEndianU64, sha256Bytes, u64BigEndianBytes } from "./bytes.js";

export async function proofShardId(h3Index: bigint, shardCount: number): Promise<number> {
    if (!Number.isInteger(shardCount) || shardCount <= 0) {
        throw new Error("shard_count must be greater than zero");
    }
    const digest = await sha256Bytes(u64BigEndianBytes(h3Index));
    const prefix = bytesToBigEndianU64(digest.subarray(0, 8));
    return Number(prefix % BigInt(shardCount));
}
