import { AffectedCellsProofError } from "./errors.js";
import type { AuthEnv } from "./auth.js";

/**
 * Cloudflare Worker の環境変数バインディング型。
 * 後続 STEP（register/http/index）でフィールドを追加していく共通 Env 型。
 * AuthEnv を intersection で取り込み、token 認証フィールドを含む。
 */
export interface Env extends AuthEnv {
    WALRUS_AGGREGATOR_URL?: string;
}

/**
 * `walrus://blob/<id>` URI を `${WALRUS_AGGREGATOR_URL}/v1/blobs/<id>` に解決し、
 * HTTP GET で bytes（ArrayBuffer）を取得して返す。
 *
 * fail-closed:
 * - WALRUS_AGGREGATOR_URL 未設定/空 → walrus_fetch_failed
 * - URI 形式不正（walrus://blob/<id> 以外）→ invalid_request
 * - 非 200 レスポンス → walrus_fetch_failed
 * - fetch 例外 → walrus_fetch_failed
 *
 * @param uri         `walrus://blob/<id>` 形式の URI
 * @param env         Worker 環境変数（WALRUS_AGGREGATOR_URL を参照）
 * @param fetchImpl   fetch 実装（デフォルト: グローバル fetch）。テストで差し替え可能
 */
export async function fetchWalrusBlob(
    uri: string,
    env: Env,
    fetchImpl: typeof fetch = fetch,
): Promise<ArrayBuffer> {
    // 1. WALRUS_AGGREGATOR_URL 検証
    const aggregatorUrl = env.WALRUS_AGGREGATOR_URL;
    if (!aggregatorUrl) {
        throw new AffectedCellsProofError(
            "walrus_fetch_failed",
            "WALRUS_AGGREGATOR_URL is not configured",
            500,
        );
    }

    // 2. URI パース: `walrus://blob/<id>` のみ受理
    const blobId = parseWalrusBlobUri(uri);

    // 3. fetch 実行
    const targetUrl = `${aggregatorUrl}/v1/blobs/${blobId}`;
    let response: Response;
    try {
        response = await fetchImpl(targetUrl);
    } catch (cause) {
        const message =
            cause instanceof Error
                ? `Walrus fetch failed: ${cause.message}`
                : "Walrus fetch failed";
        throw new AffectedCellsProofError("walrus_fetch_failed", message, 502);
    }

    // 4. レスポンスステータス検証
    if (!response.ok) {
        throw new AffectedCellsProofError(
            "walrus_fetch_failed",
            `Walrus aggregator returned HTTP ${response.status} for blob ${blobId}`,
            502,
        );
    }

    return response.arrayBuffer();
}

/**
 * `walrus://blob/<id>` 形式を検証し、blob ID を返す。
 * 形式が不正な場合は `invalid_request` エラーを throw する。
 */
function parseWalrusBlobUri(uri: string): string {
    const PREFIX = "walrus://blob/";
    if (!uri.startsWith(PREFIX)) {
        throw new AffectedCellsProofError(
            "invalid_request",
            `Invalid Walrus URI: expected walrus://blob/<id>, got "${uri}"`,
            400,
        );
    }

    const blobId = uri.slice(PREFIX.length);
    if (blobId.length === 0) {
        throw new AffectedCellsProofError(
            "invalid_request",
            "Invalid Walrus URI: blob ID must not be empty",
            400,
        );
    }

    return blobId;
}
