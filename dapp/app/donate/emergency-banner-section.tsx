"use client";

import { useCurrentClient } from "@mysten/dapp-kit-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { type ClaimCampaignState, readClaimCampaigns } from "../claim/claim-campaigns";
import { createClaimReadClient } from "../claim/claim-read-client";
import { useClaimBannerCta } from "../home-claim-banner";
import { readDonateEnvConfig } from "./donate-config";
import { selectEmergencyBannerFromClaimCampaigns } from "./donate-view-state";
import { EmergencyBanner } from "./emergency-banner";

export interface EmergencyBannerSectionProps {
    /**
     * 「寄付する」押下時の挙動。home は /donate へ遷移、/donate はフォームへ campaign 反映、と
     * ページごとに差し替える。バナーの見た目（データ取得・選定・受け取り CTA 判定）は共通化する。
     */
    readonly onDonate: (campaignId: string, disasterEventId?: string) => void;
}

/**
 * 緊急バナーの本番表示を担う自己完結コンポーネント。
 *
 * チェーンから災害 Campaign を読み、実施中のものだけを選び、受け取り CTA を判定して
 * EmergencyBanner を描画する。home と /donate の本番経路で共有することで、両ページが
 * 同一データ・同一見た目（実イベント名・マグニチュードチップ・受け取るボタン）になる。
 *
 * FeaturedPools と同じ readClaimCampaigns を使い、バナーに災害イベント名（title）を出す。
 * CampaignCreated イベントだけでは title を取れないため DisasterEvent 紐付け済みの
 * ClaimCampaignState から選ぶ。読み込み中・失敗・該当なしのときは選定が null を返し、
 * バナーは出ない（fail-close）。
 *
 * デモ経路（固定キャンペーン注入）はこのコンポーネントを使わず、呼び出し側が
 * EmergencyBanner を直接描画する。
 */
export function EmergencyBannerSection({ onDonate }: EmergencyBannerSectionProps) {
    const t = useTranslations("home");
    // 受け取り導線の判定は寄付バナーの取得とは独立。接続済み・登録済み・claim window
    // 開のキャンペーンがあるときだけ「受け取る」主ボタンを足す（バナーは 1 枠のまま）。
    const claimCta = useClaimBannerCta();
    const suiClient = useCurrentClient();
    const client = useMemo(() => createClaimReadClient(suiClient), [suiClient]);
    const [campaigns, setCampaigns] = useState<readonly ClaimCampaignState[]>([]);

    useEffect(() => {
        // funding package 未設定では実施中キャンペーンを判定できないため非表示にする。
        const envConfigResult = readDonateEnvConfig();
        if (envConfigResult.kind !== "ok") {
            setCampaigns([]);
            return;
        }
        const packageId = envConfigResult.config.fundingPackageId;
        let cancelled = false;
        setCampaigns([]);

        readClaimCampaigns(client, { packageId, nowMs: Date.now() })
            .then((result) => {
                if (cancelled) {
                    return;
                }
                setCampaigns(result.kind === "ok" ? result.campaigns : []);
            })
            .catch(() => {
                if (!cancelled) {
                    setCampaigns([]);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [client]);

    // 現在時刻で実施中判定する。該当が無ければ null になりバナーは非表示。
    const campaign = selectEmergencyBannerFromClaimCampaigns(campaigns, BigInt(Date.now()));
    const primaryAction =
        claimCta !== null &&
        campaign !== null &&
        claimCta.disasterEventId === campaign.disasterEventId
            ? { href: `/claim/${campaign.disasterEventId}`, label: t("emergencyClaimCta") }
            : undefined;

    return (
        <EmergencyBanner
            campaign={campaign}
            onDonate={onDonate}
            {...(primaryAction !== undefined ? { primaryAction } : {})}
        />
    );
}
