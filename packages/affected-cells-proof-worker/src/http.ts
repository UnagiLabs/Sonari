/**
 * http.ts
 *
 * GET /events/:event_uid/revisions/:event_revision/proof?h3_index=...
 *
 * 処理順（配信前再検証必須・fail-closed）:
 * 1. parseH3Index で h3_index 検証（不正 → 400 invalid_request）
 * 2. R2 から manifest を load（missing → 404 proof_manifest_missing）
 * 3. proofShardId で shard を決定 → loadProofShard で shard を load
 *    （shard missing/integrity_mismatch → R2 miss フォールバックへ）
 * 4. findShardEntry で対象 h3_index の entry を検索（無し → 404 affected_cell_not_in_event）
 * 5. 配信前二重検証:
 *    a. affectedCellLeafHash で leaf_hash を独立再計算 → entry.leaf_hash と照合
 *    b. replayProof(leaf_hash, proof) → manifest.affected_cells_root に到達するか確認
 *    不一致 → 500 proof_shard_invalid（fail-closed）
 * 6. shapeProofResponse で配信レスポンスを組み立て 200 を返す
 */

import {
    affectedCellLeafHash,
    parseH3Index,
    proofShardId,
    replayProof,
} from "@sonari/proof-core";
import { AffectedCellsProofError, errorResponse } from "./errors.js";
import type { AffectedCellsProofManifest, AffectedCellsProofShardEntry } from "./proof_artifacts.js";
import {
    findShardEntry,
    shapeProofResponse,
} from "./proof_artifacts.js";
import { buildAndSaveProofArtifacts } from "./proof_builder.js";
import type { RegisterEnv } from "./register.js";
import {
    loadProofManifest,
    loadProofShard,
} from "./r2.js";
import { fetchWalrusBlob } from "./walrus.js";

// GEO_RESOLUTION のデフォルト値
const DEFAULT_GEO_RESOLUTION = 7;

// ---------------------------------------------------------------------------
// Main handler (公開 API)
// ---------------------------------------------------------------------------

/**
 * 配信 API ハンドラ。
 * エラーは throw せず Response として返す（index.ts の try/catch 二段構造に対応）。
 *
 * @param req       GET リクエスト
 * @param env       Worker 環境変数
 * @param fetchImpl fetch 実装（テストで差し替え可能）
 */
export async function handleProofRequest(
    req: Request,
    env: RegisterEnv,
    fetchImpl: typeof fetch = fetch,
): Promise<Response> {
    try {
        return await handleProofRequestUnchecked(req, env, fetchImpl);
    } catch (error) {
        if (error instanceof AffectedCellsProofError) {
            return errorResponse(error);
        }
        return errorResponse(
            new AffectedCellsProofError("internal", "Internal error", 500),
        );
    }
}

async function handleProofRequestUnchecked(
    req: Request,
    env: RegisterEnv,
    fetchImpl: typeof fetch,
): Promise<Response> {
    // 1. URL パース: event_uid / event_revision / h3_index を取得
    const { eventUid, eventRevision, h3IndexStr } = parseRequestParams(req);

    // 1b. h3_index を parseH3Index で検証（resolution チェック込み）
    const geoResolution = Number(env.GEO_RESOLUTION ?? DEFAULT_GEO_RESOLUTION.toString());
    let parsedH3Index: { value: bigint };
    try {
        parsedH3Index = parseH3Index(h3IndexStr, geoResolution);
    } catch (cause) {
        const msg = cause instanceof Error ? cause.message : "invalid h3_index";
        throw new AffectedCellsProofError("invalid_request", `Invalid h3_index: ${msg}`, 400);
    }

    const h3IndexBigInt = parsedH3Index.value;

    // 2. R2 から manifest を load
    let manifest: AffectedCellsProofManifest;
    try {
        manifest = await loadProofManifest(env.AFFECTED_PROOF_SHARDS, eventUid, eventRevision);
    } catch (error) {
        if (
            error instanceof AffectedCellsProofError &&
            error.code === "proof_manifest_missing"
        ) {
            // manifest が存在しない → 404（再生成不可: URI 不明）
            throw new AffectedCellsProofError(
                "proof_manifest_missing",
                `Proof manifest not found for event ${eventUid} revision ${eventRevision}`,
                404,
            );
        }
        throw error;
    }

    // 3. shard を決定して load（miss の場合は再生成フォールバックへ）
    const SHARD_COUNT = 1;
    const shardId = await proofShardId(h3IndexBigInt, SHARD_COUNT);
    const shardEntry = manifest.shards.find((s) => s.shard_key === shardId.toString());

    const entries: AffectedCellsProofShardEntry[] = await loadShardEntries(
        manifest,
        shardEntry,
        env,
        fetchImpl,
        shardId,
    );

    // 4. findShardEntry で対象 h3_index の entry を検索
    const entry = findShardEntry(entries, h3IndexBigInt);
    if (entry === null) {
        throw new AffectedCellsProofError(
            "affected_cell_not_in_event",
            `h3_index ${h3IndexStr} is not in event ${eventUid} revision ${eventRevision}`,
            404,
        );
    }

    // 5. 配信前二重検証（fail-closed）
    await verifyEntryIntegrity(entry, manifest.affected_cells_root);

    // 6. shapeProofResponse で配信レスポンスを組み立て
    const responseBody = shapeProofResponse(entry, manifest);

    return jsonResponse(serializeResponse(responseBody));
}

// ---------------------------------------------------------------------------
// R2 miss 再生成
// ---------------------------------------------------------------------------

/**
 * manifest の affected_cells_uri から Walrus を再取得し、
 * hash/root を再検証した上で proof を再生成・保存する（fail-closed）。
 *
 * 再取得 bytes の hash が manifest.affected_cells_hash と一致し、
 * 再計算 root が manifest.affected_cells_root と一致した場合のみ再生成する。
 * 不一致は fail-closed でエラーを throw する。
 */
async function regenerateFromWalrus(
    manifest: AffectedCellsProofManifest,
    env: RegisterEnv,
    fetchImpl: typeof fetch,
    targetShardId: number,
): Promise<AffectedCellsProofShardEntry[]> {
    // Walrus から再取得
    const rawBytes = await fetchWalrusBlob(manifest.affected_cells_uri, env, fetchImpl);
    const bytes = new Uint8Array(rawBytes);

    // proof_builder で hash/root 再検証 → proof 再生成 → R2 保存
    // fail-closed: hash/root 不一致なら buildAndSaveProofArtifacts が throw する
    const { shardEntriesMap } = await buildAndSaveProofArtifacts({
        bytes,
        eventUid: manifest.event_uid,
        eventRevision: manifest.event_revision,
        affectedCellsUri: manifest.affected_cells_uri,
        affectedCellsHash: manifest.affected_cells_hash,
        affectedCellsRoot: manifest.affected_cells_root,
        affectedCellCount: manifest.affected_cell_count,
        geoResolution: manifest.geo_resolution,
        bucket: env.AFFECTED_PROOF_SHARDS,
    });

    return shardEntriesMap.get(targetShardId.toString()) ?? [];
}

// ---------------------------------------------------------------------------
// Shard loading with R2 miss fallback
// ---------------------------------------------------------------------------

/**
 * shard を load する。miss/壊れた場合は R2 miss フォールバックで再生成する。
 */
async function loadShardEntries(
    manifest: AffectedCellsProofManifest,
    shardEntry: AffectedCellsProofManifest["shards"][number] | undefined,
    env: RegisterEnv,
    fetchImpl: typeof fetch,
    targetShardId: number,
): Promise<AffectedCellsProofShardEntry[]> {
    if (shardEntry === undefined) {
        return regenerateFromWalrus(manifest, env, fetchImpl, targetShardId);
    }

    try {
        return await loadProofShard(env.AFFECTED_PROOF_SHARDS, shardEntry);
    } catch (error) {
        if (
            error instanceof AffectedCellsProofError &&
            (error.code === "proof_shard_missing" ||
                error.code === "proof_shard_integrity_mismatch" ||
                error.code === "proof_shard_invalid")
        ) {
            return regenerateFromWalrus(manifest, env, fetchImpl, targetShardId);
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** URL から event_uid / event_revision / h3_index を取得 */
function parseRequestParams(
    req: Request,
): { eventUid: string; eventRevision: number; h3IndexStr: string } {
    const url = new URL(req.url);
    const pattern = /^\/events\/([^/]+)\/revisions\/(\d+)\/proof\/?$/;
    const match = pattern.exec(url.pathname);
    if (match === null || match[1] === undefined || match[2] === undefined) {
        throw new AffectedCellsProofError(
            "not_found",
            `Route not found: ${url.pathname}`,
            404,
        );
    }

    const eventUid = match[1];
    const eventRevision = parseInt(match[2], 10);
    if (!Number.isInteger(eventRevision) || eventRevision < 1) {
        throw new AffectedCellsProofError(
            "invalid_request",
            `event_revision must be a positive integer, got ${match[2]}`,
            400,
        );
    }

    const h3IndexStr = url.searchParams.get("h3_index") ?? "";
    if (h3IndexStr === "") {
        throw new AffectedCellsProofError(
            "invalid_request",
            "h3_index query parameter is required",
            400,
        );
    }

    return { eventUid, eventRevision, h3IndexStr };
}

/**
 * entry の leaf_hash 独立再計算 + replayProof で root 到達を検証する。
 * 不一致の場合は fail-closed（proof_shard_invalid）。
 */
async function verifyEntryIntegrity(
    entry: AffectedCellsProofShardEntry,
    expectedRoot: string,
): Promise<void> {
    // a. leaf_hash 独立再計算（AffectedCellLeaf の全フィールドから hash を再計算）
    const recomputedLeafHash = await affectedCellLeafHash(entry);
    if (recomputedLeafHash !== entry.leaf_hash) {
        throw new AffectedCellsProofError(
            "proof_shard_invalid",
            `leaf_hash mismatch: computed=${recomputedLeafHash}, stored=${entry.leaf_hash}`,
            500,
        );
    }

    // b. replayProof で root 到達検証
    const replayedRoot = await replayProof(entry.leaf_hash, entry.proof);
    if (replayedRoot !== expectedRoot) {
        throw new AffectedCellsProofError(
            "proof_shard_invalid",
            `proof replay root mismatch: replayed=${replayedRoot}, expected=${expectedRoot}`,
            500,
        );
    }
}

/**
 * 配信レスポンス（bigint フィールドを decimal string に変換して JSON 互換にする）
 */
function serializeResponse(response: ReturnType<typeof shapeProofResponse>): unknown {
    return {
        event_uid: response.event_uid,
        event_revision: response.event_revision,
        h3_index: response.h3_index, // already decimal string
        affected_cells_root: response.affected_cells_root,
        leaf: {
            event_uid: response.leaf.event_uid,
            event_revision: response.leaf.event_revision,
            h3_index: response.leaf.h3_index.toString(),
            geo_resolution: response.leaf.geo_resolution,
            cell_band: response.leaf.cell_band,
            intensity_value: response.leaf.intensity_value,
            cell_metric: response.leaf.cell_metric,
            intensity_scale: response.leaf.intensity_scale,
            cells_generation_method: response.leaf.cells_generation_method,
            oracle_version: response.leaf.oracle_version.toString(),
        },
        proof: response.proof,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
        },
    });
}
