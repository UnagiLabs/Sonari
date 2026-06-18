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
    type DashboardConfirmedSource,
    type DashboardPoolSummary,
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
                        <div className="meta">{t(`metrics.${key}.meta`)}</div>
                    </article>
                ))}
            </section>

            <div className="dashboard-sections">
                <section className="dash-panel" aria-labelledby="pool-title">
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

                <ConfirmedSourcePanel source={view.latestEvent} />
            </div>

            <p className="muted dashboard-disclaimer">{t("disclaimer")}</p>
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
                    <dd className="is-accent">{pool.available}</dd>
                </div>
            </dl>
        </article>
    );
}

function ConfirmedSourcePanel({ source }: { readonly source: DashboardConfirmedSource }) {
    const t = useTranslations("dashboard");

    return (
        <section className="dash-panel" aria-labelledby="source-title">
            <div className="panel-header">
                <div>
                    <div className="eyebrow">{t("confirmedSource.eyebrow")}</div>
                    <h2 id="source-title">{t("confirmedSource.title")}</h2>
                </div>
                <span className={`tag ${source.present ? "tag-ok" : "tag-neutral"} tag-dot`}>
                    {source.present
                        ? t("confirmedSource.verifiedBadge")
                        : t("confirmedSource.empty")}
                </span>
            </div>

            <div className="source-chain">
                <SourceChainStep
                    name={t("sourceChain.usgs.name")}
                    note={t("sourceChain.usgs.note")}
                />
                <span className="source-chain-arrow" aria-hidden="true">
                    →
                </span>
                <SourceChainStep
                    name={t("sourceChain.nautilus.name")}
                    note={t("sourceChain.nautilus.note")}
                />
                <span className="source-chain-arrow" aria-hidden="true">
                    →
                </span>
                <SourceChainStep
                    name={t("sourceChain.sui.name")}
                    note={t("sourceChain.sui.note")}
                />
                {source.present ? (
                    <span className="source-chain-rev">
                        {t("confirmedSource.revision", {
                            revision: source.eventRevision,
                            date: source.finalizedDate,
                        })}
                    </span>
                ) : null}
            </div>

            <div className="source-layout">
                <div className="event-summary">
                    {source.present ? (
                        <div className="event-source">{source.sourceEventId}</div>
                    ) : null}
                    <h3>{source.present ? source.region : t("confirmedSource.empty")}</h3>
                    <dl>
                        <div>
                            <dt>{t("eventPanel.hazardLabel")}</dt>
                            <dd>{source.present ? source.hazard : "—"}</dd>
                        </div>
                        <div>
                            <dt>{t("eventPanel.affectedCellsLabel")}</dt>
                            <dd>
                                {source.present
                                    ? t("eventPanel.affectedCellsValue", {
                                          cells: source.affectedCellsCount,
                                      })
                                    : "—"}
                            </dd>
                        </div>
                        <div>
                            <dt>{t("eventPanel.finalizedAtLabel")}</dt>
                            <dd>{source.present ? source.finalizedAt : "—"}</dd>
                        </div>
                        <div>
                            <dt>{t("eventPanel.claimWindowLabel")}</dt>
                            <dd>{source.present ? t("eventPanel.claimWindowValue") : "—"}</dd>
                        </div>
                    </dl>
                    {source.present ? (
                        <a className="source-object-link" href="/events">
                            {t("confirmedSource.objectLabel")} {source.objectIdShort} →
                        </a>
                    ) : null}
                </div>

                <div className="source-map">
                    <div className="affected-map-placeholder" aria-hidden="true">
                        <div className="affected-map-caption">
                            <span>{t("affectedMap.caption")}</span>
                            <span>
                                {t("affectedMap.grid", { cells: source.affectedCellsCount })}
                            </span>
                        </div>
                    </div>
                    <p className="muted affected-map-note">{t("affectedMap.note")}</p>
                </div>
            </div>
        </section>
    );
}

function SourceChainStep({ name, note }: { readonly name: string; readonly note: string }) {
    return (
        <span className="source-chain-step">
            <span className="source-chain-name">{name}</span>
            <span className="source-chain-note">{note}</span>
        </span>
    );
}
