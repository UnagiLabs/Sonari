/**
 * proof_builder.ts
 *
 * Walrus bytes の検証→parse→proof 生成→R2 保存の共通コア。
 *
 * register.ts（登録 API）と http.ts（R2 miss 再生成）の両方から再利用する。
 * fail-closed: hash/root/schema のいずれか一つでも不一致なら保存しない。
 */

import {
    type AffectedCellLeaf,
    type AffectedCellsInput,
    affectedCellLeafHash,
    affectedCellLeavesFromInput,
    merkleLevelsFromLeafHashes,
    parseAffectedCellsFile,
    proofStepsFromLevels,
    sha256Hex,
} from "@sonari/proof-core";
import { AffectedCellsProofError } from "./errors.js";
import type { AffectedCellsProofManifest, AffectedCellsProofShardEntry } from "./proof_artifacts.js";
import type { AffectedProofR2Bucket } from "./r2.js";
import { saveProofArtifacts, serializeShardEntries, shardR2Key } from "./r2.js";

export interface BuildAndSaveParams {
    /** Walrus から取得した生 bytes */
    bytes: Uint8Array;
    /** 登録 metadata（manifest から参照する値） */
    eventUid: string;
    eventRevision: number;
    affectedCellsUri: string;
    affectedCellsHash: string;
    affectedCellsRoot: string;
    affectedCellCount: number;
    geoResolution: number;
    /** R2 bucket */
    bucket: AffectedProofR2Bucket;
}

export interface BuildAndSaveResult {
    manifest: AffectedCellsProofManifest;
    shardEntriesMap: Map<string, AffectedCellsProofShardEntry[]>;
}

/**
 * Walrus bytes を検証し、proof artifacts を構築して R2 に保存する。
 *
 * 処理順（fail-closed）:
 * 1. bytes の SHA-256 再計算 → affectedCellsHash と照合（不一致 → affected_cells_hash_mismatch）
 * 2. parseAffectedCellsFile で schema 検証（違反 → affected_cells_invalid）
 * 3. event_uid / event_revision の三者一致検証（file × params）
 * 4. Merkle ツリーを 1 回だけ構築し、その最上段を root として expectedRoot と照合
 *    （不一致 → affected_cells_root_mismatch）
 * 5. 全検証通過後のみ、同じツリーから各セルの proof を抽出し、
 *    shard を 1 回だけ直列化して manifest hash 計算と R2 put に使い回す
 *
 * 単一パス化（issue #316）: ツリー構築と shard 直列化をそれぞれ 1 回に統一し、
 * Cloudflare Workers の CPU 上限超過（HTTP 503）を解消する。出力（root / shard hash /
 * R2 保存バイト列）は単一パス化の前後で完全に不変。
 */

/**
 * leaf metadata と leaf_hash・proof を合成して shard entry を作る pure function。
 * h3_index は bigint のまま保持し、直列化時に decimal string 化する。
 */
function shardEntryFromLeaf(
    leaf: AffectedCellLeaf,
    leafHash: AffectedCellsProofShardEntry["leaf_hash"],
    proof: AffectedCellsProofShardEntry["proof"],
): AffectedCellsProofShardEntry {
    return {
        event_uid: leaf.event_uid,
        event_revision: leaf.event_revision,
        geo_resolution: leaf.geo_resolution,
        h3_index: leaf.h3_index,
        cell_band: leaf.cell_band,
        intensity_value: leaf.intensity_value,
        cell_metric: leaf.cell_metric,
        intensity_scale: leaf.intensity_scale,
        cells_generation_method: leaf.cells_generation_method,
        oracle_version: leaf.oracle_version,
        leaf_hash: leafHash,
        proof,
    };
}
export async function buildAndSaveProofArtifacts(
    params: BuildAndSaveParams,
): Promise<BuildAndSaveResult> {
    const {
        bytes,
        eventUid,
        eventRevision,
        affectedCellsUri,
        affectedCellsHash,
        affectedCellsRoot: expectedRoot,
        affectedCellCount,
        geoResolution,
        bucket,
    } = params;

    // 1. SHA-256 照合
    const computedHash = sha256Hex(bytes);
    if (computedHash !== affectedCellsHash) {
        throw new AffectedCellsProofError(
            "affected_cells_hash_mismatch",
            `SHA-256 mismatch: computed=${computedHash}, expected=${affectedCellsHash}`,
            400,
        );
    }

    // 2. schema 検証
    let parsedInput: AffectedCellsInput;
    try {
        const text = new TextDecoder().decode(bytes);
        parsedInput = parseAffectedCellsFile(JSON.parse(text) as unknown);
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : "affected_cells is invalid";
        throw new AffectedCellsProofError(
            "affected_cells_invalid",
            `affected_cells file is invalid: ${message}`,
            400,
        );
    }

    // 3. 三者一致検証（file 内の event_uid/event_revision と params を照合）
    if (parsedInput.event_uid !== eventUid) {
        throw new AffectedCellsProofError(
            "affected_cells_invalid",
            `event_uid mismatch in file: file=${parsedInput.event_uid}, params=${eventUid}`,
            400,
        );
    }
    if (parsedInput.event_revision !== eventRevision) {
        throw new AffectedCellsProofError(
            "affected_cells_invalid",
            `event_revision mismatch in file: file=${parsedInput.event_revision}, params=${eventRevision}`,
            400,
        );
    }

    // 4. Merkle ツリーを 1 回だけ構築し、その最上段を root として照合する。
    //    leaves（h3_index 昇順・重複検査込み）→ leaf hash → ツリーの順で 1 回ずつ計算する。
    const leaves = affectedCellLeavesFromInput(parsedInput);
    const leafHashes = leaves.map((leaf) => affectedCellLeafHash(leaf));
    const levels = merkleLevelsFromLeafHashes(leafHashes);
    const topLevel = levels[levels.length - 1];
    const computedRoot = topLevel?.[0];
    if (computedRoot === undefined) {
        throw new AffectedCellsProofError(
            "internal",
            "Merkle tree produced an empty root level",
            500,
        );
    }
    if (computedRoot !== expectedRoot) {
        throw new AffectedCellsProofError(
            "affected_cells_root_mismatch",
            `Merkle root mismatch: computed=${computedRoot}, expected=${expectedRoot}`,
            400,
        );
    }

    // 5. proof 生成（同じツリーから抽出）。
    //    SHARD_COUNT=1 のため全 leaf が単一 shard "0" に入り、leaves の昇順がそのまま
    //    shard 内順序になる（旧 buildProofShardGroups の h3_index 昇順 sort と一致）。
    const SINGLE_SHARD_KEY = "0";

    const entries: AffectedCellsProofShardEntry[] = leaves.map((leaf, i) => {
        const leafHash = leafHashes[i];
        if (leafHash === undefined) {
            throw new AffectedCellsProofError(
                "internal",
                `Leaf hash not found at index ${i}`,
                500,
            );
        }
        const proof = proofStepsFromLevels(levels, i);
        return shardEntryFromLeaf(leaf, leafHash, proof);
    });

    const shardEntriesMap = new Map<string, AffectedCellsProofShardEntry[]>([
        [SINGLE_SHARD_KEY, entries],
    ]);

    // shard を 1 回だけ直列化し、その文字列を manifest hash 計算と R2 put の両方に使い回す。
    const serializedShards = new Map<string, string>();
    for (const [shardKey, shardEntries] of shardEntriesMap) {
        serializedShards.set(shardKey, serializeShardEntries(shardEntries));
    }

    const manifest: AffectedCellsProofManifest = {
        schema_version: 1,
        event_uid: eventUid as `0x${string}`,
        event_revision: eventRevision,
        affected_cells_uri: affectedCellsUri,
        affected_cells_hash: affectedCellsHash as `0x${string}`,
        affected_cells_root: expectedRoot as `0x${string}`,
        affected_cell_count: affectedCellCount,
        geo_resolution: geoResolution,
        shards: [...shardEntriesMap.entries()].map(([shardKey, shardEntries]) => {
            // R2 put と同じ直列化済み文字列を使い回す。欠落は到達不能だが、
            // fail-closed の方針に従い空文字列で握り潰さず internal エラーにする。
            const serialized = serializedShards.get(shardKey);
            if (serialized === undefined) {
                throw new AffectedCellsProofError(
                    "internal",
                    `Serialized shard not found for shard key: ${shardKey}`,
                    500,
                );
            }
            // R2 へ保存するバイト列と同じ正規バイト列から sha256 を計算し、
            // 保存形と検証形（loadProofShard）のハッシュを一致させる。
            const hash = sha256Hex(new TextEncoder().encode(serialized));
            return {
                shard_key: shardKey,
                r2_key: shardR2Key(eventUid, eventRevision, shardKey),
                hash,
                cell_count: shardEntries.length,
            };
        }),
    };

    await saveProofArtifacts({ bucket, manifest, serializedShards });

    return { manifest, shardEntriesMap };
}
