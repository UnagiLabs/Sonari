/**
 * Home 災害バナーに「受け取る」CTA を出すかどうかを決める純関数。
 * React やチェーン読み取りに依存しないため、vitest で直接テストできる。
 *
 * 出すのは「ウォレット接続済み」「MembershipPass 登録済み」「claim window が
 * 開いているキャンペーンがある」の 3 条件をすべて満たすときだけ。被災セル単位の
 * 可否（Merkle proof が必要な重い判定）はここでは扱わず、最終判定は Claim 画面に
 * 委ねる。バナーは「受け取れるかもしれない」入口に留める。
 *
 * 寄付バナーの判定（selectEmergencyBannerFromClaimCampaigns）とは責務を分け、ここに混ぜない。
 */

import type { ClaimCampaignState } from "./claim/claim-campaigns";

/** 受け取り CTA 判定の入力。判定に必要な最小限の値だけを受け取る。 */
export interface ClaimBannerCtaInput {
    /** ウォレットが接続済みか。 */
    readonly walletConnected: boolean;
    /** MembershipPass が登録済みか。 */
    readonly registered: boolean;
    /** 読み込み済みのキャンペーン一覧（claim window 判定は claimWindowOpen を使う）。 */
    readonly campaigns: readonly ClaimCampaignState[];
}

/** 受け取り CTA の表示モデル。遷移先に使う disasterEventId を持つ。 */
export interface ClaimBannerCta {
    /** 「受け取る」ボタンの遷移先 /claim/<disasterEventId> に使う災害イベント ID。 */
    readonly disasterEventId: string;
    /** 対応する campaign ID。表示中バナーとの対応確認に使う。 */
    readonly campaignId: string;
}

/**
 * 受け取り CTA を出すかを決める。3 条件をすべて満たす場合は、claim window が開いて
 * いるキャンペーンを先頭から 1 つ選んでその disasterEventId を返す。満たさない場合は null
 * を返し、バナーに受け取りボタンを出さない（fail-close）。
 */
export function selectClaimBannerCta(input: ClaimBannerCtaInput): ClaimBannerCta | null {
    if (!input.walletConnected || !input.registered) {
        return null;
    }
    const claimable = input.campaigns.find((campaign) => campaign.claimWindowOpen);
    if (claimable === undefined) {
        return null;
    }
    return { disasterEventId: claimable.disasterEventId, campaignId: claimable.campaignId };
}
