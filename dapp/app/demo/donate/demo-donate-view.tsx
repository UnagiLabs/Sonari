"use client";

import { useTranslations } from "next-intl";
import { DonateView } from "../../donate/donate-view";
import type { SonariLocale } from "../../register/wizard/locale";
import { TOHOKU_2011_DEMO_EARTHQUAKE } from "../_data/tohoku-2011";
import { buildTohokuEmergencyCampaign } from "../_data/tohoku-emergency-campaign";

/**
 * デモ用の寄付ビュー。
 *
 * 本番 DonateView をそのまま再利用し、緊急バナーに東日本大震災(2011)の固定
 * キャンペーンを「実施中」として注入する。DonateView に demo を渡すと
 * デモモードになり、チェーン読み込みと実送金を行わない表示専用になる。
 */
export function DemoDonateView({ locale }: { readonly locale: SonariLocale }) {
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

    return <DonateView locale={locale} demo={{ emergencyCampaign, statusNote: t("statusNote") }} />;
}
