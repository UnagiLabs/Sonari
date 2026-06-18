/**
 * 緊急バナーの純関数ロジック。
 * React に依存しないため、vitest で直接テストできる。
 */

/** バナー概要リストの1項目。label/value は表示用文字列を受け取る。label "M" はマグニチュードを表す。 */
export interface EmergencyBannerDetail {
    readonly label: string;
    readonly value: string;
}

/** バナーに必要なキャンペーン情報の最小型。CampaignDestination をそのまま受け取れる。 */
export interface EmergencyBannerCampaign {
    /** キャンペーンのオブジェクト ID（寄付導線で使う） */
    readonly id: string;
    /** 表示用ラベル */
    readonly label: string;
    /** 任意。実施中などのステータス表示文言（ローカライズ済み）。未指定なら非表示。 */
    readonly status?: string;
    /** 任意。概要リスト（マグニチュード・地域など）。未指定/空なら非表示。 */
    readonly details?: readonly EmergencyBannerDetail[];
}

/** バナーの表示モデル。 */
export interface EmergencyBannerView {
    /** キャンペーンのオブジェクト ID（onDonate コールバックへ渡す値） */
    readonly campaignId: string;
    /** バナーに表示するキャンペーン名 */
    readonly label: string;
    /** 任意。実施中などのステータス表示文言。未指定なら非表示。 */
    readonly status?: string;
    /** 任意。SIGNAL デザインのマグニチュード専用チップ表示。未指定なら非表示。 */
    readonly magnitude?: EmergencyBannerDetail;
    /** 任意。概要リスト。未指定/空なら非表示。 */
    readonly details?: readonly EmergencyBannerDetail[];
}

const MAGNITUDE_PREFIX_PATTERN = /^M\s*([0-9]+(?:\.[0-9]+)?)(?=\b|\s|-)/i;

function extractMagnitudeFromLabel(label: string): EmergencyBannerDetail | undefined {
    const match = MAGNITUDE_PREFIX_PATTERN.exec(label.trim());
    if (match === null) {
        return undefined;
    }
    const value = match[1];
    if (value === undefined) {
        return undefined;
    }
    return { label: "M", value };
}

/**
 * キャンペーンデータからバナーの表示モデルを生成する。
 * campaign が null（実施中キャンペーンなし）の場合は null を返す（非表示）。
 * status/details/magnitude が未指定の場合はキー自体を含めない（後方互換）。
 */
export function buildEmergencyBannerView(
    campaign: EmergencyBannerCampaign | null,
): EmergencyBannerView | null {
    if (campaign === null) {
        return null;
    }
    const magnitude =
        campaign.details?.find((detail) => detail.label === "M") ??
        extractMagnitudeFromLabel(campaign.label);
    return {
        campaignId: campaign.id,
        label: campaign.label,
        ...(campaign.status !== undefined ? { status: campaign.status } : {}),
        ...(campaign.details !== undefined && campaign.details.length > 0
            ? { details: campaign.details }
            : {}),
        ...(magnitude !== undefined ? { magnitude } : {}),
    };
}
