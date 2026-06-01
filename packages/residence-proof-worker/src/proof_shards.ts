const PROOF_MANIFEST_SCHEMA = "sonari.residence.proof_manifest.v1";
const PROOF_SHARD_SCHEMA = "sonari.residence.proof_shard.v1";
const PROOF_SCHEMA_VERSION = 1;
const PROOF_SHARD_OBJECT_KEY_RULE =
    "residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz";
const U64_MAX = 18_446_744_073_709_551_615n;
const H3_MAX_RESOLUTION = 15;
const H3_MODE_CELL = 1n;

export interface ParsedH3Index {
    decimal: string;
    value: bigint;
}

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

export interface ProofStep {
    sibling_on_left: boolean;
    sibling_hash: PrefixedHex32;
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

type PrefixedHex32 = `0x${string}`;
type JsonRecord = Record<string, unknown>;

export function parseH3Index(value: string, expectedResolution: number): ParsedH3Index {
    if (
        !Number.isInteger(expectedResolution) ||
        expectedResolution < 0 ||
        expectedResolution > 15
    ) {
        throw new Error(`expected resolution must be between 0 and 15: ${expectedResolution}`);
    }
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`h3_index must be a canonical decimal u64 string: ${value}`);
    }

    const parsed = BigInt(value);
    if (parsed > U64_MAX) {
        throw new Error(`h3_index is outside the u64 range: ${value}`);
    }

    validateH3CellLayout(parsed, expectedResolution, value);
    return { decimal: value, value: parsed };
}

export async function proofShardId(h3Index: bigint, shardCount: number): Promise<number> {
    if (!Number.isInteger(shardCount) || shardCount <= 0) {
        throw new Error("shard_count must be greater than zero");
    }
    const digest = await sha256Bytes(u64BigEndianBytes(h3Index));
    const prefix = bytesToBigEndianU64(digest.subarray(0, 8));
    return Number(prefix % BigInt(shardCount));
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
    const shards = rawShards.map((entry) => {
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
    });

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

export async function leafHash(leaf: {
    h3Index: bigint;
    geoResolution: number;
    allowlistVersion: number;
}): Promise<PrefixedHex32> {
    const bytes = new Uint8Array(18);
    bytes[0] = 0;
    bytes.set(u64LittleEndianBytes(leaf.h3Index), 1);
    bytes[9] = leaf.geoResolution;
    bytes.set(u64LittleEndianBytes(BigInt(leaf.allowlistVersion)), 10);
    return sha256Hex(bytes);
}

export async function replayProof(
    leafHashValue: string,
    proof: readonly ProofStep[],
): Promise<PrefixedHex32> {
    let current = hexToBytes(expectPrefixedHex32("leaf_hash", leafHashValue));
    for (const step of proof) {
        const sibling = hexToBytes(expectPrefixedHex32("sibling_hash", step.sibling_hash));
        const input = new Uint8Array(65);
        input[0] = 1;
        if (step.sibling_on_left) {
            input.set(sibling, 1);
            input.set(current, 33);
        } else {
            input.set(current, 1);
            input.set(sibling, 33);
        }
        current = await sha256Bytes(input);
    }
    return bytesToPrefixedHex(current);
}

export async function sha256Hex(bytes: Uint8Array): Promise<PrefixedHex32> {
    return bytesToPrefixedHex(await sha256Bytes(bytes));
}

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return new Uint8Array(digest);
}

function validateH3CellLayout(h3Index: bigint, expectedResolution: number, rawValue: string): void {
    if (((h3Index >> 63n) & 1n) !== 0n) {
        throw new Error(`h3_index reserved bit must be zero: ${rawValue}`);
    }
    const mode = (h3Index >> 59n) & 0xfn;
    if (mode !== H3_MODE_CELL) {
        throw new Error(`h3_index mode must be an H3 cell: ${rawValue}`);
    }
    const resolution = Number((h3Index >> 52n) & 0xfn);
    if (resolution !== expectedResolution) {
        throw new Error(`h3_index resolution must be ${expectedResolution}: ${rawValue}`);
    }
    const baseCell = Number((h3Index >> 45n) & 0x7fn);
    if (baseCell > 121) {
        throw new Error(`h3_index base cell is outside the H3 range: ${rawValue}`);
    }

    for (let digit = 1; digit <= H3_MAX_RESOLUTION; digit += 1) {
        const value = Number((h3Index >> BigInt((H3_MAX_RESOLUTION - digit) * 3)) & 0x7n);
        if (digit <= expectedResolution && value === 7) {
            throw new Error(`h3_index active digit must be 0..6: ${rawValue}`);
        }
        if (digit > expectedResolution && value !== 7) {
            throw new Error(`h3_index unused digit must be 7: ${rawValue}`);
        }
    }
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

function expectRecord(name: string, value: unknown): JsonRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${name} must be an object`);
    }
    return value as JsonRecord;
}

function expectKeys(name: string, record: JsonRecord, keys: readonly string[]): void {
    const expected = new Set(keys);
    for (const key of Object.keys(record)) {
        if (!expected.has(key)) {
            throw new Error(`${name} contains unexpected field: ${key}`);
        }
    }
    for (const key of keys) {
        if (!(key in record)) {
            throw new Error(`${name} is missing field: ${key}`);
        }
    }
}

function expectString(name: string, value: unknown): string {
    if (typeof value !== "string") {
        throw new Error(`${name} must be a string`);
    }
    return value;
}

function expectBoolean(name: string, value: unknown): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`${name} must be a boolean`);
    }
    return value;
}

function expectArray(name: string, value: unknown): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${name} must be an array`);
    }
    return value;
}

function expectLiteral<T extends string | number>(name: string, value: unknown, expected: T): T {
    if (value !== expected) {
        throw new Error(`${name} must be ${expected}`);
    }
    return expected;
}

function expectNonNegativeSafeInteger(name: string, value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
    return value;
}

function expectPositiveSafeInteger(name: string, value: unknown): number {
    const parsed = expectNonNegativeSafeInteger(name, value);
    if (parsed === 0) {
        throw new Error(`${name} must be greater than zero`);
    }
    return parsed;
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
}

function expectPrefixedHex32(name: string, value: unknown): PrefixedHex32 {
    if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
        throw new Error(`${name} must be a lowercase 0x-prefixed 32-byte hex string`);
    }
    return value as PrefixedHex32;
}

function assertMatches<T>(name: string, actual: T, expected: T): void {
    if (actual !== expected) {
        throw new Error(`${name} ${actual} does not match ${expected}`);
    }
}

function u64BigEndianBytes(value: bigint): Uint8Array {
    if (value < 0n || value > U64_MAX) {
        throw new Error(`u64 value is outside range: ${value}`);
    }
    const bytes = new Uint8Array(8);
    for (let index = 7; index >= 0; index -= 1) {
        bytes[index] = Number((value >> BigInt((7 - index) * 8)) & 0xffn);
    }
    return bytes;
}

function u64LittleEndianBytes(value: bigint): Uint8Array {
    if (value < 0n || value > U64_MAX) {
        throw new Error(`u64 value is outside range: ${value}`);
    }
    const bytes = new Uint8Array(8);
    for (let index = 0; index < 8; index += 1) {
        bytes[index] = Number((value >> BigInt(index * 8)) & 0xffn);
    }
    return bytes;
}

function bytesToBigEndianU64(bytes: Uint8Array): bigint {
    if (bytes.length !== 8) {
        throw new Error("u64 byte prefix must be 8 bytes");
    }
    let value = 0n;
    for (const byte of bytes) {
        value = (value << 8n) | BigInt(byte);
    }
    return value;
}

function hexToBytes(value: PrefixedHex32): Uint8Array {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
    }
    return bytes;
}

function bytesToPrefixedHex(bytes: Uint8Array): PrefixedHex32 {
    return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
