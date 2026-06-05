import {
    type AffectedCellsInput,
    affectedCellProofSteps,
    affectedCellsLeafHashes,
    affectedCellsRoot,
} from "./affected-cells.js";
import type { PrefixedHex32 } from "./bytes.js";
import { sha256Hex } from "./bytes.js";
import type { ProofStep } from "./merkle.js";
import { proofShardId } from "./shard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProofEntry {
    h3_index: string;
    leaf_hash: PrefixedHex32;
    proof: ProofStep[];
}

export interface ProofShardGroup {
    shard_id: number;
    proof_count: number;
    sha256: PrefixedHex32;
    byte_size: number;
    proofs: ProofEntry[];
}

export interface ProofManifest {
    merkle_root: PrefixedHex32;
    shard_count: number;
    total_proof_count: number;
    shards: {
        shard_id: number;
        proof_count: number;
        sha256: PrefixedHex32;
        byte_size: number;
    }[];
}

// ---------------------------------------------------------------------------
// Internal helper: deterministic JSON bytes
// ---------------------------------------------------------------------------

/**
 * Serialize value to canonical JSON bytes: no extra whitespace, UTF-8 encoded.
 * Key order is determined by insertion order (caller must pass objects with
 * keys in the desired fixed order).
 */
function canonicalJsonBytes(value: unknown): Uint8Array {
    const json = JSON.stringify(value);
    return new TextEncoder().encode(json);
}

/**
 * Serialize an array of ProofEntry values to canonical bytes.
 */
function proofEntriesCanonicalBytes(entries: ProofEntry[]): Uint8Array {
    const ordered = entries.map((entry) => ({
        h3_index: entry.h3_index,
        leaf_hash: entry.leaf_hash,
        proof: entry.proof.map((step) => ({
            sibling_on_left: step.sibling_on_left,
            sibling_hash: step.sibling_hash,
        })),
    }));
    return canonicalJsonBytes(ordered);
}

// ---------------------------------------------------------------------------
// buildProofEntries
// ---------------------------------------------------------------------------

export async function buildProofEntries(input: AffectedCellsInput): Promise<ProofEntry[]> {
    const hashes = await affectedCellsLeafHashes(input);
    const entries: ProofEntry[] = [];
    for (const { h3_index, leaf_hash } of hashes) {
        const proof = await affectedCellProofSteps(input, h3_index);
        entries.push({ h3_index, leaf_hash, proof });
    }
    return entries;
}

// ---------------------------------------------------------------------------
// buildProofShardGroups
// ---------------------------------------------------------------------------

export async function buildProofShardGroups(
    input: AffectedCellsInput,
    shardCount: number,
): Promise<ProofShardGroup[]> {
    if (!Number.isInteger(shardCount) || shardCount <= 0) {
        throw new Error("shardCount must be a positive integer");
    }

    const entries = await buildProofEntries(input);

    // Group entries by shard_id
    const shardMap = new Map<number, ProofEntry[]>();
    for (const entry of entries) {
        const shardId = await proofShardId(BigInt(entry.h3_index), shardCount);
        const existing = shardMap.get(shardId);
        if (existing !== undefined) {
            existing.push(entry);
        } else {
            shardMap.set(shardId, [entry]);
        }
    }

    // Build shard groups sorted by shard_id ascending
    const sortedIds = [...shardMap.keys()].sort((a, b) => a - b);
    const groups: ProofShardGroup[] = [];

    for (const shardId of sortedIds) {
        const proofs = shardMap.get(shardId);
        if (proofs === undefined) {
            throw new Error(`Unexpected undefined shard for id ${shardId}`);
        }
        // Sort proofs within shard by numeric h3_index ascending
        proofs.sort((a, b) => {
            const ai = BigInt(a.h3_index);
            const bi = BigInt(b.h3_index);
            if (ai < bi) return -1;
            if (ai > bi) return 1;
            return 0;
        });

        const bytes = proofEntriesCanonicalBytes(proofs);
        const sha256Hash = await sha256Hex(bytes);

        groups.push({
            shard_id: shardId,
            proof_count: proofs.length,
            sha256: sha256Hash,
            byte_size: bytes.length,
            proofs,
        });
    }

    return groups;
}

// ---------------------------------------------------------------------------
// buildProofManifest
// ---------------------------------------------------------------------------

export async function buildProofManifest(
    input: AffectedCellsInput,
    shardCount: number,
): Promise<ProofManifest> {
    const [merkle_root, groups] = await Promise.all([
        affectedCellsRoot(input),
        buildProofShardGroups(input, shardCount),
    ]);

    const total_proof_count = groups.reduce((sum, g) => sum + g.proof_count, 0);

    // Verify invariant: total_proof_count === Σ proof_count
    const shardSum = groups.reduce((sum, g) => sum + g.proof_count, 0);
    if (shardSum !== total_proof_count) {
        throw new Error(
            `Invariant violation: total_proof_count ${total_proof_count} !== Σ proof_count ${shardSum}`,
        );
    }

    const shards = groups.map(({ shard_id, proof_count, sha256, byte_size }) => ({
        shard_id,
        proof_count,
        sha256,
        byte_size,
    }));

    return {
        merkle_root,
        shard_count: shardCount,
        total_proof_count,
        shards,
    };
}
