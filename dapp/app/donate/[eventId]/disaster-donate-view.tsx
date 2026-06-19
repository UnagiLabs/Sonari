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
    // 送金成功後は完了/領収書画面に切り替えるため、自前 chrome（ヒーロー・メトリクス・地図）を隠す。
    const [donationSubmitted, setDonationSubmitted] = useState(false);

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

                <main className="page claim-page disaster-donate-page">
                    {/* 送金成功後は完了/領収書画面に切り替えるため、災害概要の chrome を隠す。 */}
                    {donationSubmitted ? null : (
                        <header className="claim-hero disaster-hero">
                            <div>
                                <Link className="text-action disaster-breadcrumb" href="/pools">
                                    <span aria-hidden="true">‹</span>
                                    {t("backToPools")}
                                </Link>
                                {/* 状態は専用バッジに集約し、メトリクス strip からは外す（design 準拠）。 */}
                                <div
                                    className={`disaster-status-badge${
                                        view.status === "active" ? " is-active" : ""
                                    }`}
                                >
                                    <span className="dot" aria-hidden="true" />
                                    <span className="text">{t(`status.${view.status}`)}</span>
                                </div>
                                <h1>{view.title}</h1>
                                <p className="muted">{view.region}</p>
                            </div>
                        </header>
                    )}

                    {/* split view: 左に災害概要（メトリクス + 地図）、右にスティッキー寄付カード。
                        送金成功後は概要を畳み（is-submitted）、寄付カード列を全幅にして
                        完了/領収書を見せる。DonateView は単一インスタンスのまま右列に置き続け、
                        submitted 遷移で再マウントされない（内部 txState を失わせない）。 */}
                    <div className={`disaster-split${donationSubmitted ? " is-submitted" : ""}`}>
                        {donationSubmitted ? null : (
                            <div className="disaster-split-main">
                                {/* 主要指標を簡潔な strip で見せる（被災セル数・寄付締切・残高）。
                                    地域はヒーロー副題、状態はバッジに出すため、ここでは出さない。 */}
                                <section
                                    className="metrics-strip disaster-metrics-strip"
                                    aria-label={view.title}
                                >
                                    <article className="metric-item">
                                        <div className="label">{t("affectedCellsLabel")}</div>
                                        <div className="value">
                                            {view.affectedCellCount.toLocaleString()}
                                        </div>
                                    </article>
                                    <article className="metric-item">
                                        <div className="label">{t("donationEndLabel")}</div>
                                        <div className="value">
                                            {formatDate(view.donationEndMs, locale) ?? "-"}
                                        </div>
                                    </article>
                                    <article className="metric-item">
                                        <div className="label">{t("balanceLabel")}</div>
                                        <div className="value">{view.balanceLabel}</div>
                                    </article>
                                </section>

                                {/* 被災エリア地図。artifact が無い（env 未設定 / 未生成）ときも
                                    枠は残し、fallback メッセージを出してページを壊さない。 */}
                                <section
                                    className="claim-map-section"
                                    aria-labelledby="disaster-donate-map-title"
                                >
                                    <div className="panel-header">
                                        <h2 id="disaster-donate-map-title">{t("mapTitle")}</h2>
                                    </div>
                                    {affectedAreaArtifact !== null ? (
                                        <AffectedAreaMap
                                            affectedAreaArtifact={affectedAreaArtifact}
                                            cellSource={{ kind: "deferred" }}
                                            residenceCell={null}
                                        />
                                    ) : (
                                        <p className="muted claim-sub">{t("mapUnavailable")}</p>
                                    )}
                                </section>
                            </div>
                        )}

                        {/* 寄付フォーム（campaign 固定モード・chrome なし embedded）。
                            ページ chrome（SiteTopbar・背景・main）は本ビューが用意するため、
                            DonateView は embedded でフォーム部分のみ描画させ二重描画を防ぐ。
                            送金成功で onSubmittedChange→donationSubmitted=true となり、上の概要を隠して
                            DonateView 側が完了/領収書画面を描画する。寄付先ラベルは災害名で上書き。 */}
                        <div className="disaster-split-aside">
                            <DonateView
                                locale={locale}
                                initialMode="campaign"
                                initialCampaignId={campaign.campaignId}
                                lockDestination
                                embedded
                                onSubmittedChange={setDonationSubmitted}
                                destinationLabelOverride={view.title}
                            />
                        </div>
                    </div>
                </main>
            </div>
        </>
    );
}
