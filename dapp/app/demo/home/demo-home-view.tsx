"use client";

import { useTranslations } from "next-intl";
import { HomeView } from "../../home-view";
import type { SonariLocale } from "../../register/wizard/locale";
import { TOHOKU_2011_DEMO_EARTHQUAKE } from "../_data/tohoku-2011";
import { buildTohokuEmergencyCampaign } from "../_data/tohoku-emergency-campaign";

/**
 * デモ用のホームビュー。
 *
 * 本番 HomeView をそのまま再利用し、緊急バナーに東日本大震災(2011) の固定
 * キャンペーンを「実施中」として注入する。HomeView に demo を渡すとチェーンを
 * 読まず、この固定キャンペーンを赤い緊急バナーとして表示する（表示専用）。
 *
 * 概要ラベルは demo/donate と同じ demo.donate.* を再利用し、二重管理を避ける。
 */
export function DemoHomeView({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("demo.donate");
    // 「受け取る」ボタンの文言は本番バナーと同じ home.emergencyClaimCta を再利用する。
    const tHome = useTranslations("home");

    const emergencyCampaign = buildTohokuEmergencyCampaign(
        {
            status: t("status"),
            magnitude: t("details.magnitude"),
            mmi: t("details.mmi"),
            region: t("details.region"),
            date: t("details.date"),
            affectedCells: t("details.affectedCells"),
            h3Resolution: t("details.h3Resolution"),
            epicenter: t("details.epicenter"),
        },
        TOHOKU_2011_DEMO_EARTHQUAKE,
    );

    // デモでは登録済みの被災者を想定し、受け取り導線をデモ用 My Page へ向ける。
    return (
        <HomeView
            locale={locale}
            demo={{
                emergencyCampaign,
                primaryAction: { href: "/demo/mypage", label: tHome("emergencyClaimCta") },
            }}
        />
    );
}
