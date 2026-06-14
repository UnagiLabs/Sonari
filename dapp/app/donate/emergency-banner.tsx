"use client";

import { useTranslations } from "next-intl";
import { buildEmergencyBannerView, type EmergencyBannerCampaign } from "./emergency-banner-state";

export interface EmergencyBannerProps {
    /** 実施中のキャンペーン。null の場合はバナーを表示しない。 */
    readonly campaign: EmergencyBannerCampaign | null;
    /** 「寄付する」ボタン押下時のコールバック。campaignId はキャンペーンのオブジェクト ID。 */
    readonly onDonate: (campaignId: string) => void;
}

/**
 * 緊急キャンペーンバナー。
 * campaign が null のときは何も描かない（null を返す）。
 * 描画テスト基盤が無いため、表示ロジックは buildEmergencyBannerView に分離して
 * pure function として vitest でテストする。
 */
export function EmergencyBanner({ campaign, onDonate }: EmergencyBannerProps): React.ReactNode {
    const t = useTranslations("donate.emergency");
    const view = buildEmergencyBannerView(campaign);

    if (view === null) {
        return null;
    }

    return (
        <div className="donate-emergency-banner" role="alert">
            <div className="donate-emergency-banner-header">
                <span className="donate-emergency-banner-tag">{t("tag")}</span>
                {view.status !== undefined ? (
                    <span className="donate-emergency-banner-status">{view.status}</span>
                ) : null}
                <h2 className="donate-emergency-banner-title">{t("title")}</h2>
            </div>
            <p className="donate-emergency-banner-body">{t("body", { name: view.label })}</p>
            {view.details !== undefined && view.details.length > 0 ? (
                <dl className="donate-emergency-banner-details">
                    {view.details.map((detail) => (
                        <div className="donate-emergency-banner-detail" key={detail.label}>
                            <dt>{detail.label}</dt>
                            <dd>{detail.value}</dd>
                        </div>
                    ))}
                </dl>
            ) : null}
            <button
                type="button"
                className="donate-emergency-banner-cta btn"
                onClick={() => {
                    onDonate(view.campaignId);
                }}
            >
                {t("cta")}
            </button>
        </div>
    );
}
