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
    affectedCellLeavesFromInput,
    affectedCellsRoot,
    buildProofShardGroups,
    parseAffectedCellsFile,
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
 * 4. affectedCellsRoot で root 再計算 → affectedCellsRoot と照合（不一致 → affected_cells_root_mismatch）
 * 5. 全検証通過後のみ proof を生成し R2 に put
 */
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

    // 4. root 照合
    const computedRoot = affectedCellsRoot(parsedInput);
    if (computedRoot !== expectedRoot) {
        throw new AffectedCellsProofError(
            "affected_cells_root_mismatch",
            `Merkle root mismatch: computed=${computedRoot}, expected=${expectedRoot}`,
            400,
        );
    }

    // 5. proof 生成
    const SHARD_COUNT = 1;
    const shardGroups = buildProofShardGroups(parsedInput, SHARD_COUNT);

    // Map<h3_index string, AffectedCellLeaf> を 1 回だけ構築して O(n) lookup に変換
    const leafMap = new Map<string, AffectedCellLeaf>();
    for (const leaf of affectedCellLeavesFromInput(parsedInput)) {
        leafMap.set(leaf.h3_index.toString(), leaf);
    }

    const shardEntriesMap = new Map<string, AffectedCellsProofShardEntry[]>();

    for (const group of shardGroups) {
        const shardKey = group.shard_id.toString();
        const entries: AffectedCellsProofShardEntry[] = [];

        // group.proofs は buildProofShardGroups 内で h3_index 昇順 sort 済み
        for (const proofEntry of group.proofs) {
            const leaf = leafMap.get(proofEntry.h3_index);
            if (leaf === undefined) {
                throw new AffectedCellsProofError(
                    "internal",
                    `Leaf not found for h3_index: ${proofEntry.h3_index}`,
                    500,
                );
            }

            entries.push({
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
                leaf_hash: proofEntry.leaf_hash,
                proof: proofEntry.proof,
            });
        }

        shardEntriesMap.set(shardKey, entries);
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
        shards: shardGroups.map((g) => {
            const shardKey = g.shard_id.toString();
            const entries = shardEntriesMap.get(shardKey) ?? [];
            // R2 へ保存するバイト列と同じ正規バイト列から sha256 を計算し、
            // 保存形と検証形（loadProofShard）のハッシュを一致させる。
            const hash = sha256Hex(new TextEncoder().encode(serializeShardEntries(entries)));
            return {
                shard_key: shardKey,
                r2_key: shardR2Key(eventUid, eventRevision, shardKey),
                hash,
                cell_count: g.proof_count,
            };
        }),
    };

    await saveProofArtifacts({ bucket, manifest, shardEntriesMap });

    return { manifest, shardEntriesMap };
}
