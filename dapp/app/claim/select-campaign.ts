import type { ClaimCampaignState } from "./claim-campaigns";

/**
 * campaigns から campaignId 一致の ClaimCampaignState を返す純粋関数。
 * 見つからなければ null。
 *
 * - 副作用なし・決定的。
 * - 返り値は ClaimCampaignState 全体（eventRevision / affectedCellsRoot 等
 *   証明・トランザクション構築で必要なフィールドを保持）。
 */
export function selectCampaignById(
    campaigns: readonly ClaimCampaignState[],
    campaignId: string,
): ClaimCampaignState | null {
    return campaigns.find((c) => c.campaignId === campaignId) ?? null;
}
