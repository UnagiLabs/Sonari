/**
 * register.ts
 *
 * POST /events/:event_uid/revisions/:event_revision/affected-cells
 *
 * 処理順（fail-closed: どれか1つでも不一致なら proof を生成・保存しない）:
 * 1. token 認証
 * 2. body の境界検証
 * 3. 三者一致検証（path × body × file の event_uid/event_revision）
 * 4. Walrus 取得
 * 5. bytes の SHA-256 再計算 → affected_cells_hash と照合
 * 6. parseAffectedCellsFile で schema 検証
 * 7. affectedCellsRoot で root 再計算 → affected_cells_root と照合
 * 8. 一致時のみ proof を生成し R2 に put
 * 9. 冪等: 同 event/revision・同 root なら 200 no-op、root 不一致は fail-closed
 */

import {
    type AffectedCellsInput,
    affectedCellLeavesFromInput,
    affectedCellLeafHash,
    affectedCellsRoot,
    buildProofEntries,
    buildProofShardGroups,
    parseAffectedCellsFile,
    proofShardId,
    sha256Hex,
} from "@sonari/proof-core";
import { verifyRegisterToken } from "./auth.js";
import { AffectedCellsProofError } from "./errors.js";
import type { AffectedCellsProofManifest, AffectedCellsProofShardEntry } from "./proof_artifacts.js";
import type { AffectedProofR2Bucket } from "./r2.js";
import {
    loadProofManifest,
    manifestR2Key,
    saveProofArtifacts,
    shardR2Key,
} from "./r2.js";
import type { Env } from "./walrus.js";
import { fetchWalrusBlob } from "./walrus.js";

// ---------------------------------------------------------------------------
// Env with R2 bucket binding
// ---------------------------------------------------------------------------

export interface RegisterEnv extends Env {
    AFFECTED_PROOF_SHARDS: AffectedProofR2Bucket;
}

// ---------------------------------------------------------------------------
// Request body type (before validation)
// ---------------------------------------------------------------------------

interface RawRegisterBody {
    event_uid: unknown;
    event_revision: unknown;
    affected_cells_hash: unknown;
    affected_cells_root: unknown;
    affected_cell_count: unknown;
    geo_resolution: unknown;
    affected_cells_uri: unknown;
}

// ---------------------------------------------------------------------------
// Validated body type
// ---------------------------------------------------------------------------

interface ValidatedRegisterBody {
    event_uid: string;
    event_revision: number;
    affected_cells_hash: string;
    affected_cells_root: string;
    affected_cell_count: number;
    geo_resolution: number;
    affected_cells_uri: string;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * 登録 API ハンドラ。
 * エラーは throw ではなく Response として返す（index.ts の try/catch 二段構造に対応）。
 *
 * @param req       POST リクエスト
 * @param env       Worker 環境変数（RegisterEnv）
 * @param fetchImpl fetch 実装（テストで差し替え可能）
 */
export async function handleRegisterRequest(
    req: Request,
    env: RegisterEnv,
    fetchImpl: typeof fetch = fetch,
): Promise<Response> {
    try {
        return await handleRegisterRequestUnchecked(req, env, fetchImpl);
    } catch (error) {
        if (error instanceof AffectedCellsProofError) {
            return errorResponse(error);
        }
        return errorResponse(
            new AffectedCellsProofError("internal", "Internal error", 500),
        );
    }
}

async function handleRegisterRequestUnchecked(
    req: Request,
    env: RegisterEnv,
    fetchImpl: typeof fetch,
): Promise<Response> {
    // 1. token 認証
    await verifyRegisterToken(req, env);

    // 2. body の境界検証
    const { pathEventUid, pathEventRevision } = parsePathParams(req);
    const body = await parseRequestBody(req, env);

    // 3. 三者一致検証 (path × body)
    if (body.event_uid !== pathEventUid) {
        throw new AffectedCellsProofError(
            "invalid_request",
            `event_uid mismatch: path=${pathEventUid}, body=${body.event_uid}`,
            400,
        );
    }
    if (body.event_revision !== pathEventRevision) {
        throw new AffectedCellsProofError(
            "invalid_request",
            `event_revision mismatch: path=${pathEventRevision}, body=${body.event_revision}`,
            400,
        );
    }

    // 9. 冪等: 既存の manifest を確認
    const bucket = env.AFFECTED_PROOF_SHARDS;
    const existingManifest = await tryLoadExistingManifest(
        bucket,
        body.event_uid,
        body.event_revision,
    );
    if (existingManifest !== null) {
        if (existingManifest.affected_cells_root === body.affected_cells_root) {
            // 同一 root → 200 no-op
            return jsonResponse({
                event_uid: body.event_uid,
                event_revision: body.event_revision,
                affected_cells_root: body.affected_cells_root,
                shard_count: existingManifest.shards.length,
                stored: false,
            });
        } else {
            // root が違う → fail-closed
            throw new AffectedCellsProofError(
                "affected_cells_root_mismatch",
                `Existing manifest has different root. Cannot overwrite.`,
                409,
            );
        }
    }

    // 4. Walrus 取得
    const rawBytes = await fetchWalrusBlob(body.affected_cells_uri, env, fetchImpl);
    const bytes = new Uint8Array(rawBytes);

    // 5. SHA-256 再計算 → hash 照合
    const computedHash = await sha256Hex(bytes);
    if (computedHash !== body.affected_cells_hash) {
        throw new AffectedCellsProofError(
            "affected_cells_hash_mismatch",
            `SHA-256 mismatch: computed=${computedHash}, expected=${body.affected_cells_hash}`,
            400,
        );
    }

    // 6. parseAffectedCellsFile で schema 検証
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

    // 3b. 三者一致検証（file 内の event_uid/event_revision と path を照合）
    if (parsedInput.event_uid !== body.event_uid) {
        throw new AffectedCellsProofError(
            "affected_cells_invalid",
            `event_uid mismatch in file: file=${parsedInput.event_uid}, body=${body.event_uid}`,
            400,
        );
    }
    if (parsedInput.event_revision !== body.event_revision) {
        throw new AffectedCellsProofError(
            "affected_cells_invalid",
            `event_revision mismatch in file: file=${parsedInput.event_revision}, body=${body.event_revision}`,
            400,
        );
    }

    // 7. root 再計算 → root 照合
    const computedRoot = await affectedCellsRoot(parsedInput);
    if (computedRoot !== body.affected_cells_root) {
        throw new AffectedCellsProofError(
            "affected_cells_root_mismatch",
            `Merkle root mismatch: computed=${computedRoot}, expected=${body.affected_cells_root}`,
            400,
        );
    }

    // 8. 一致時のみ proof を生成し R2 に put
    const SHARD_COUNT = 1; // MVP 固定
    const shardGroups = await buildProofShardGroups(parsedInput, SHARD_COUNT);
    const proofEntries = await buildProofEntries(parsedInput);

    // shard entry に leaf 全フィールドを含める
    const leaves = affectedCellLeavesFromInput(parsedInput);
    const shardEntriesMap = new Map<string, AffectedCellsProofShardEntry[]>();

    // shard group ごとに entry を整理
    for (const group of shardGroups) {
        const shardKey = group.shard_id.toString();
        const entries: AffectedCellsProofShardEntry[] = [];

        for (const proofEntry of proofEntries) {
            // この entry がこの shard に属するか確認
            const entryShardId = await proofShardId(BigInt(proofEntry.h3_index), SHARD_COUNT);
            if (entryShardId !== group.shard_id) {
                continue;
            }

            // 対応する leaf を見つける
            const leaf = leaves.find((l) => l.h3_index.toString() === proofEntry.h3_index);
            if (leaf === undefined) {
                throw new AffectedCellsProofError(
                    "internal",
                    `Leaf not found for h3_index: ${proofEntry.h3_index}`,
                    500,
                );
            }

            const leafHash = await affectedCellLeafHash(leaf);

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
                leaf_hash: leafHash,
                proof: proofEntry.proof,
            });
        }

        shardEntriesMap.set(shardKey, entries);
    }

    // manifest を構築
    const manifest: AffectedCellsProofManifest = {
        schema_version: 1,
        event_uid: body.event_uid as `0x${string}`,
        event_revision: body.event_revision,
        affected_cells_uri: body.affected_cells_uri,
        affected_cells_hash: body.affected_cells_hash as `0x${string}`,
        affected_cells_root: body.affected_cells_root as `0x${string}`,
        affected_cell_count: body.affected_cell_count,
        geo_resolution: body.geo_resolution,
        shards: shardGroups.map((g) => ({
            shard_key: g.shard_id.toString(),
            r2_key: shardR2Key(body.event_uid, body.event_revision, g.shard_id.toString()),
            hash: g.sha256,
            cell_count: g.proof_count,
        })),
    };

    // R2 に保存
    await saveProofArtifacts({ bucket, manifest, shardEntriesMap });

    return jsonResponse({
        event_uid: body.event_uid,
        event_revision: body.event_revision,
        affected_cells_root: body.affected_cells_root,
        shard_count: shardGroups.length,
        stored: true,
    });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** path params を URL から取得する */
function parsePathParams(req: Request): { pathEventUid: string; pathEventRevision: number } {
    const url = new URL(req.url);
    // /events/:event_uid/revisions/:event_revision/affected-cells
    const pattern =
        /^\/events\/([^/]+)\/revisions\/(\d+)\/affected-cells\/?$/;
    const match = pattern.exec(url.pathname);
    if (match === null || match[1] === undefined || match[2] === undefined) {
        throw new AffectedCellsProofError(
            "not_found",
            `Route not found: ${url.pathname}`,
            404,
        );
    }

    const pathEventUid = match[1];
    const pathEventRevision = parseInt(match[2], 10);
    if (!Number.isInteger(pathEventRevision) || pathEventRevision < 1) {
        throw new AffectedCellsProofError(
            "invalid_request",
            `event_revision must be a positive integer, got ${match[2]}`,
            400,
        );
    }

    return { pathEventUid, pathEventRevision };
}

/** request body の境界検証 */
async function parseRequestBody(req: Request, env: RegisterEnv): Promise<ValidatedRegisterBody> {
    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        throw new AffectedCellsProofError("invalid_request", "Request body is not valid JSON", 400);
    }

    if (typeof raw !== "object" || raw === null) {
        throw new AffectedCellsProofError(
            "invalid_request",
            "Request body must be a JSON object",
            400,
        );
    }

    const body = raw as RawRegisterBody;

    // event_uid: 0x + lowercase 64 hex
    const event_uid = validatePrefixedHex32("event_uid", body.event_uid);

    // event_revision: u32 >= 1
    const event_revision = validatePositiveInteger("event_revision", body.event_revision);

    // affected_cells_hash: 0x + lowercase 64 hex
    const affected_cells_hash = validatePrefixedHex32(
        "affected_cells_hash",
        body.affected_cells_hash,
    );

    // affected_cells_root: 0x + lowercase 64 hex
    const affected_cells_root = validatePrefixedHex32(
        "affected_cells_root",
        body.affected_cells_root,
    );

    // affected_cell_count: u64 >= 1
    const affected_cell_count = validatePositiveInteger(
        "affected_cell_count",
        body.affected_cell_count,
    );

    // geo_resolution: Number(env.GEO_RESOLUTION) と一致
    const configGeoResolution = Number(env.GEO_RESOLUTION ?? "7");
    const geo_resolution = validateNonNegativeInteger("geo_resolution", body.geo_resolution);
    if (geo_resolution !== configGeoResolution) {
        throw new AffectedCellsProofError(
            "invalid_request",
            `geo_resolution mismatch: body=${geo_resolution}, config=${configGeoResolution}`,
            400,
        );
    }

    // affected_cells_uri: walrus://blob/ 形式
    const affected_cells_uri = validateWalrusUri("affected_cells_uri", body.affected_cells_uri);

    return {
        event_uid,
        event_revision,
        affected_cells_hash,
        affected_cells_root,
        affected_cell_count,
        geo_resolution,
        affected_cells_uri,
    };
}

/** 0x + lowercase 64 hex を検証 */
function validatePrefixedHex32(name: string, value: unknown): string {
    if (typeof value !== "string") {
        throw new AffectedCellsProofError(
            "invalid_request",
            `${name} must be a string`,
            400,
        );
    }
    if (!/^0x[0-9a-f]{64}$/.test(value)) {
        throw new AffectedCellsProofError(
            "invalid_request",
            `${name} must be 0x-prefixed lowercase 64-char hex, got "${value}"`,
            400,
        );
    }
    return value;
}

/** 正の整数（>= 1）を検証 */
function validatePositiveInteger(name: string, value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new AffectedCellsProofError(
            "invalid_request",
            `${name} must be a positive integer, got ${String(value)}`,
            400,
        );
    }
    return value;
}

/** 非負整数（>= 0）を検証 */
function validateNonNegativeInteger(name: string, value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new AffectedCellsProofError(
            "invalid_request",
            `${name} must be a non-negative integer, got ${String(value)}`,
            400,
        );
    }
    return value;
}

/** walrus://blob/<id> 形式を検証 */
function validateWalrusUri(name: string, value: unknown): string {
    if (typeof value !== "string") {
        throw new AffectedCellsProofError(
            "invalid_request",
            `${name} must be a string`,
            400,
        );
    }
    if (!value.startsWith("walrus://blob/")) {
        throw new AffectedCellsProofError(
            "invalid_request",
            `${name} must start with walrus://blob/, got "${value}"`,
            400,
        );
    }
    const blobId = value.slice("walrus://blob/".length);
    if (blobId.length === 0) {
        throw new AffectedCellsProofError(
            "invalid_request",
            `${name} blob ID must not be empty`,
            400,
        );
    }
    return value;
}

/** 既存 manifest を load（存在しない場合は null）。エラーは握りつぶす */
async function tryLoadExistingManifest(
    bucket: AffectedProofR2Bucket,
    eventUid: string,
    eventRevision: number,
): Promise<AffectedCellsProofManifest | null> {
    try {
        return await loadProofManifest(bucket, eventUid, eventRevision);
    } catch {
        return null;
    }
}

function errorResponse(error: AffectedCellsProofError): Response {
    return new Response(
        JSON.stringify({
            error: {
                code: error.code,
                message: error.message,
            },
        }),
        {
            status: error.status,
            headers: {
                "content-type": "application/json; charset=utf-8",
            },
        },
    );
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
        },
    });
}
