import { ResidenceProofError } from "./errors.js";
import type { ResidenceProofR2Bucket } from "./http.js";
import {
    type ProofShard,
    type ProofShardInventoryEntry,
    type ProofShardManifest,
    parseProofShard,
    parseProofShardManifest,
    sha256Hex,
} from "./proof_shards.js";

const manifestCache = new WeakMap<
    ResidenceProofR2Bucket,
    Map<string, Promise<ProofShardManifest>>
>();

export async function loadProofManifest(
    bucket: ResidenceProofR2Bucket,
    config: { allowlistVersion: number; geoResolution: number },
): Promise<ProofShardManifest> {
    const cacheKey = `${config.allowlistVersion}:${config.geoResolution}`;
    let bucketCache = manifestCache.get(bucket);
    if (bucketCache === undefined) {
        bucketCache = new Map();
        manifestCache.set(bucket, bucketCache);
    }

    const cached = bucketCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    const promise = readManifest(bucket, config).catch((error: unknown) => {
        bucketCache.delete(cacheKey);
        throw error;
    });
    bucketCache.set(cacheKey, promise);
    return promise;
}

export async function loadProofShard(
    bucket: ResidenceProofR2Bucket,
    inventory: ProofShardInventoryEntry,
    manifest: ProofShardManifest,
): Promise<ProofShard> {
    const object = await bucket.get(inventory.object_key);
    if (object === null) {
        throw new ResidenceProofError(
            "proof_shard_missing",
            `Proof shard is missing: ${inventory.object_key}`,
            500,
        );
    }

    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== inventory.byte_size) {
        throw new ResidenceProofError(
            "proof_shard_integrity_mismatch",
            `Proof shard byte_size ${bytes.byteLength} does not match manifest ${inventory.byte_size}`,
            500,
        );
    }
    const digest = await sha256Hex(bytes);
    if (digest !== inventory.sha256) {
        throw new ResidenceProofError(
            "proof_shard_integrity_mismatch",
            `Proof shard sha256 ${digest} does not match manifest ${inventory.sha256}`,
            500,
        );
    }

    const json = await gunzipJsonBytes(bytes);
    const shard = parseProofShardJson(json, inventory, manifest);
    if (shard.proofs.length !== inventory.proof_count) {
        throw new ResidenceProofError(
            "proof_shard_invalid",
            `Proof shard proof_count ${shard.proofs.length} does not match manifest ${inventory.proof_count}`,
            500,
        );
    }
    return shard;
}

export function proofManifestObjectKey(config: {
    allowlistVersion: number;
    geoResolution: number;
}): string {
    return `residence-cells/v${config.allowlistVersion}/res${config.geoResolution}/proofs/proof_manifest.json`;
}

async function readManifest(
    bucket: ResidenceProofR2Bucket,
    config: { allowlistVersion: number; geoResolution: number },
): Promise<ProofShardManifest> {
    const key = proofManifestObjectKey(config);
    const object = await bucket.get(key);
    if (object === null) {
        throw new ResidenceProofError(
            "proof_manifest_missing",
            `Proof manifest is missing: ${key}`,
            500,
        );
    }

    const manifest = parseProofManifestJson(await arrayBufferToText(object));
    if (manifest.allowlist_version !== config.allowlistVersion) {
        throw new ResidenceProofError(
            "proof_manifest_invalid",
            `Proof manifest allowlist_version ${manifest.allowlist_version} does not match Worker config ${config.allowlistVersion}`,
            500,
        );
    }
    if (manifest.geo_resolution !== config.geoResolution) {
        throw new ResidenceProofError(
            "proof_manifest_invalid",
            `Proof manifest geo_resolution ${manifest.geo_resolution} does not match Worker config ${config.geoResolution}`,
            500,
        );
    }
    return manifest;
}

async function arrayBufferToText(object: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string> {
    return new TextDecoder().decode(await object.arrayBuffer());
}

async function gunzipJsonBytes(bytes: Uint8Array): Promise<string> {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const stream = new Response(buffer).body;
    if (stream === null) {
        throw new Error("proof shard response body is empty");
    }
    try {
        return await new Response(stream.pipeThrough(new DecompressionStream("gzip"))).text();
    } catch {
        throw new ResidenceProofError("proof_shard_invalid", "Proof shard gzip is invalid", 500);
    }
}

function parseProofManifestJson(json: string): ProofShardManifest {
    try {
        return parseProofShardManifest(JSON.parse(json) as unknown);
    } catch {
        throw new ResidenceProofError("proof_manifest_invalid", "Proof manifest is invalid", 500);
    }
}

function parseProofShardJson(
    json: string,
    inventory: ProofShardInventoryEntry,
    manifest: ProofShardManifest,
): ProofShard {
    try {
        return parseProofShard(JSON.parse(json) as unknown, {
            allowlistVersion: manifest.allowlist_version,
            geoResolution: manifest.geo_resolution,
            merkleRoot: manifest.merkle_root,
            shardId: inventory.shard_id,
            shardCount: manifest.shard_count,
        });
    } catch {
        throw new ResidenceProofError("proof_shard_invalid", "Proof shard is invalid", 500);
    }
}
