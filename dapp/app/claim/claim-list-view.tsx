"use client";

// ---------------------------------------------------------------------------
// ClaimListView – /claim 一覧ビュー
//
// チェーンから読んだ DisasterCampaign を全件カード表示し、各カードから
// /claim/<disasterEventId> 詳細へ遷移する。
//
// 設計方針:
// - ウォレット接続（account）に依存しない。未接続でも全件見える。
// - 本番は claimCampaignsToPrograms が返す disaster カテゴリのみ表示。
// - デモカタログ（DEMO_CLAIMABLE_PROGRAMS）は使わない。
// - データ取得は claim-view.tsx の campaign 読み込み effect と同じ流儀。
// ---------------------------------------------------------------------------

import { useCurrentClient } from "@mysten/dapp-kit-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { LoadingIndicator } from "../components/loading-indicator";
import { SiteTopbar } from "../i18n/site-topbar";
import type { SonariLocale } from "../register/wizard/locale";
import { claimCampaignsToPrograms } from "./catalog/claim-campaign-adapter";
import { buildClaimListCard, type ClaimListCardView } from "./catalog/claim-list-card";
import { readClaimCampaigns } from "./claim-campaigns";
import { readClaimConfig } from "./claim-config";
import { buildCampaignNotice, buildConfigNotice, type ClaimNotice } from "./claim-notices";
import { createClaimReadClient } from "./claim-read-client";

// ---------------------------------------------------------------------------
// キャンペーン取得状態
// ---------------------------------------------------------------------------

type CampaignListState =
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly cards: readonly ClaimListCardView[] }
    | { readonly status: "failed"; readonly message: string };

// ---------------------------------------------------------------------------
// ClaimListView
// ---------------------------------------------------------------------------

export function ClaimListView({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("claim");
    const suiClient = useCurrentClient();
    // 読み取りは createClaimReadClient 経由。queryEvents は JSON-RPC、object 読み取りは
    // gRPC（dApp Kit クライアント）へ委譲する（gRPC にイベント検索が無いため）。
    const client = useMemo(() => createClaimReadClient(suiClient), [suiClient]);
    const claimConfigResult = useMemo(() => readClaimConfig(), []);
    const claimConfig = claimConfigResult.kind === "ok" ? claimConfigResult.config : null;

    const [campaignListState, setCampaignListState] = useState<CampaignListState>({
        status: "loading",
    });
    const [campaignReadNonce, setCampaignReadNonce] = useState(0);

    // campaign 読み込み effect（claim-view.tsx の流儀を踏襲）。
    // campaignReadNonce は再試行トリガー。
    // biome-ignore lint/correctness/useExhaustiveDependencies: campaignReadNonce is a retry trigger.
    useEffect(() => {
        if (claimConfig === null) {
            setCampaignListState({ status: "ready", cards: [] });
            return;
        }

        let cancelled = false;
        setCampaignListState({ status: "loading" });
        readClaimCampaigns(client, { packageId: claimConfig.packageId, nowMs: Date.now() })
            .then((result) => {
                if (cancelled) {
                    return;
                }
                if (result.kind === "ok") {
                    // DisasterClaimableProgram へ変換（disaster カテゴリのみ）し、
                    // 一覧カード表示用データへ整形する。
                    const programs = claimCampaignsToPrograms(result.campaigns);
                    const cards = programs.map((program) => buildClaimListCard(program));
                    setCampaignListState({ status: "ready", cards });
                    return;
                }
                setCampaignListState({ status: "failed", message: result.message });
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setCampaignListState({
                        status: "failed",
                        message:
                            error instanceof Error ? error.message : "Failed to read campaigns.",
                    });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [campaignReadNonce, claimConfig, client]);

    // notice 描画ヘルパー
    const renderNotice = (notice: ClaimNotice | null, onRetry?: () => void) =>
        notice === null ? null : (
            <div className={`claim-inline-notice ${notice.level}`} role="status">
                <span>{t(notice.key)}</span>
                {notice.retryable && onRetry !== undefined ? (
                    <button className="text-action" onClick={onRetry} type="button">
                        {t("status.retry")}
                    </button>
                ) : null}
            </div>
        );

    const configNotice = buildConfigNotice(claimConfigResult.kind);
    const campaignNotice = buildCampaignNotice({
        status: campaignListState.status === "failed" ? "failed" : campaignListState.status,
        campaignCount: campaignListState.status === "ready" ? campaignListState.cards.length : 0,
    });

    // 一覧コンテンツ
    const renderListContent = () => {
        if (campaignListState.status === "loading") {
            return (
                <div className="claim-loading" role="status">
                    <LoadingIndicator label={t("status.campaignsLoading")} />
                </div>
            );
        }

        if (campaignListState.status === "failed") {
            return null; // notice で表示済み
        }

        if (campaignListState.cards.length === 0) {
            return <p className="muted claim-sub">{t("list.empty")}</p>;
        }

        return (
            <ul className="claim-list-cards">
                {campaignListState.cards.map((card) => (
                    <li className="claim-list-card" key={card.id}>
                        <div className="claim-list-card-header">
                            <strong className="claim-list-card-title">{card.title}</strong>
                            <span className="claim-list-card-scope">{card.scope}</span>
                        </div>
                        <dl className="claim-list-card-meta">
                            <div>
                                <dt>{t("list.amountLabel")}</dt>
                                <dd>{t("list.amount", { amount: card.amountText })}</dd>
                            </div>
                            <div>
                                <dt>{t("list.deadlineLabel")}</dt>
                                <dd>{t("list.deadline", { date: card.deadlineText })}</dd>
                            </div>
                        </dl>
                        <a className="btn btn-secondary" href={card.detailHref}>
                            {t("list.viewDetail")}
                        </a>
                    </li>
                ))}
            </ul>
        );
    };

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="claim" locale={locale} />

                <main className="page claim-page">
                    <header className="claim-hero">
                        <div>
                            <div className="eyebrow">{t("list.eyebrow")}</div>
                            <h1>{t("list.title")}</h1>
                            <p className="muted claim-sub">{t("list.sub")}</p>
                        </div>
                    </header>

                    <section className="claim-list-section" aria-label={t("list.title")}>
                        {renderNotice(configNotice)}
                        {renderNotice(campaignNotice, () =>
                            setCampaignReadNonce((value) => value + 1),
                        )}
                        {renderListContent()}
                    </section>
                </main>
            </div>
        </>
    );
}
