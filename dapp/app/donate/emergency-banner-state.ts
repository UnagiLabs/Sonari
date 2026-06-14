/**
 * 緊急バナーの純関数ロジック。
 * React に依存しないため、vitest で直接テストできる。
 */

/** バナーに必要なキャンペーン情報の最小型。CampaignDestination をそのまま受け取れる。 */
export interface EmergencyBannerCampaign {
    /** キャンペーンのオブジェクト ID（寄付導線で使う） */
    readonly id: string;
    /** 表示用ラベル */
    readonly label: string;
}

/** バナーの表示モデル。 */
export interface EmergencyBannerView {
    /** キャンペーンのオブジェクト ID（onDonate コールバックへ渡す値） */
    readonly campaignId: string;
    /** バナーに表示するキャンペーン名 */
    readonly label: string;
}

/**
 * キャンペーンデータからバナーの表示モデルを生成する。
 * campaign が null（実施中キャンペーンなし）の場合は null を返す（非表示）。
 */
export function buildEmergencyBannerView(
    campaign: EmergencyBannerCampaign | null,
): EmergencyBannerView | null {
    if (campaign === null) {
        return null;
    }
    return {
        campaignId: campaign.id,
        label: campaign.label,
    };
}
