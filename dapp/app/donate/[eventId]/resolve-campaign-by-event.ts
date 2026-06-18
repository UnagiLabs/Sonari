// ---------------------------------------------------------------------------
// resolveCampaignByEvent
//
// 指定した disasterEventId に対応する ClaimCampaignState を決定的に 1 件選ぶ純粋関数。
//
// 選択基準:
//  1. disasterEventId が一致するものを絞り込む
//  2. donationEndMs 降順（最新の受付終了が先）
//  3. 同値のとき campaignId 昇順（安定・決定的）
//
// これは STEP2 buildDisasterPoolViews の並び順と整合する選択基準。
// ---------------------------------------------------------------------------

import type { ClaimCampaignState } from "../../claim/claim-campaigns";

/**
 * campaigns から disasterEventId が一致する Campaign を決定的に 1 件選ぶ。
 *
 * - 見つからなければ null を返す。
 * - 複数一致時: donationEndMs 降順、同値は campaignId 昇順で先頭を選ぶ。
 * - 副作用なし・決定的・pure function。入力配列を変更しない。
 */
export function resolveCampaignByEvent(
    campaigns: readonly ClaimCampaignState[],
    eventId: string,
): ClaimCampaignState | null {
    const matched = campaigns.filter((c) => c.disasterEventId === eventId);
    if (matched.length === 0) {
        return null;
    }
    if (matched.length === 1) {
        return matched[0] ?? null;
    }

    // 複数一致時: donationEndMs 降順、同値は campaignId 昇順
    const sorted = [...matched].sort(compareCampaigns);
    return sorted[0] ?? null;
}

function compareCampaigns(a: ClaimCampaignState, b: ClaimCampaignState): number {
    const endA = parseMsString(a.donationEndMs);
    const endB = parseMsString(b.donationEndMs);
    // donationEndMs 降順
    if (endB !== endA) {
        return endB - endA;
    }
    // 同値は campaignId 昇順
    if (a.campaignId < b.campaignId) return -1;
    if (a.campaignId > b.campaignId) return 1;
    return 0;
}

function parseMsString(value: string): number {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
