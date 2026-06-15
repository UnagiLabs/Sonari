"use client";

// ---------------------------------------------------------------------------
// DemoClaimListView – /demo/claim 一覧ビュー
//
// DEMO_CLAIMABLE_PROGRAMS（3件: disaster / student-fund / medical）を
// buildClaimListCard でカード化して全件表示する。
//
// 設計方針:
// - チェーン読込・ウォレット接続に依存しない（表示専用）。
// - データソースは DEMO_CLAIMABLE_PROGRAMS 固定。
// - 各カードの detailHref は /demo/claim/<id> へ遷移（STEP 5 で新設）。
// - マークアップは claim-list-view.tsx の一覧カード構造と同一にする。
// ---------------------------------------------------------------------------

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { buildClaimListCard } from "../../claim/catalog/claim-list-card";
import { DEMO_CLAIMABLE_PROGRAMS } from "../../claim/catalog/demo-catalog";
import { SiteTopbar } from "../../i18n/site-topbar";
import type { SonariLocale } from "../../register/wizard/locale";

// ---------------------------------------------------------------------------
// DemoClaimListView
// ---------------------------------------------------------------------------

export function DemoClaimListView({ locale }: { readonly locale: SonariLocale }) {
    // デモ専用ラベル（eyebrow / title / sub）
    const t = useTranslations("demo.claim");
    // カードラベル（amount / deadline / viewDetail）。本番 claim.list と共有。
    const tCard = useTranslations("claim.list");

    // DEMO_CLAIMABLE_PROGRAMS を一覧カード表示用データへ変換。
    // 固定定数なので useMemo の依存は空配列で問題ない。
    const cards = useMemo(
        () => DEMO_CLAIMABLE_PROGRAMS.map((program) => buildClaimListCard(program)),
        [],
    );

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="claim" locale={locale} />

                <main className="page claim-page">
                    {/* ヒーロー: ウォレットパネルは出さない（デモ表示専用）。 */}
                    <header className="claim-hero">
                        <div>
                            <div className="eyebrow">{t("list.eyebrow")}</div>
                            <h1>{t("list.title")}</h1>
                            <p className="muted claim-sub">{t("list.sub")}</p>
                        </div>
                    </header>

                    {/* カード一覧: claim-list-view.tsx と同一マークアップ構造。 */}
                    <section className="claim-list-section" aria-label={t("list.title")}>
                        <ul className="claim-list-cards">
                            {cards.map((card) => (
                                <li className="claim-list-card" key={card.id}>
                                    <div className="claim-list-card-header">
                                        <strong className="claim-list-card-title">
                                            {card.title}
                                        </strong>
                                        <span className="claim-list-card-scope">{card.scope}</span>
                                    </div>
                                    <dl className="claim-list-card-meta">
                                        <div>
                                            <dt>{tCard("amountLabel")}</dt>
                                            <dd>{tCard("amount", { amount: card.amountText })}</dd>
                                        </div>
                                        <div>
                                            <dt>{tCard("deadlineLabel")}</dt>
                                            <dd>
                                                {tCard("deadline", { date: card.deadlineText })}
                                            </dd>
                                        </div>
                                    </dl>
                                    <a className="btn btn-secondary" href={card.detailHref}>
                                        {tCard("viewDetail")}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </section>
                </main>
            </div>
        </>
    );
}
