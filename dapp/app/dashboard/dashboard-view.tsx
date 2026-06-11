"use client";

import { useTranslations } from "next-intl";
import { SiteTopbar } from "../i18n/site-topbar";
import type { SonariLocale } from "../register/wizard/locale";

type StatusKey = "active" | "paused" | "confirmed" | "pending" | "finalized";

type PoolSummary = {
    key: "main" | "earthquake";
    balance: string;
    received: string;
    paidOut: string;
    reserved: string;
    available: string;
    percentAvailable: number;
    status: StatusKey;
};

type ActivityItem = {
    label: string;
    meta: string;
    amount: string;
    status: StatusKey;
};

type Supporter = {
    name: string;
    meta: string;
    amount: string;
    rank: number;
};

// 金額・固有名詞・日時などのモックデータは翻訳対象外なので定数のまま保持する。
const dashboardSnapshot = {
    generatedAt: "May 28, 2026 19:40 JST",
    metricKeys: ["totalDonated", "aidDelivered", "activePools", "receipts"] as const,
    metricValues: {
        totalDonated: "$3.2M",
        aidDelivered: "$1.2M",
        activePools: "2",
        receipts: "1,291",
    } as Record<"totalDonated" | "aidDelivered" | "activePools" | "receipts", string>,
    pools: [
        {
            key: "main",
            balance: "$1.28M",
            received: "$2.10M",
            paidOut: "$820K",
            reserved: "$124K",
            available: "$1.16M",
            percentAvailable: 61,
            status: "active",
        },
        {
            key: "earthquake",
            balance: "$642K",
            received: "$980K",
            paidOut: "$337K",
            reserved: "$88K",
            available: "$554K",
            percentAvailable: 66,
            status: "active",
        },
    ] as PoolSummary[],
    latestEvent: {
        id: "usgs-2026-0521-184",
        source: "USGS",
        status: "finalized" as StatusKey,
        region: "Offshore Iwate, Japan",
        intensity: "M6.8 / MMI VIII",
        affectedCells: "1,284 cells",
        claimWindow: "Open until Jun 04",
    },
    donations: [
        {
            label: "Aizome Foundation",
            meta: "Earthquake Relief Pool · 4 min ago",
            amount: "$25,000",
            status: "confirmed",
        },
        {
            label: "haru.sui",
            meta: "Earthquake Relief Pool · 11 min ago",
            amount: "$1,200",
            status: "confirmed",
        },
        {
            label: "Anonymous Donor",
            meta: "Main Pool · 18 min ago",
            amount: "$80",
            status: "confirmed",
        },
    ] as ActivityItem[],
    claims: [
        {
            label: "recipient · h3-xQzm",
            meta: "usgs-2026-0521-184 · 12 min ago",
            amount: "$280",
            status: "finalized",
        },
        {
            label: "recipient · h3-aBcd",
            meta: "usgs-2026-0521-184 · 18 min ago",
            amount: "$280",
            status: "finalized",
        },
        {
            label: "recipient · h3-9P1q",
            meta: "usgs-2026-0517-021 · 42 min ago",
            amount: "$200",
            status: "finalized",
        },
    ] as ActivityItem[],
    receipts: [
        {
            label: "rcp_8d2e91",
            meta: "Earthquake Relief · Mainnet transaction",
            amount: "$280",
            status: "finalized",
        },
        {
            label: "rcp_8d2e90",
            meta: "Earthquake Relief · Mainnet transaction",
            amount: "$280",
            status: "finalized",
        },
        {
            label: "rcp_8d2e8f",
            meta: "Earthquake Relief · Mainnet transaction",
            amount: "$200",
            status: "finalized",
        },
    ] as ActivityItem[],
    topDonors: [
        { rank: 1, name: "haru.sui", meta: "Individual · 41 donations", amount: "$89,400" },
        { rank: 2, name: "Anonymous Donor", meta: "Individual · 19 donations", amount: "$52,100" },
        { rank: 3, name: "matcha_dev", meta: "Individual · 52 donations", amount: "$34,200" },
    ] as Supporter[],
    topSponsors: [
        {
            rank: 1,
            name: "Aizome Foundation",
            meta: "Corporate · Earthquake, Main",
            amount: "$524,800",
        },
        {
            rank: 2,
            name: "Kibou Capital",
            meta: "Corporate · Main, Earthquake",
            amount: "$412,300",
        },
        { rank: 3, name: "Midori Logistics", meta: "Corporate · Earthquake", amount: "$76,250" },
    ] as Supporter[],
};

export function DashboardView({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("dashboard");

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="dashboard" locale={locale} showDonateCta showWallet={false} />

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
                            <a className="btn btn-secondary" href="/claim">
                                {t("actions.claimRelief")}
                            </a>
                            <button className="btn btn-ghost" type="button">
                                {t("actions.refresh")}
                            </button>
                        </div>
                    </header>

                    <section className="dashboard-status" aria-label={t("statusBar.publicView")}>
                        <span className="tag tag-ok tag-dot">{t("statusBar.previewData")}</span>
                        <span>
                            {t("statusBar.lastRefreshed", { time: dashboardSnapshot.generatedAt })}
                        </span>
                        <span>{t("statusBar.publicView")}</span>
                    </section>

                    <section
                        className="metrics-strip dashboard-metrics"
                        aria-label={t("hero.eyebrow")}
                    >
                        {dashboardSnapshot.metricKeys.map((key) => (
                            <article className="metric-item" key={key}>
                                <div className="label">{t(`metrics.${key}.label`)}</div>
                                <div className="value">{dashboardSnapshot.metricValues[key]}</div>
                                <div className="meta">{t(`metrics.${key}.detail`)}</div>
                            </article>
                        ))}
                    </section>

                    <section className="dashboard-grid" aria-label={t("hero.eyebrow")}>
                        <section
                            className="dash-panel dash-panel-wide"
                            aria-labelledby="pool-title"
                        >
                            <PanelHeader
                                actionHref="/pools"
                                actionLabel={t("poolsPanel.action")}
                                eyebrow={t("poolsPanel.eyebrow")}
                                titleId="pool-title"
                                title={t("poolsPanel.title")}
                            />
                            <div className="pool-table">
                                {dashboardSnapshot.pools.map((pool) => (
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
                                <div className="event-source">
                                    {dashboardSnapshot.latestEvent.source}
                                </div>
                                <h3>{dashboardSnapshot.latestEvent.region}</h3>
                                <dl>
                                    <div>
                                        <dt>{t("eventPanel.statusLabel")}</dt>
                                        <dd>
                                            {t(`status.${dashboardSnapshot.latestEvent.status}`)}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>{t("eventPanel.intensityLabel")}</dt>
                                        <dd>{dashboardSnapshot.latestEvent.intensity}</dd>
                                    </div>
                                    <div>
                                        <dt>{t("eventPanel.affectedCellsLabel")}</dt>
                                        <dd>{dashboardSnapshot.latestEvent.affectedCells}</dd>
                                    </div>
                                    <div>
                                        <dt>{t("eventPanel.claimWindowLabel")}</dt>
                                        <dd>{dashboardSnapshot.latestEvent.claimWindow}</dd>
                                    </div>
                                </dl>
                                <a className="text-action" href="/events">
                                    {dashboardSnapshot.latestEvent.id}
                                </a>
                            </div>
                        </section>

                        <ActivityPanel
                            actionHref="/donor"
                            actionLabel={t("donations.action")}
                            items={dashboardSnapshot.donations}
                            title={t("donations.title")}
                        />
                        <ActivityPanel
                            actionHref="/claim"
                            actionLabel={t("claims.action")}
                            items={dashboardSnapshot.claims}
                            title={t("claims.title")}
                        />
                        <ActivityPanel
                            actionHref="/receipts"
                            actionLabel={t("receiptsPanel.action")}
                            items={dashboardSnapshot.receipts}
                            title={t("receiptsPanel.title")}
                        />

                        <section
                            className="dash-panel dash-panel-wide"
                            aria-labelledby="supporters-title"
                        >
                            <PanelHeader
                                actionHref="/leaderboard"
                                actionLabel={t("supportersPanel.action")}
                                eyebrow={t("supportersPanel.eyebrow")}
                                titleId="supporters-title"
                                title={t("supportersPanel.title")}
                            />
                            <div className="dashboard-supporters">
                                <SupporterColumn
                                    supporters={dashboardSnapshot.topDonors}
                                    title={t("supportersPanel.individualDonors")}
                                />
                                <SupporterColumn
                                    supporters={dashboardSnapshot.topSponsors}
                                    title={t("supportersPanel.corporateSponsors")}
                                />
                            </div>
                        </section>
                    </section>
                </main>
            </div>
        </>
    );
}

function PanelHeader({
    actionHref,
    actionLabel,
    eyebrow,
    title,
    titleId,
}: {
    actionHref: string;
    actionLabel: string;
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
            <a className="text-action" href={actionHref}>
                {actionLabel}
            </a>
        </div>
    );
}

function PoolRow({ pool }: { pool: PoolSummary }) {
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
    actionHref: string;
    actionLabel: string;
    items: ActivityItem[];
    title: string;
}) {
    const t = useTranslations("dashboard");

    return (
        <section className="dash-panel">
            <PanelHeader actionHref={actionHref} actionLabel={actionLabel} title={title} />
            <div className="activity-list">
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

function SupporterColumn({ supporters, title }: { supporters: Supporter[]; title: string }) {
    const t = useTranslations("dashboard.supportersPanel");

    return (
        <section className="supporter-group" aria-label={title}>
            <div className="supporter-group-label">{title}</div>
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
