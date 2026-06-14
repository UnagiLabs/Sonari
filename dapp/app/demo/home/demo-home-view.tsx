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

    return <HomeView locale={locale} demo={{ emergencyCampaign }} />;
}
