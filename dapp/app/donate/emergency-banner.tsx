"use client";

import { useTranslations } from "next-intl";
import { buildEmergencyBannerView, type EmergencyBannerCampaign } from "./emergency-banner-state";

export interface EmergencyBannerProps {
    /** 実施中のキャンペーン。null の場合はバナーを表示しない。 */
    readonly campaign: EmergencyBannerCampaign | null;
    /** 「寄付する」ボタン押下時のコールバック。campaignId はキャンペーンのオブジェクト ID。 */
    readonly onDonate: (campaignId: string) => void;
    /**
     * 任意。指定すると寄付ボタンの前に主ボタンとしてリンクを表示する（例: 受け取る導線）。
     * バナーを 1 枠に保ったまま、見ている人に合わせたアクションを足すために使う。出すか
     * どうかの判定は呼び出し側が行い、このコンポーネントは渡された内容を描くだけにする。
     */
    readonly primaryAction?: { readonly href: string; readonly label: string };
}

/**
 * 緊急キャンペーンバナー。
 * campaign が null のときは何も描かない（null を返す）。
 * 描画テスト基盤が無いため、表示ロジックは buildEmergencyBannerView に分離して
 * pure function として vitest でテストする。
 */
export function EmergencyBanner({
    campaign,
    onDonate,
    primaryAction,
}: EmergencyBannerProps): React.ReactNode {
    const t = useTranslations("donate.emergency");
    const view = buildEmergencyBannerView(campaign);

    if (view === null) {
        return null;
    }

    const bannerClassName =
        view.magnitude !== undefined
            ? "donate-emergency-banner donate-emergency-banner--with-magnitude"
            : "donate-emergency-banner";

    return (
        <div className={bannerClassName} role="alert">
            <div className="donate-emergency-banner-rail" aria-hidden="true" />
            {view.magnitude !== undefined ? (
                <dl className="donate-emergency-banner-magnitude">
                    <div>
                        <dt>{t("magnitudeLabel")}</dt>
                        <dd>
                            <span aria-hidden="true">M</span>
                            {view.magnitude.value}
                        </dd>
                    </div>
                </dl>
            ) : null}
            <div className="donate-emergency-banner-content">
                <div className="donate-emergency-banner-header">
                    <span className="donate-emergency-banner-tag">{t("tag")}</span>
                    <span className="donate-emergency-banner-live">
                        <span className="donate-emergency-banner-live-dot" aria-hidden="true" />
                        <span>LIVE</span>
                        <span aria-hidden="true">·</span>
                        <span>{t("liveStatus")}</span>
                    </span>
                </div>
                <h2 className="donate-emergency-banner-title">{t("title")}</h2>
                <p className="donate-emergency-banner-body">{t("body", { name: view.label })}</p>
                <div className="donate-emergency-banner-actions">
                    {primaryAction !== undefined ? (
                        <a
                            className="donate-emergency-banner-cta donate-emergency-banner-cta-primary btn"
                            href={primaryAction.href}
                        >
                            {primaryAction.label}
                        </a>
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
            </div>
        </div>
    );
}
