"use client";

// ---------------------------------------------------------------------------
// PoolsView – /pools 災害特設プール一覧ビュー
//
// 設計方針:
// - ウォレット接続不要。未接続でも全件表示する。
// - readClaimCampaigns（funding package を donate と同じ env で解決）で
//   ClaimCampaignState[] を取得し、buildDisasterPoolViews で DisasterPoolView[]
//   へ変換してカード表示する。
// - 汎用プールは buildDisasterPoolViews の出力に含まれないため
//   この View には一切表示されない（disaster campaign のみ）。
// - env 未設定など取得不能時は fail-closed で error 表示にする。
// ---------------------------------------------------------------------------

import { useCurrentClient } from "@mysten/dapp-kit-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { LoadingIndicator } from "../components/loading-indicator";
import { formatDate } from "../i18n/format";
import { SiteTopbar } from "../i18n/site-topbar";
import type { SonariLocale } from "../register/wizard/locale";
import { readClaimCampaigns } from "../claim/claim-campaigns";
import { createClaimReadClient } from "../claim/claim-read-client";
import { readDonateEnvConfig } from "../donate/donate-config";
import { buildDisasterPoolViews, type DisasterPoolView } from "./disaster-pool-view-model";

// ---------------------------------------------------------------------------
// 取得状態
// ---------------------------------------------------------------------------

type PoolsListState =
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly views: readonly DisasterPoolView[] }
    | { readonly status: "error"; readonly message: string };

// ---------------------------------------------------------------------------
// PoolsView
// ---------------------------------------------------------------------------

export function PoolsView({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("pools");
    const suiClient = useCurrentClient();
    const client = useMemo(() => createClaimReadClient(suiClient), [suiClient]);

    const [poolsState, setPoolsState] = useState<PoolsListState>({ status: "loading" });
    const [fetchNonce, setFetchNonce] = useState(0);

    // biome-ignore lint/correctness/useExhaustiveDependencies: fetchNonce is a retry trigger.
    useEffect(() => {
        const envConfigResult = readDonateEnvConfig();
        if (envConfigResult.kind !== "ok") {
            setPoolsState({
                status: "error",
                message:
                    "Funding package is not configured. Please set NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID.",
            });
            return;
        }

        const packageId = envConfigResult.config.fundingPackageId;
        let cancelled = false;
        setPoolsState({ status: "loading" });

        readClaimCampaigns(client, { packageId, nowMs: Date.now() })
            .then((result) => {
                if (cancelled) {
                    return;
                }
                if (result.kind === "ok") {
                    const views = buildDisasterPoolViews(result.campaigns, Date.now());
                    setPoolsState({ status: "ready", views });
                    return;
                }
                setPoolsState({ status: "error", message: result.message });
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setPoolsState({
                        status: "error",
                        message:
                            error instanceof Error
                                ? error.message
                                : "Failed to load disaster pools.",
                    });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [fetchNonce, client]);

    const renderContent = () => {
        if (poolsState.status === "loading") {
            return (
                <div className="claim-loading" role="status">
                    <LoadingIndicator label={t("loading")} />
                </div>
            );
        }

        if (poolsState.status === "error") {
            return (
                <div className="claim-inline-notice error" role="alert">
                    <span>{t("error")}</span>
                    <button
                        className="text-action"
                        onClick={() => setFetchNonce((n) => n + 1)}
                        type="button"
                    >
                        {t("retry")}
                    </button>
                </div>
            );
        }

        if (poolsState.views.length === 0) {
            return <p className="muted claim-sub">{t("empty")}</p>;
        }

        return (
            <ul className="claim-list-cards">
                {poolsState.views.map((view) => (
                    <li className="claim-list-card" key={view.campaignId}>
                        <div className="claim-list-card-header">
                            <strong className="claim-list-card-title">{view.title}</strong>
                            <span className="claim-list-card-scope">{view.region}</span>
                        </div>
                        <dl className="claim-list-card-meta">
                            <div>
                                <dt>{t("card.affectedCells")}</dt>
                                <dd>{view.affectedCellCount.toLocaleString()}</dd>
                            </div>
                            <div>
                                <dt>{t("card.donationEnd")}</dt>
                                <dd>{formatDate(view.donationEndMs, locale) ?? "-"}</dd>
                            </div>
                            <div>
                                <dt>{t("card.balance")}</dt>
                                <dd>{view.balanceLabel}</dd>
                            </div>
                            <div>
                                <dt>{t("card.totalDonated")}</dt>
                                <dd>{view.totalDonatedLabel}</dd>
                            </div>
                            <div>
                                <dt>{t("card.totalPaid")}</dt>
                                <dd>{view.totalPaidLabel}</dd>
                            </div>
                        </dl>
                        <Link className="btn btn-secondary" href={view.href}>
                            {t("card.donate")}
                        </Link>
                    </li>
                ))}
            </ul>
        );
    };

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="donate" locale={locale} />

                <main className="page claim-page">
                    <header className="claim-hero">
                        <div>
                            <div className="eyebrow">{t("eyebrow")}</div>
                            <h1>{t("title")}</h1>
                            <p className="muted claim-sub">{t("sub")}</p>
                        </div>
                    </header>

                    <section className="claim-list-section" aria-label={t("title")}>
                        {renderContent()}
                    </section>
                </main>
            </div>
        </>
    );
}
