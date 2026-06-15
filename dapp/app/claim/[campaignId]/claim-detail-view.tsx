"use client";

import { SiteTopbar } from "../../i18n/site-topbar";
import type { SonariLocale } from "../../register/wizard/locale";

// /claim/[campaignId] 詳細ビュー（STEP 3 仮実装）。
// 請求フロー・地図・campaign データ取得は STEP 4 で実装する。
// i18n キーは STEP 6 で追加するため、ここでは仮の素テキストで表示する。
export function ClaimDetailView({
    locale,
    campaignId,
}: {
    readonly locale: SonariLocale;
    readonly campaignId: string;
}) {
    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="claim" locale={locale} />
                <main className="page claim-page">
                    <p>Claim detail: {campaignId}</p>
                </main>
            </div>
        </>
    );
}
