import Image from "next/image";

type Metric = {
    label: string;
    value: string;
    detail: string;
};

type PoolSummary = {
    name: string;
    balance: string;
    received: string;
    paidOut: string;
    reserved: string;
    available: string;
    percentAvailable: number;
    status: "active" | "paused";
};

type ActivityItem = {
    label: string;
    meta: string;
    amount: string;
    status: "confirmed" | "pending" | "finalized";
};

type Supporter = {
    name: string;
    meta: string;
    amount: string;
    rank: number;
};

// Backend integration point: replace this snapshot with API/query data later.
const dashboardSnapshot = {
    generatedAt: "May 28, 2026 19:40 JST",
    metrics: [
        { label: "Total donated", value: "$3.2M", detail: "+ $48,200 in 24h" },
        { label: "Total aid delivered", value: "$1.2M", detail: "1,291 verified claims" },
        { label: "Active pools", value: "2", detail: "Main and earthquake" },
        { label: "Impact receipts", value: "1,291", detail: "Public, anonymized records" },
    ],
    pools: [
        {
            name: "Main Pool",
            balance: "$1.28M",
            received: "$2.10M",
            paidOut: "$820K",
            reserved: "$124K",
            available: "$1.16M",
            percentAvailable: 61,
            status: "active" as const,
        },
        {
            name: "Earthquake Relief Pool",
            balance: "$642K",
            received: "$980K",
            paidOut: "$337K",
            reserved: "$88K",
            available: "$554K",
            percentAvailable: 66,
            status: "active" as const,
        },
    ],
    latestEvent: {
        id: "usgs-2026-0521-184",
        source: "USGS",
        status: "finalized",
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
            status: "confirmed" as const,
        },
        {
            label: "haru.sui",
            meta: "Earthquake Relief Pool · 11 min ago",
            amount: "$1,200",
            status: "confirmed" as const,
        },
        {
            label: "Anonymous Donor",
            meta: "Main Pool · 18 min ago",
            amount: "$80",
            status: "confirmed" as const,
        },
    ],
    claims: [
        {
            label: "recipient · h3-xQzm",
            meta: "usgs-2026-0521-184 · 12 min ago",
            amount: "$280",
            status: "finalized" as const,
        },
        {
            label: "recipient · h3-aBcd",
            meta: "usgs-2026-0521-184 · 18 min ago",
            amount: "$280",
            status: "finalized" as const,
        },
        {
            label: "recipient · h3-9P1q",
            meta: "usgs-2026-0517-021 · 42 min ago",
            amount: "$200",
            status: "finalized" as const,
        },
    ],
    receipts: [
        {
            label: "rcp_8d2e91",
            meta: "Earthquake Relief · Mainnet transaction",
            amount: "$280",
            status: "finalized" as const,
        },
        {
            label: "rcp_8d2e90",
            meta: "Earthquake Relief · Mainnet transaction",
            amount: "$280",
            status: "finalized" as const,
        },
        {
            label: "rcp_8d2e8f",
            meta: "Earthquake Relief · Mainnet transaction",
            amount: "$200",
            status: "finalized" as const,
        },
    ],
    topDonors: [
        { rank: 1, name: "haru.sui", meta: "Individual · 41 donations", amount: "$89,400" },
        { rank: 2, name: "Anonymous Donor", meta: "Individual · 19 donations", amount: "$52,100" },
        { rank: 3, name: "matcha_dev", meta: "Individual · 52 donations", amount: "$34,200" },
    ],
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
        {
            rank: 3,
            name: "Midori Logistics",
            meta: "Corporate · Earthquake",
            amount: "$76,250",
        },
    ],
};

export default function DashboardPage() {
    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <DashboardTopbar />

                <main className="page dashboard-page">
                    <header className="dashboard-hero">
                        <div>
                            <div className="eyebrow">Dashboard</div>
                            <h1>Transparent activity, at a glance.</h1>
                            <p className="muted dashboard-sub">
                                A public view of pool balances, finalized events, recent donations,
                                verified claims, and anonymized impact receipts.
                            </p>
                        </div>
                        <div className="dashboard-actions">
                            <a className="btn btn-primary" href="/donate">
                                Donate
                            </a>
                            <a className="btn btn-secondary" href="/claim">
                                Claim relief
                            </a>
                            <button className="btn btn-ghost" type="button">
                                Refresh data
                            </button>
                        </div>
                    </header>

                    <section className="dashboard-status" aria-label="Data status">
                        <span className="tag tag-ok tag-dot">Preview data</span>
                        <span>Last refreshed {dashboardSnapshot.generatedAt}</span>
                        <span>Public transparency view</span>
                    </section>

                    <section
                        className="metrics-strip dashboard-metrics"
                        aria-label="Impact metrics"
                    >
                        {dashboardSnapshot.metrics.map((metric) => (
                            <MetricItem key={metric.label} metric={metric} />
                        ))}
                    </section>

                    <section className="dashboard-grid" aria-label="Dashboard overview">
                        <section
                            className="dash-panel dash-panel-wide"
                            aria-labelledby="pool-title"
                        >
                            <PanelHeader
                                actionHref="/pools"
                                actionLabel="View pools"
                                eyebrow="Pools"
                                titleId="pool-title"
                                title="Pool balances"
                            />
                            <div className="pool-table">
                                {dashboardSnapshot.pools.map((pool) => (
                                    <PoolRow key={pool.name} pool={pool} />
                                ))}
                            </div>
                        </section>

                        <section className="dash-panel" aria-labelledby="event-title">
                            <PanelHeader
                                actionHref="/events"
                                actionLabel="View events"
                                eyebrow="Latest DisasterEvent"
                                titleId="event-title"
                                title="Finalized source data"
                            />
                            <div className="event-summary">
                                <div className="event-source">
                                    {dashboardSnapshot.latestEvent.source}
                                </div>
                                <h3>{dashboardSnapshot.latestEvent.region}</h3>
                                <dl>
                                    <div>
                                        <dt>Status</dt>
                                        <dd>{dashboardSnapshot.latestEvent.status}</dd>
                                    </div>
                                    <div>
                                        <dt>Intensity</dt>
                                        <dd>{dashboardSnapshot.latestEvent.intensity}</dd>
                                    </div>
                                    <div>
                                        <dt>Affected cells</dt>
                                        <dd>{dashboardSnapshot.latestEvent.affectedCells}</dd>
                                    </div>
                                    <div>
                                        <dt>Claim window</dt>
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
                            actionLabel="Donation history"
                            items={dashboardSnapshot.donations}
                            title="Recent donations"
                        />
                        <ActivityPanel
                            actionHref="/claim"
                            actionLabel="Claim flow"
                            items={dashboardSnapshot.claims}
                            title="Recent claims"
                        />
                        <ActivityPanel
                            actionHref="/receipts"
                            actionLabel="All receipts"
                            items={dashboardSnapshot.receipts}
                            title="Impact receipts"
                        />

                        <section
                            className="dash-panel dash-panel-wide"
                            aria-labelledby="supporters-title"
                        >
                            <PanelHeader
                                actionHref="/leaderboard"
                                actionLabel="Full leaderboard"
                                eyebrow="Leaderboard"
                                titleId="supporters-title"
                                title="Top supporters"
                            />
                            <div className="dashboard-supporters">
                                <SupporterColumn
                                    supporters={dashboardSnapshot.topDonors}
                                    title="Individual donors"
                                />
                                <SupporterColumn
                                    supporters={dashboardSnapshot.topSponsors}
                                    title="Corporate sponsors"
                                />
                            </div>
                        </section>
                    </section>
                </main>
            </div>
        </>
    );
}

function DashboardTopbar() {
    return (
        <header className="topbar">
            <div className="topbar-inner">
                <a className="brand" href="/" aria-label="Sonari home">
                    <span className="brand-mark">
                        <Image
                            src="/assets/sonari_logo.png"
                            alt="Sonari"
                            width={36}
                            height={36}
                            priority
                        />
                    </span>
                    <span className="brand-name">Sonari</span>
                </a>
                <nav className="nav" aria-label="Primary">
                    <a className="nav-item" href="/">
                        Home
                    </a>
                    <a className="nav-item" href="/donate">
                        Donate
                    </a>
                    <a className="nav-item active" href="/dashboard">
                        Dashboard
                    </a>
                    <a className="nav-item" href="/leaderboard">
                        Leaderboard
                    </a>
                    <a className="nav-item" href="/claim">
                        Claim
                    </a>
                </nav>
                <div className="topbar-spacer" />
                <a className="wallet-btn" href="/donate">
                    <span className="wallet-dot" />
                    Donate now
                </a>
            </div>
        </header>
    );
}

function MetricItem({ metric }: { metric: Metric }) {
    return (
        <article className="metric-item">
            <div className="label">{metric.label}</div>
            <div className="value">{metric.value}</div>
            <div className="meta">{metric.detail}</div>
        </article>
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
    return (
        <article className="pool-row">
            <div>
                <div className="pool-row-title">
                    <h3>{pool.name}</h3>
                    <span
                        className={`tag ${pool.status === "active" ? "tag-ok" : "tag-neutral"} tag-dot`}
                    >
                        {pool.status}
                    </span>
                </div>
                <div className="meter">
                    <div className="meter-fill" style={{ width: `${pool.percentAvailable}%` }} />
                </div>
            </div>
            <dl className="pool-row-values">
                <div>
                    <dt>Balance</dt>
                    <dd>{pool.balance}</dd>
                </div>
                <div>
                    <dt>Received</dt>
                    <dd>{pool.received}</dd>
                </div>
                <div>
                    <dt>Paid out</dt>
                    <dd>{pool.paidOut}</dd>
                </div>
                <div>
                    <dt>Reserved</dt>
                    <dd>{pool.reserved}</dd>
                </div>
                <div>
                    <dt>Available</dt>
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
    return (
        <section className="dash-panel">
            <PanelHeader actionHref={actionHref} actionLabel={actionLabel} title={title} />
            <div className="activity-list">
                {items.map((item) => (
                    <ActivityRow item={item} key={`${item.label}-${item.meta}`} />
                ))}
            </div>
        </section>
    );
}

function ActivityRow({ item }: { item: ActivityItem }) {
    return (
        <article className="activity-row">
            <div>
                <div className="activity-label">{item.label}</div>
                <div className="activity-meta">{item.meta}</div>
            </div>
            <div className="activity-amount">
                <span>{item.amount}</span>
                <small>{item.status}</small>
            </div>
        </article>
    );
}

function SupporterColumn({ supporters, title }: { supporters: Supporter[]; title: string }) {
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
                        <small>rank #{supporter.rank}</small>
                    </div>
                </article>
            ))}
        </section>
    );
}
