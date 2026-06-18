"use client";

// ---------------------------------------------------------------------------
// DisasterDonateView – /donate/[eventId] 災害特設 Pool 寄付ページ ビュー
//
// URL の eventId を disasterEventId として解釈し、対応する campaignId を解決して
// DonateView（campaign 固定モード）で寄付フォームを描画する。
// 被災エリアの Google Maps 表示枠も追加する（env 未設定時は非描画）。
// ---------------------------------------------------------------------------

import { useCurrentClient } from "@mysten/dapp-kit-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { affectedAreaArtifactFromBaseUrl } from "../../claim/affected-area/affected-area-artifact";
import type { AffectedAreaArtifactSource } from "../../claim/catalog/claimable-program";
import type { ClaimCampaignState } from "../../claim/claim-campaigns";
import { readClaimCampaigns } from "../../claim/claim-campaigns";
import { createClaimReadClient } from "../../claim/claim-read-client";
import { LoadingIndicator } from "../../components/loading-indicator";
import { formatDate } from "../../i18n/format";
import { SiteTopbar } from "../../i18n/site-topbar";
import type { DisasterPoolView } from "../../pools/disaster-pool-view-model";
import { buildDisasterPoolViews } from "../../pools/disaster-pool-view-model";
import type { SonariLocale } from "../../register/wizard/locale";
import { readDonateEnvConfig } from "../donate-config";
import { DonateView } from "../donate-view";
import { resolveCampaignByEvent } from "./resolve-campaign-by-event";

// AffectedAreaMap は "use client" だが next/dynamic ssr:false にしておく
// （Google Maps ライブラリの window 依存を SSR で踏まないよう念のため）
const AffectedAreaMap = dynamic(
    () =>
        import("../../claim/affected-area/affected-area-map").then(
            (module) => module.AffectedAreaMap,
        ),
    { ssr: false },
);

// ---------------------------------------------------------------------------
// ページ内部の状態型
// ---------------------------------------------------------------------------

type CampaignLoadState =
    | { readonly status: "loading" }
    | { readonly status: "error"; readonly message: string }
    | {
          readonly status: "not-found";
          readonly eventId: string;
      }
    | {
          readonly status: "ready";
          readonly campaign: ClaimCampaignState;
          readonly view: DisasterPoolView;
      };

// ---------------------------------------------------------------------------
// DisasterDonateView
// ---------------------------------------------------------------------------

export function DisasterDonateView({
    eventId,
    locale,
}: {
    readonly eventId: string;
    readonly locale: SonariLocale;
}) {
    const t = useTranslations("disasterDonate");
    const suiClient = useCurrentClient();
    const client = useMemo(() => createClaimReadClient(suiClient), [suiClient]);

    const [loadState, setLoadState] = useState<CampaignLoadState>({ status: "loading" });
    const [retryNonce, setRetryNonce] = useState(0);

    // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce is a retry trigger.
    useEffect(() => {
        const envConfigResult = readDonateEnvConfig();
        if (envConfigResult.kind !== "ok") {
            setLoadState({
                status: "error",
                message:
                    "Funding package is not configured. Please set NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID.",
            });
            return;
        }

        const packageId = envConfigResult.config.fundingPackageId;
        let cancelled = false;
        setLoadState({ status: "loading" });

        readClaimCampaigns(client, { packageId, nowMs: Date.now() })
            .then((result) => {
                if (cancelled) return;

                if (result.kind !== "ok") {
                    setLoadState({ status: "error", message: result.message });
                    return;
                }

                const campaign = resolveCampaignByEvent(result.campaigns, eventId);
                if (campaign === null) {
                    setLoadState({ status: "not-found", eventId });
                    return;
                }

                // ビューモデルを 1 件ぶん生成
                const views = buildDisasterPoolViews([campaign], Date.now());
                const view = views[0];
                if (view === undefined) {
                    // buildDisasterPoolViews は必ず 1 件を返すが型安全のためガード
                    setLoadState({ status: "not-found", eventId });
                    return;
                }

                setLoadState({ status: "ready", campaign, view });
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setLoadState({
                        status: "error",
                        message:
                            error instanceof Error
                                ? error.message
                                : "Failed to load disaster pool.",
                    });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [retryNonce, client, eventId]);

    // ---------------------------------------------------------------------------
    // ローディング
    // ---------------------------------------------------------------------------

    if (loadState.status === "loading") {
        return (
            <>
                <div className="watercolor-bg" />
                <div className="app">
                    <SiteTopbar active="donate" locale={locale} />
                    <main className="page claim-page">
                        <div className="claim-loading" role="status">
                            <LoadingIndicator label={t("title")} />
                        </div>
                    </main>
                </div>
            </>
        );
    }

    // ---------------------------------------------------------------------------
    // エラー（env 未設定 / 取得失敗）
    // ---------------------------------------------------------------------------

    if (loadState.status === "error") {
        return (
            <>
                <div className="watercolor-bg" />
                <div className="app">
                    <SiteTopbar active="donate" locale={locale} />
                    <main className="page claim-page">
                        <div className="claim-inline-notice error" role="alert">
                            <span>{loadState.message}</span>
                            <button
                                className="text-action"
                                onClick={() => setRetryNonce((n) => n + 1)}
                                type="button"
                            >
                                Retry
                            </button>
                        </div>
                    </main>
                </div>
            </>
        );
    }

    // ---------------------------------------------------------------------------
    // not-found
    // ---------------------------------------------------------------------------

    if (loadState.status === "not-found") {
        return (
            <>
                <div className="watercolor-bg" />
                <div className="app">
                    <SiteTopbar active="donate" locale={locale} />
                    <main className="page claim-page">
                        <div className="claim-not-found">
                            <h1>{t("notFoundTitle")}</h1>
                            <p>{t("notFoundBody")}</p>
                            <Link className="btn btn-secondary" href="/pools">
                                {t("backToPools")}
                            </Link>
                        </div>
                    </main>
                </div>
            </>
        );
    }

    // ---------------------------------------------------------------------------
    // 表示: campaign が見つかった場合
    // ---------------------------------------------------------------------------

    const { campaign, view } = loadState;

    // affected-area artifact の生成（env 未設定時は null → 地図を描かない）
    const affectedAreaArtifact: AffectedAreaArtifactSource | null = affectedAreaArtifactFromBaseUrl(
        process.env.NEXT_PUBLIC_SONARI_AFFECTED_AREA_BASE_URL,
        {
            eventUid: campaign.eventUid,
            eventRevision: campaign.eventRevision,
        },
    );

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="donate" locale={locale} />

                <main className="page claim-page">
                    <header className="claim-hero">
                        <div>
                            <div className="eyebrow">{t("title")}</div>
                            <h1>{view.title}</h1>
                        </div>
                    </header>

                    {/* 災害情報サマリ */}
                    <section
                        className="claim-event-panel"
                        aria-labelledby="disaster-donate-summary-title"
                    >
                        <h2 id="disaster-donate-summary-title" className="sr-only">
                            {view.title}
                        </h2>
                        <dl className="pass-grid">
                            <div>
                                <dt>{t("regionLabel")}</dt>
                                <dd>{view.region}</dd>
                            </div>
                            <div>
                                <dt>{t("affectedCellsLabel")}</dt>
                                <dd>{view.affectedCellCount.toLocaleString()}</dd>
                            </div>
                            <div>
                                <dt>{t("donationEndLabel")}</dt>
                                <dd>{formatDate(view.donationEndMs, locale) ?? "-"}</dd>
                            </div>
                            <div>
                                <dt>{t("claimEndLabel")}</dt>
                                <dd>{formatDate(view.claimEndMs, locale) ?? "-"}</dd>
                            </div>
                            <div>
                                <dt>{t("balanceLabel")}</dt>
                                <dd>{view.balanceLabel}</dd>
                            </div>
                            <div>
                                <dt>{t("totalDonatedLabel")}</dt>
                                <dd>{view.totalDonatedLabel}</dd>
                            </div>
                            <div>
                                <dt>{t("totalPaidLabel")}</dt>
                                <dd>{view.totalPaidLabel}</dd>
                            </div>
                            <div>
                                <dt>{t("statusLabel")}</dt>
                                <dd>{t(`status.${view.status}`)}</dd>
                            </div>
                        </dl>
                    </section>

                    {/* 被災エリア地図（env 設定時のみ） */}
                    {affectedAreaArtifact !== null ? (
                        <section
                            className="claim-map-section"
                            aria-labelledby="disaster-donate-map-title"
                        >
                            <div className="panel-header">
                                <h2 id="disaster-donate-map-title">{t("mapTitle")}</h2>
                            </div>
                            <AffectedAreaMap
                                affectedAreaArtifact={affectedAreaArtifact}
                                cellSource={{ kind: "deferred" }}
                                residenceCell={null}
                            />
                        </section>
                    ) : null}

                    {/* 寄付フォーム（campaign 固定モード） */}
                    <section className="claim-layout" aria-labelledby="donate-form-section">
                        <DonateView
                            locale={locale}
                            initialMode="campaign"
                            initialCampaignId={campaign.campaignId}
                            lockDestination
                        />
                    </section>
                </main>
            </div>
        </>
    );
}
