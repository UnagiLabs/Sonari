"use client";

import { useCurrentClient } from "@mysten/dapp-kit-react";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    GENESIS_OBJECT_KIND,
    readGenesisObjectIds,
    selectGenesisObjectId,
} from "../chain/genesis-objects";
import { SiteTopbar } from "../i18n/site-topbar";
import type { SonariLocale } from "../register/wizard/locale";
import { readWalletNetwork, resolveGrpcBaseUrl } from "../wallet/wallet-network";
import { readDashboardPools } from "./dashboard-chain";
import { readDashboardEvents } from "./dashboard-events";
import {
    type DashboardActivityItem,
    type DashboardPoolSummary,
    type DashboardSupporter,
    type DashboardViewModel,
    deriveDashboardViewModel,
} from "./dashboard-view-model";

type DashboardReadState =
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly view: DashboardViewModel }
    | { readonly status: "error" };

const fundingPackageId = process.env.NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID ?? "";

export function DashboardView({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("dashboard");
    const client = useCurrentClient();
    const network = readWalletNetwork();
    const [state, setState] = useState<DashboardReadState>({ status: "loading" });
    const cancelRef = useRef<() => void>(() => {});

    const load = useCallback((): (() => void) => {
        cancelRef.current();

        // 詳細な原因は開発者向けに console へ出し、画面には内部名を出さない。
        const failClosed = (detail: string) => {
            console.error(`dashboard load failed: ${detail}`);
            setState({ status: "error" });
        };

        if (fundingPackageId.trim().length === 0) {
            failClosed("NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID is required.");
            return () => {};
        }

        let cancelled = false;
        const cancel = () => {
            cancelled = true;
        };
        cancelRef.current = cancel;
        setState({ status: "loading" });

        const eventClient = new SuiJsonRpcClient({ network, url: resolveGrpcBaseUrl(network) });

        void (async () => {
            // pool ID は環境変数ではなく packageID 起点の genesis イベントから導出する。
            const genesisResult = await readGenesisObjectIds(eventClient, {
                packageId: fundingPackageId,
            });
            if (cancelled) {
                return;
            }
            if (genesisResult.kind === "error") {
                failClosed(genesisResult.message);
                return;
            }

            const mainPoolId = selectGenesisObjectId(
                genesisResult.ids,
                GENESIS_OBJECT_KIND.mainPool,
            );
            const operationsPoolId = selectGenesisObjectId(
                genesisResult.ids,
                GENESIS_OBJECT_KIND.operationsPool,
            );
            const categoryPoolId = selectGenesisObjectId(
                genesisResult.ids,
                GENESIS_OBJECT_KIND.earthquakePool,
            );
            if (mainPoolId === null || operationsPoolId === null || categoryPoolId === null) {
                failClosed("genesis objects for main/operations/earthquake pool were not found.");
                return;
            }

            const [poolResult, eventResult] = await Promise.all([
                readDashboardPools(client, { mainPoolId, operationsPoolId, categoryPoolId }),
                readDashboardEvents(eventClient, { packageId: fundingPackageId }),
            ]);
            if (cancelled) {
                return;
            }
            if (poolResult.kind === "error") {
                failClosed(poolResult.message);
                return;
            }
            if (eventResult.kind === "error") {
                failClosed(eventResult.message);
                return;
            }
            setState({
                status: "ready",
                view: deriveDashboardViewModel({
                    locale,
                    nowMs: Date.now(),
                    pools: poolResult.pools,
                    donations: eventResult.donations,
                    claims: eventResult.claims,
                    aidDeliveredUsdc: eventResult.aidDeliveredUsdc,
                    totalClaimsCount: eventResult.totalClaimsCount,
                    latestEvent: eventResult.latestEvent,
                }),
            });
        })().catch((error: unknown) => {
            if (!cancelled) {
                failClosed(
                    error instanceof Error ? error.message : "Failed to read dashboard data.",
                );
            }
        });

        return cancel;
    }, [client, locale, network]);

    useEffect(() => load(), [load]);

    const retry = useCallback(() => {
        load();
    }, [load]);

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="dashboard" locale={locale} />

                <main className="page dashboard-page">
                    <header className="dashboard-hero">
                        <div>
                            <div className="eyebrow">{t("hero.eyebrow")}</div>
                            <h1>{t("hero.title")}</h1>
                            <p className="muted dashboard-sub">{t("hero.sub")}</p>
                        </div>
                        <div className="dashboard-actions">
                            <a className="btn btn-primary" href="/donate">
                                {t("actions.donate")}
                            </a>
                            <button
                                className="btn btn-ghost"
                                disabled={state.status === "loading"}
                                onClick={retry}
                                type="button"
                            >
                                {t("actions.refresh")}
                            </button>
                        </div>
                    </header>

                    <section className="dashboard-status" aria-label={t("statusBar.publicView")}>
                        <span
                            className={`tag ${state.status === "error" ? "tag-neutral" : "tag-ok"} tag-dot`}
                        >
                            {state.status === "ready"
                                ? t("statusBar.liveData")
                                : state.status === "loading"
                                  ? t("statusBar.loadingData")
                                  : t("statusBar.unavailable")}
                        </span>
                        <span>
                            {state.status === "ready"
                                ? t("statusBar.lastRefreshed", { time: state.view.generatedAt })
                                : t("statusBar.lastRefreshed", { time: "..." })}
                        </span>
                        <span>{t("statusBar.publicView")}</span>
                    </section>

                    {state.status === "loading" ? (
                        <DashboardMessage
                            title={t("states.loadingTitle")}
                            body={t("states.loadingBody")}
                        />
                    ) : null}

                    {state.status === "error" ? (
                        <section className="dash-panel" role="alert">
                            <h2>{t("states.errorTitle")}</h2>
                            <p className="muted">{t("states.errorBody")}</p>
                            <button className="btn btn-primary" onClick={retry} type="button">
                                {t("states.retry")}
                            </button>
                        </section>
                    ) : null}

                    {state.status === "ready" ? <DashboardContent view={state.view} /> : null}
                </main>
            </div>
        </>
    );
}

function DashboardContent({ view }: { readonly view: DashboardViewModel }) {
    const t = useTranslations("dashboard");

    return (
        <>
            <section className="metrics-strip dashboard-metrics" aria-label={t("hero.eyebrow")}>
                {view.metricKeys.map((key) => (
                    <article className="metric-item" key={key}>
                        <div className="label">{t(`metrics.${key}.label`)}</div>
                        <div className="value">{view.metricValues[key]}</div>
                        <div className="meta">{view.metricDetails[key]}</div>
                    </article>
                ))}
            </section>

            <section className="dashboard-grid" aria-label={t("hero.eyebrow")}>
                <section className="dash-panel dash-panel-wide" aria-labelledby="pool-title">
                    <PanelHeader
                        actionHref="/pools"
                        actionLabel={t("poolsPanel.action")}
                        eyebrow={t("poolsPanel.eyebrow")}
                        titleId="pool-title"
                        title={t("poolsPanel.title")}
                    />
                    <div className="pool-table">
                        {view.pools.map((pool) => (
                            <PoolRow key={pool.key} pool={pool} />
                        ))}
                    </div>
                </section>

                <section className="dash-panel" aria-labelledby="event-title">
                    <PanelHeader
                        actionHref="/events"
                        actionLabel={t("eventPanel.action")}
                        eyebrow={t("eventPanel.eyebrow")}
                        titleId="event-title"
                        title={t("eventPanel.title")}
                    />
                    <div className="event-summary">
                        <div className="event-source">{view.latestEvent.source}</div>
                        <h3>{view.latestEvent.region}</h3>
                        <dl>
                            <div>
                                <dt>{t("eventPanel.statusLabel")}</dt>
                                <dd>{t(`status.${view.latestEvent.status}`)}</dd>
                            </div>
                            <div>
                                <dt>{t("eventPanel.intensityLabel")}</dt>
                                <dd>{view.latestEvent.intensity}</dd>
                            </div>
                            <div>
                                <dt>{t("eventPanel.affectedCellsLabel")}</dt>
                                <dd>{view.latestEvent.affectedCells}</dd>
                            </div>
                            <div>
                                <dt>{t("eventPanel.claimWindowLabel")}</dt>
                                <dd>{view.latestEvent.claimWindow}</dd>
                            </div>
                        </dl>
                        {view.latestEvent.id.length > 0 ? (
                            <a className="text-action" href="/events">
                                {view.latestEvent.id}
                            </a>
                        ) : null}
                    </div>
                </section>

                <ActivityPanel
                    actionHref="/donor"
                    actionLabel={t("donations.action")}
                    items={view.donations}
                    title={t("donations.title")}
                />
                <ActivityPanel items={view.claims} title={t("claims.title")} />
                <ActivityPanel
                    actionHref="/receipts"
                    actionLabel={t("receiptsPanel.action")}
                    items={view.receipts}
                    title={t("receiptsPanel.title")}
                />

                <section className="dash-panel dash-panel-wide" aria-labelledby="supporters-title">
                    <PanelHeader titleId="supporters-title" title={t("supportersPanel.title")} />
                    <div className="dashboard-supporters">
                        <SupporterColumn
                            supporters={view.topDonors}
                            title={t("supportersPanel.individualDonors")}
                        />
                        <SupporterColumn
                            supporters={view.topSponsors}
                            title={t("supportersPanel.corporateSponsors")}
                        />
                    </div>
                </section>
            </section>
        </>
    );
}

function DashboardMessage({ body, title }: { readonly body: string; readonly title: string }) {
    return (
        <section className="dash-panel">
            <h2>{title}</h2>
            <p className="muted">{body}</p>
        </section>
    );
}

function PanelHeader({
    actionHref,
    actionLabel,
    eyebrow,
    title,
    titleId,
}: {
    actionHref?: string;
    actionLabel?: string;
    eyebrow?: string;
    title: string;
    titleId?: string;
}) {
    return (
        <div className="panel-header">
            <div>
                {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
                <h2 id={titleId}>{title}</h2>
            </div>
            {actionHref && actionLabel ? (
                <a className="text-action" href={actionHref}>
                    {actionLabel}
                </a>
            ) : null}
        </div>
    );
}

function PoolRow({ pool }: { pool: DashboardPoolSummary }) {
    const t = useTranslations("dashboard");

    return (
        <article className="pool-row">
            <div>
                <div className="pool-row-title">
                    <h3>{t(`pools.${pool.key}.name`)}</h3>
                    <span
                        className={`tag ${pool.status === "active" ? "tag-ok" : "tag-neutral"} tag-dot`}
                    >
                        {t(`status.${pool.status}`)}
                    </span>
                </div>
                <div className="meter">
                    <div className="meter-fill" style={{ width: `${pool.percentAvailable}%` }} />
                </div>
            </div>
            <dl className="pool-row-values">
                <div>
                    <dt>{t("poolRow.balance")}</dt>
                    <dd>{pool.balance}</dd>
                </div>
                <div>
                    <dt>{t("poolRow.received")}</dt>
                    <dd>{pool.received}</dd>
                </div>
                <div>
                    <dt>{t("poolRow.paidOut")}</dt>
                    <dd>{pool.paidOut}</dd>
                </div>
                <div>
                    <dt>{t("poolRow.reserved")}</dt>
                    <dd>{pool.reserved}</dd>
                </div>
                <div>
                    <dt>{t("poolRow.available")}</dt>
                    <dd>{pool.available}</dd>
                </div>
            </dl>
        </article>
    );
}

function ActivityPanel({
    actionHref,
    actionLabel,
    items,
    title,
}: {
    actionHref?: string;
    actionLabel?: string;
    items: readonly DashboardActivityItem[];
    title: string;
}) {
    const t = useTranslations("dashboard");

    return (
        <section className="dash-panel">
            <PanelHeader actionHref={actionHref} actionLabel={actionLabel} title={title} />
            <div className="activity-list">
                {items.length === 0 ? <p className="muted">{t("states.noItems")}</p> : null}
                {items.map((item) => (
                    <article className="activity-row" key={`${item.label}-${item.meta}`}>
                        <div>
                            <div className="activity-label">{item.label}</div>
                            <div className="activity-meta">{item.meta}</div>
                        </div>
                        <div className="activity-amount">
                            <span>{item.amount}</span>
                            <small>{t(`status.${item.status}`)}</small>
                        </div>
                    </article>
                ))}
            </div>
        </section>
    );
}

function SupporterColumn({
    supporters,
    title,
}: {
    supporters: readonly DashboardSupporter[];
    title: string;
}) {
    const t = useTranslations("dashboard.supportersPanel");

    return (
        <section className="supporter-group" aria-label={title}>
            <div className="supporter-group-label">{title}</div>
            {supporters.length === 0 ? <p className="muted">{t("noSupporters")}</p> : null}
            {supporters.map((supporter) => (
                <article className="row-item" key={supporter.name}>
                    <div className="avatar avatar-sq">{supporter.rank}</div>
                    <div>
                        <div className="row-name">{supporter.name}</div>
                        <div className="row-meta">{supporter.meta}</div>
                    </div>
                    <div className="row-amount">
                        <span className="stat-num">{supporter.amount}</span>
                        <small>{t("rankLabel", { rank: supporter.rank })}</small>
                    </div>
                </article>
            ))}
        </section>
    );
}
