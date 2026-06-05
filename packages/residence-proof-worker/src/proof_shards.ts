// Re-export generic utilities from proof-core (single source of truth)
export {
    assertMatches,
    assertNonNegativeSafeInteger,
    bytesToBigEndianU64,
    bytesToPrefixedHex,
    expectArray,
    expectBoolean,
    expectKeys,
    expectLiteral,
    expectNonNegativeSafeInteger,
    expectPositiveSafeInteger,
    expectPrefixedHex32,
    expectRecord,
    expectString,
    hashLeafBytes,
    hexToBytes,
    type JsonRecord,
    type ParsedH3Index,
    type PrefixedHex32,
    type ProofStep,
    parseH3Index,
    proofShardId,
    replayProof,
    sha256Bytes,
    sha256Hex,
    U64_MAX,
    u64BigEndianBytes,
    u64LittleEndianBytes,
    validateH3CellLayout,
} from "@sonari/proof-core";

import {
    assertMatches,
    assertNonNegativeSafeInteger,
    expectArray,
    expectBoolean,
    expectKeys,
    expectLiteral,
    expectNonNegativeSafeInteger,
    expectPositiveSafeInteger,
    expectPrefixedHex32,
    expectRecord,
    expectString,
    hashLeafBytes,
    type ParsedH3Index,
    type PrefixedHex32,
    type ProofStep,
    parseH3Index,
    proofShardId,
    replayProof,
    u64LittleEndianBytes,
} from "@sonari/proof-core";

// Residence-specific schema constants
const PROOF_MANIFEST_SCHEMA = "sonari.residence.proof_manifest.v1";
const PROOF_SHARD_SCHEMA = "sonari.residence.proof_shard.v1";
const PROOF_SCHEMA_VERSION = 1;
const PROOF_SHARD_OBJECT_KEY_RULE =
    "residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz";

// Residence-specific types
export interface ProofShardManifest {
    schema: typeof PROOF_MANIFEST_SCHEMA;
    schema_version: typeof PROOF_SCHEMA_VERSION;
    allowlist_version: number;
    geo_resolution: number;
    merkle_root: PrefixedHex32;
    shard_count: number;
    total_proof_count: number;
    object_key_rule: typeof PROOF_SHARD_OBJECT_KEY_RULE;
    shards: ProofShardInventoryEntry[];
}

export interface ProofShardInventoryEntry {
    shard_id: number;
    object_key: string;
    proof_count: number;
    sha256: PrefixedHex32;
    byte_size: number;
}

export interface ProofShard {
    schema: typeof PROOF_SHARD_SCHEMA;
    schema_version: typeof PROOF_SCHEMA_VERSION;
    allowlist_version: number;
    geo_resolution: number;
    merkle_root: PrefixedHex32;
    shard_id: number;
    shard_count: number;
    proofs: ProofShardEntry[];
}

export interface ProofShardEntry {
    h3_index: string;
    leaf_hash: PrefixedHex32;
    proof: ProofStep[];
}

export interface ValidatedProofEntry {
    h3Index: ParsedH3Index;
    leafHash: PrefixedHex32;
    merkleRoot: PrefixedHex32;
    proof: ProofStep[];
}

export interface ResidenceProofResponse {
    h3_index: string;
    allowlist_version: number;
    geo_resolution: number;
    merkle_root: PrefixedHex32;
    proof: ProofStep[];
}

// Residence-specific leaf hash: SHA-256(0x00 || h3LE8 || geo || allowlistLE8)
// Uses proof-core's hashLeafBytes which prepends 0x00 to the given payload.
// payload = h3LE8(8) + geo(1) + allowlistLE8(8) = 17 bytes
// hashLeafBytes prepends 0x00 -> SHA-256(0x00 || payload) = 18 bytes total, matching original.
export async function leafHash(leaf: {
    h3Index: bigint;
    geoResolution: number;
    allowlistVersion: number;
}): Promise<PrefixedHex32> {
    const payload = new Uint8Array(17); // h3LE8(8) + geo(1) + allowlistLE8(8)
    payload.set(u64LittleEndianBytes(leaf.h3Index), 0);
    payload[8] = leaf.geoResolution;
    payload.set(u64LittleEndianBytes(BigInt(leaf.allowlistVersion)), 9);
    return hashLeafBytes(payload);
}

export function expectedProofShardObjectKey(
    allowlistVersion: number,
    geoResolution: number,
    shardId: number,
): string {
    assertNonNegativeSafeInteger("allowlist_version", allowlistVersion);
    assertNonNegativeSafeInteger("geo_resolution", geoResolution);
    assertNonNegativeSafeInteger("shard_id", shardId);
    return `residence-cells/v${allowlistVersion}/res${geoResolution}/proofs/shards/${shardId
        .toString()
        .padStart(5, "0")}.json.gz`;
}

export function parseProofShardManifest(value: unknown): ProofShardManifest {
    const record = expectRecord("proof manifest", value);
    expectKeys("proof manifest", record, [
        "schema",
        "schema_version",
        "allowlist_version",
        "geo_resolution",
        "merkle_root",
        "shard_count",
        "total_proof_count",
        "object_key_rule",
        "shards",
    ]);

    const schema = expectLiteral("schema", record.schema, PROOF_MANIFEST_SCHEMA);
    const schemaVersion = expectLiteral(
        "schema_version",
        record.schema_version,
        PROOF_SCHEMA_VERSION,
    );
    const allowlistVersion = expectNonNegativeSafeInteger(
        "allowlist_version",
        record.allowlist_version,
    );
    const geoResolution = expectNonNegativeSafeInteger("geo_resolution", record.geo_resolution);
    const merkleRoot = expectPrefixedHex32("merkle_root", record.merkle_root);
    const shardCount = expectPositiveSafeInteger("shard_count", record.shard_count);
    const totalProofCount = expectNonNegativeSafeInteger(
        "total_proof_count",
        record.total_proof_count,
    );
    const objectKeyRule = expectLiteral(
        "object_key_rule",
        record.object_key_rule,
        PROOF_SHARD_OBJECT_KEY_RULE,
    );
    const rawShards = expectArray("shards", record.shards);
    if (rawShards.length !== shardCount) {
        throw new Error(`proof manifest inventory length must be ${shardCount}`);
    }

    const seen = new Set<number>();
    let proofCountSum = 0;
    const shards = rawShards
        .map((entry) => {
            const parsed = parseInventoryEntry(entry);
            validateProofShardInventoryEntry(parsed, {
                allowlistVersion,
                geoResolution,
                shardCount,
            });
            if (seen.has(parsed.shard_id)) {
                throw new Error(`duplicate shard inventory entry for shard_id ${parsed.shard_id}`);
            }
            seen.add(parsed.shard_id);
            proofCountSum += parsed.proof_count;
            return parsed;
        })
        .sort((left, right) => left.shard_id - right.shard_id);

    for (let shardId = 0; shardId < shardCount; shardId += 1) {
        if (!seen.has(shardId)) {
            throw new Error(`missing shard inventory entry for shard_id ${shardId}`);
        }
    }
    if (proofCountSum !== totalProofCount) {
        throw new Error(
            `proof manifest total_proof_count ${totalProofCount} does not match inventory ${proofCountSum}`,
        );
    }

    return {
        schema,
        schema_version: schemaVersion,
        allowlist_version: allowlistVersion,
        geo_resolution: geoResolution,
        merkle_root: merkleRoot,
        shard_count: shardCount,
        total_proof_count: totalProofCount,
        object_key_rule: objectKeyRule,
        shards,
    };
}

export function validateProofShardInventoryEntry(
    entry: unknown,
    expected: {
        allowlistVersion: number;
        geoResolution: number;
        shardCount: number;
    },
): ProofShardInventoryEntry {
    const parsed = parseInventoryEntry(entry);
    if (parsed.shard_id >= expected.shardCount) {
        throw new Error(
            `proof manifest shard_id ${parsed.shard_id} is outside shard_count ${expected.shardCount}`,
        );
    }
    const expectedObjectKey = expectedProofShardObjectKey(
        expected.allowlistVersion,
        expected.geoResolution,
        parsed.shard_id,
    );
    if (parsed.object_key !== expectedObjectKey) {
        throw new Error(
            `proof manifest shard_id ${parsed.shard_id} object_key ${parsed.object_key} does not match ${expectedObjectKey}`,
        );
    }
    return parsed;
}

export function parseProofShard(
    value: unknown,
    expected: {
        allowlistVersion: number;
        geoResolution: number;
        merkleRoot: string;
        shardId: number;
        shardCount: number;
    },
): ProofShard {
    const record = expectRecord("proof shard", value);
    expectKeys("proof shard", record, [
        "schema",
        "schema_version",
        "allowlist_version",
        "geo_resolution",
        "merkle_root",
        "shard_id",
        "shard_count",
        "proofs",
    ]);

    const shard: ProofShard = {
        schema: expectLiteral("schema", record.schema, PROOF_SHARD_SCHEMA),
        schema_version: expectLiteral(
            "schema_version",
            record.schema_version,
            PROOF_SCHEMA_VERSION,
        ),
        allowlist_version: expectNonNegativeSafeInteger(
            "allowlist_version",
            record.allowlist_version,
        ),
        geo_resolution: expectNonNegativeSafeInteger("geo_resolution", record.geo_resolution),
        merkle_root: expectPrefixedHex32("merkle_root", record.merkle_root),
        shard_id: expectNonNegativeSafeInteger("shard_id", record.shard_id),
        shard_count: expectPositiveSafeInteger("shard_count", record.shard_count),
        proofs: expectArray("proofs", record.proofs).map(parseProofShardEntry),
    };

    assertMatches("allowlist_version", shard.allowlist_version, expected.allowlistVersion);
    assertMatches("geo_resolution", shard.geo_resolution, expected.geoResolution);
    assertMatches(
        "merkle_root",
        shard.merkle_root,
        expectPrefixedHex32("merkleRoot", expected.merkleRoot),
    );
    assertMatches("shard_id", shard.shard_id, expected.shardId);
    assertMatches("shard_count", shard.shard_count, expected.shardCount);

    return shard;
}

export function findProofEntry(shard: ProofShard, h3Index: ParsedH3Index): ProofShardEntry | null {
    return shard.proofs.find((entry) => entry.h3_index === h3Index.decimal) ?? null;
}

export async function validateProofEntry(
    entry: unknown,
    expected: {
        allowlistVersion: number;
        geoResolution: number;
        merkleRoot: string;
        shardId: number;
        shardCount: number;
    },
): Promise<ValidatedProofEntry> {
    const parsed = parseProofShardEntry(entry);
    const h3Index = parseH3Index(parsed.h3_index, expected.geoResolution);
    const computedShardId = await proofShardId(h3Index.value, expected.shardCount);
    if (computedShardId !== expected.shardId) {
        throw new Error(
            `h3_index ${parsed.h3_index} belongs to shard_id ${computedShardId}, not ${expected.shardId}`,
        );
    }

    const computedLeafHash = await leafHash({
        h3Index: h3Index.value,
        geoResolution: expected.geoResolution,
        allowlistVersion: expected.allowlistVersion,
    });
    if (parsed.leaf_hash !== computedLeafHash) {
        throw new Error(
            `h3_index ${parsed.h3_index} leaf_hash ${parsed.leaf_hash} does not match computed ${computedLeafHash}`,
        );
    }

    const expectedMerkleRoot = expectPrefixedHex32("merkleRoot", expected.merkleRoot);
    const replayedRoot = await replayProof(parsed.leaf_hash, parsed.proof);
    if (replayedRoot !== expectedMerkleRoot) {
        throw new Error(
            `h3_index ${parsed.h3_index} proof root ${replayedRoot} does not match manifest ${expectedMerkleRoot}`,
        );
    }

    return {
        h3Index,
        leafHash: parsed.leaf_hash,
        merkleRoot: expectedMerkleRoot,
        proof: parsed.proof,
    };
}

export function shapeProofResponse(
    entry: ValidatedProofEntry,
    metadata: { allowlistVersion: number; geoResolution: number },
): ResidenceProofResponse {
    return {
        h3_index: entry.h3Index.decimal,
        allowlist_version: metadata.allowlistVersion,
        geo_resolution: metadata.geoResolution,
        merkle_root: entry.merkleRoot,
        proof: entry.proof,
    };
}

function parseInventoryEntry(value: unknown): ProofShardInventoryEntry {
    const record = expectRecord("proof shard inventory entry", value);
    expectKeys("proof shard inventory entry", record, [
        "shard_id",
        "object_key",
        "proof_count",
        "sha256",
        "byte_size",
    ]);
    return {
        shard_id: expectNonNegativeSafeInteger("shard_id", record.shard_id),
        object_key: expectString("object_key", record.object_key),
        proof_count: expectNonNegativeSafeInteger("proof_count", record.proof_count),
        sha256: expectPrefixedHex32("sha256", record.sha256),
        byte_size: expectNonNegativeSafeInteger("byte_size", record.byte_size),
    };
}

function parseProofShardEntry(value: unknown): ProofShardEntry {
    const record = expectRecord("proof shard entry", value);
    expectKeys("proof shard entry", record, ["h3_index", "leaf_hash", "proof"]);
    return {
        h3_index: expectString("h3_index", record.h3_index),
        leaf_hash: expectPrefixedHex32("leaf_hash", record.leaf_hash),
        proof: expectArray("proof", record.proof).map(parseProofStep),
    };
}

function parseProofStep(value: unknown): ProofStep {
    const record = expectRecord("proof step", value);
    expectKeys("proof step", record, ["sibling_on_left", "sibling_hash"]);
    return {
        sibling_on_left: expectBoolean("sibling_on_left", record.sibling_on_left),
        sibling_hash: expectPrefixedHex32("sibling_hash", record.sibling_hash),
    };
}
