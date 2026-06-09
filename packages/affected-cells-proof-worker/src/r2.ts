/**
 * r2.ts
 *
 * R2 保存層。
 *
 * - R2 bucket interface (get + put)
 * - event/revision 単位の key 生成
 * - manifest / shard の読み込み（整合性検証付き）
 * - manifest / shard の保存（put）
 * - isolate 内 manifest cache（WeakMap、event/revision 単位の key）
 */

import { sha256Hex } from "@sonari/proof-core";
import { AffectedCellsProofError } from "./errors.js";
import {
    type AffectedCellsManifestShardEntry,
    type AffectedCellsProofManifest,
    type AffectedCellsProofShardEntry,
    parseProofManifest,
    parseShardEntry,
} from "./proof_artifacts.js";

// ---------------------------------------------------------------------------
// R2 Bucket interface
// ---------------------------------------------------------------------------

export interface AffectedProofR2Object {
    arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * R2 bucket の最小サブセット。
 * 雛形の residence-proof-worker は get のみだが、
 * 本 worker は登録時に保存が必要なため put も定義する。
 */
export interface AffectedProofR2Bucket {
    get(key: string): Promise<AffectedProofR2Object | null>;
    put(key: string, value: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// R2 key helpers
// ---------------------------------------------------------------------------

export function manifestR2Key(eventUid: string, eventRevision: number): string {
    return `affected-proofs/events/${eventUid}/revisions/${eventRevision}/manifest.json`;
}

export function shardR2Key(
    eventUid: string,
    eventRevision: number,
    shardKey: string,
): string {
    return `affected-proofs/events/${eventUid}/revisions/${eventRevision}/shards/${shardKey}.json`;
}

// ---------------------------------------------------------------------------
// isolate 内 manifest cache（WeakMap, event/revision 単位の key）
// ---------------------------------------------------------------------------

const manifestCache = new WeakMap<
    AffectedProofR2Bucket,
    Map<string, Promise<AffectedCellsProofManifest>>
>();

function manifestCacheKey(eventUid: string, eventRevision: number): string {
    return `${eventUid}:${eventRevision}`;
}

// ---------------------------------------------------------------------------
// manifest 読み込み
// ---------------------------------------------------------------------------

export async function loadProofManifest(
    bucket: AffectedProofR2Bucket,
    eventUid: string,
    eventRevision: number,
): Promise<AffectedCellsProofManifest> {
    const cacheKey = manifestCacheKey(eventUid, eventRevision);
    let bucketCache = manifestCache.get(bucket);
    if (bucketCache === undefined) {
        bucketCache = new Map();
        manifestCache.set(bucket, bucketCache);
    }

    const cached = bucketCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    const promise = readManifest(bucket, eventUid, eventRevision).catch((error: unknown) => {
        bucketCache.delete(cacheKey);
        throw error;
    });
    bucketCache.set(cacheKey, promise);
    return promise;
}

async function readManifest(
    bucket: AffectedProofR2Bucket,
    eventUid: string,
    eventRevision: number,
): Promise<AffectedCellsProofManifest> {
    const key = manifestR2Key(eventUid, eventRevision);
    const object = await bucket.get(key);
    if (object === null) {
        throw new AffectedCellsProofError(
            "proof_manifest_missing",
            `Proof manifest is missing: ${key}`,
            500,
        );
    }

    const text = new TextDecoder().decode(await object.arrayBuffer());
    try {
        return parseProofManifest(JSON.parse(text) as unknown);
    } catch {
        throw new AffectedCellsProofError(
            "proof_manifest_invalid",
            `Proof manifest is invalid: ${key}`,
            500,
        );
    }
}

// ---------------------------------------------------------------------------
// shard 読み込み（整合性検証付き）
// ---------------------------------------------------------------------------

export async function loadProofShard(
    bucket: AffectedProofR2Bucket,
    shardEntry: AffectedCellsManifestShardEntry,
): Promise<AffectedCellsProofShardEntry[]> {
    const object = await bucket.get(shardEntry.r2_key);
    if (object === null) {
        throw new AffectedCellsProofError(
            "proof_shard_missing",
            `Proof shard is missing: ${shardEntry.r2_key}`,
            500,
        );
    }

    const text = new TextDecoder().decode(await object.arrayBuffer());
    const bytes = new TextEncoder().encode(text);

    // sha256 照合
    const digest = sha256Hex(bytes);
    if (digest !== shardEntry.hash) {
        throw new AffectedCellsProofError(
            "proof_shard_integrity_mismatch",
            `Proof shard sha256 ${digest} does not match manifest ${shardEntry.hash}`,
            500,
        );
    }

    // parse と境界検証
    try {
        const parsed = JSON.parse(text) as unknown;
        const data = parsed as { entries: unknown[] };
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            !Array.isArray((parsed as Record<string, unknown>).entries)
        ) {
            throw new Error("shard must have entries array");
        }
        return data.entries.map((e) => parseShardEntry(e));
    } catch {
        throw new AffectedCellsProofError(
            "proof_shard_invalid",
            `Proof shard is invalid: ${shardEntry.r2_key}`,
            500,
        );
    }
}

// ---------------------------------------------------------------------------
// manifest / shard 保存
// ---------------------------------------------------------------------------

/**
 * R2 保存用の shard JSON を構築する。
 * shard entry の bigint フィールド（h3_index / oracle_version）は decimal string 化。
 */
export function serializeShardEntries(entries: AffectedCellsProofShardEntry[]): string {
    const serializable = entries.map((e) => ({
        event_uid: e.event_uid,
        event_revision: e.event_revision,
        geo_resolution: e.geo_resolution,
        h3_index: e.h3_index.toString(),
        cell_band: e.cell_band,
        intensity_value: e.intensity_value,
        cell_metric: e.cell_metric,
        intensity_scale: e.intensity_scale,
        cells_generation_method: e.cells_generation_method,
        oracle_version: e.oracle_version.toString(),
        leaf_hash: e.leaf_hash,
        proof: e.proof,
    }));
    return JSON.stringify({ entries: serializable });
}

export interface SaveProofArtifactsParams {
    bucket: AffectedProofR2Bucket;
    manifest: AffectedCellsProofManifest;
    shardEntriesMap: Map<string, AffectedCellsProofShardEntry[]>;
}

/**
 * manifest と各 shard を R2 に put する。
 * isolate 内の manifest cache も更新する（同 bucket インスタンスへの後続 read でキャッシュが有効になる）。
 */
export async function saveProofArtifacts(params: SaveProofArtifactsParams): Promise<void> {
    const { bucket, manifest, shardEntriesMap } = params;

    // manifest を保存
    const mKey = manifestR2Key(manifest.event_uid, manifest.event_revision);
    await bucket.put(mKey, JSON.stringify(manifest));

    // manifest cache を更新
    const cacheKey = manifestCacheKey(manifest.event_uid, manifest.event_revision);
    let bucketCache = manifestCache.get(bucket);
    if (bucketCache === undefined) {
        bucketCache = new Map();
        manifestCache.set(bucket, bucketCache);
    }
    bucketCache.set(cacheKey, Promise.resolve(manifest));

    // 各 shard を保存
    for (const [shardKey, entries] of shardEntriesMap) {
        const sKey = shardR2Key(manifest.event_uid, manifest.event_revision, shardKey);
        await bucket.put(sKey, serializeShardEntries(entries));
    }
}
