// ---------------------------------------------------------------------------
// ClaimCampaignAdapter: ClaimCampaignState → DisasterClaimableProgram 変換アダプタ
//
// 本番チェーンから読んだ ClaimCampaignState をカタログ共通の
// DisasterClaimableProgram へ変換する純粋関数群。
//
// 設計方針:
// - 副作用なし・決定的・pure function
// - 無効値は fail-closed で null を返す（severityBand 範囲外、affectedCellCount 非整数など）
// - 契約値（eventUid / affectedCellsRoot）は再検証しない（表示・受け渡し用のみ）
// - cellSource は常に { kind: "deferred" }（セル取得ワーカーは後続 issue でつなぐ）
// - amountSummary は表示用デモ値（bandAmount）を使った range
// ---------------------------------------------------------------------------

import { type CellBand, parseCellBand, bandAmount } from "./cell-band-rules";
import type { DisasterClaimableProgram } from "./claimable-program";
import type { ClaimCampaignState } from "../claim-campaigns";
import { affectedAreaArtifactFromBaseUrl } from "../affected-area/affected-area-artifact";

// ---------------------------------------------------------------------------
// affectedCellCount のパース
//
// ClaimCampaignState.affectedCellCount は u64 の 10 進文字列。
// number に変換して Number.isSafeInteger で安全な整数かを検証する。
// 安全整数範囲（0 ≤ n ≤ 2^53 - 1）を超える値は fail-closed で null。
// ---------------------------------------------------------------------------

function parseAffectedCellCount(value: string): number | null {
    // 10 進非負整数文字列のみ受け付ける
    if (!/^(0|[1-9]\d*)$/u.test(value.trim())) {
        return null;
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
        return null;
    }
    return n;
}

// ---------------------------------------------------------------------------
// claimCampaignToProgram
// ---------------------------------------------------------------------------

/**
 * `ClaimCampaignState` を `DisasterClaimableProgram` へ変換する。
 *
 * 変換不能な場合（severityBand が無効、affectedCellCount が不正整数など）は
 * fail-closed で `null` を返す。
 *
 * フィールド対応:
 * - `id`               = `disasterEventId`
 * - `category`         = `"disaster"`（固定）
 * - `title`            = `title`
 * - `scope`            = `region`
 * - `deadlineMs`       = `claimEndMs`
 * - `detailHref`       = `/claim/<disasterEventId>`（本番詳細ルート）
 * - `eventUid`         = `eventUid`（契約値・再検証なし）
 * - `severityBand`     = `parseCellBand(severityBand)`（無効なら null・fail-closed）
 * - `affectedCellCount`= `affectedCellCount`（u64 文字列 → number・非整数は null）
 * - `cellSource`       = `{ kind: "deferred" }`（後続 issue でワーカー取得をつなぐ）
 * - `affectedCellsRoot`= `affectedCellsRoot`（契約値・再検証なし）
 * - `amountSummary`    = `{ kind: "range", minUsdc: bandAmount(1), maxUsdc: bandAmount(severityBand) }`
 *                        （金額は表示用のデモ値、バンドは実値）
 */
export function claimCampaignToProgram(
    state: ClaimCampaignState,
): DisasterClaimableProgram | null {
    // severityBand: 無効（0 や 4 以上、小数）は fail-closed
    const severityBand: CellBand | null = parseCellBand(state.severityBand);
    if (severityBand === null) {
        return null;
    }

    // affectedCellCount: u64 文字列 → number（非整数・範囲外は fail-closed）
    const affectedCellCount = parseAffectedCellCount(state.affectedCellCount);
    if (affectedCellCount === null) {
        return null;
    }

    const affectedAreaArtifact = affectedAreaArtifactFromBaseUrl(
        process.env.NEXT_PUBLIC_SONARI_AFFECTED_AREA_BASE_URL,
        {
            eventUid: state.eventUid,
            eventRevision: state.eventRevision,
        },
    );

    return {
        id: state.disasterEventId,
        category: "disaster",
        title: state.title,
        scope: state.region,
        // amountSummary: 表示用のデモ値（bandAmount）を使った range
        // min=Band1（最低帯）固定、max=実際の severityBand に対応する額
        amountSummary: {
            kind: "range",
            minUsdc: bandAmount(1),
            maxUsdc: bandAmount(severityBand),
        },
        deadlineMs: state.claimEndMs,
        detailHref: `/claim/${state.disasterEventId}`,
        eventUid: state.eventUid,
        eventRevision: state.eventRevision,
        severityBand,
        affectedCellCount,
        // cellSource は後続 issue でワーカー取得をつなぐまで常に deferred
        cellSource: { kind: "deferred" },
        ...(affectedAreaArtifact !== null ? { affectedAreaArtifact } : {}),
        // affectedCellsRoot は表示・受け渡し用のみ。検証ロジックは持たない
        affectedCellsRoot: state.affectedCellsRoot,
    };
}

// ---------------------------------------------------------------------------
// claimCampaignsToPrograms（複数件一括変換・null 除外）
// ---------------------------------------------------------------------------

/**
 * `ClaimCampaignState` の配列を `DisasterClaimableProgram[]` へ一括変換する。
 * 変換不能なエントリ（`claimCampaignToProgram` が `null` を返すもの）は除外する。
 */
export function claimCampaignsToPrograms(
    states: readonly ClaimCampaignState[],
): DisasterClaimableProgram[] {
    const results: DisasterClaimableProgram[] = [];
    for (const state of states) {
        const program = claimCampaignToProgram(state);
        if (program !== null) {
            results.push(program);
        }
    }
    return results;
}
