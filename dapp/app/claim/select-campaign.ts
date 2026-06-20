import type { ClaimCampaignState } from "./claim-campaigns";

/**
 * campaigns から URL id 一致の ClaimCampaignState を返す純粋関数。
 * 見つからなければ null。
 *
 * 新しい claim 詳細 URL は disasterEventId を使う。既存の /claim/<campaignId>
 * からの遷移互換を残すため、campaignId も fallback として受け付ける。
 *
 * - 副作用なし・決定的。
 * - 返り値は ClaimCampaignState 全体（eventRevision / affectedCellsRoot 等
 *   証明・トランザクション構築で必要なフィールドを保持）。
 */
export function selectCampaignById(
    campaigns: readonly ClaimCampaignState[],
    id: string,
): ClaimCampaignState | null {
    return (
        campaigns.find((c) => c.disasterEventId === id) ??
        campaigns.find((c) => c.campaignId === id) ??
        null
    );
}
