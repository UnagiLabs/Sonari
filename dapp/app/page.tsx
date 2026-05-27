import Image from "next/image";

type ImpactStat = {
    label: string;
    value: string;
    detail: string;
};

type Sponsor = {
    name: string;
    tier: string;
};

type Supporter = {
    name: string;
    amount: string;
};

type Pool = {
    name: string;
    description: string;
    balance: string;
    claims: string;
    image: string;
    alt: string;
};

const impactStats: ImpactStat[] = [
    { label: "Total Donated", value: "$428K", detail: "Across active relief pools" },
    { label: "Aid Delivered", value: "$196K", detail: "Sent through verified claims" },
    { label: "Active Pools", value: "12", detail: "Open programs and campaigns" },
    { label: "Verified Claims", value: "842", detail: "Eligibility checked before aid moves" },
];

const sponsorRows: Sponsor[][] = [
    [
        { name: "Northline", tier: "Verified Sponsor" },
        { name: "Civic Grid", tier: "Featured Partner" },
        { name: "Hinode Labs", tier: "Verified Sponsor" },
        { name: "ReliefWorks", tier: "Featured Partner" },
        { name: "Beacon Trust", tier: "Verified Sponsor" },
    ],
    [
        { name: "Kumo Capital", tier: "Verified Sponsor" },
        { name: "Aster Foods", tier: "Featured Partner" },
        { name: "Harbor Cloud", tier: "Verified Sponsor" },
        { name: "Nami Studio", tier: "Verified Sponsor" },
        { name: "Public Ledger", tier: "Featured Partner" },
    ],
];

const individualSupporters: Supporter[] = [
    { name: "Mika T.", amount: "$18,400" },
    { name: "Arun S.", amount: "$14,250" },
    { name: "Noa K.", amount: "$11,900" },
];

const corporateSupporters: Supporter[] = [
    { name: "Civic Grid", amount: "$82,000" },
    { name: "ReliefWorks", amount: "$64,500" },
    { name: "Aster Foods", amount: "$48,000" },
];

const pools: Pool[] = [
    {
        name: "Earthquake Relief Pool",
        description: "Rapid cash support for people verified against disaster eligibility rules.",
        balance: "$168K",
        claims: "326 claims",
        image: "/assets/donation_earthquake.png",
        alt: "Earthquake relief supplies and community support",
    },
    {
        name: "Regional Recovery Pool",
        description: "Campaign funding for local recovery needs after flood and storm events.",
        balance: "$94K",
        claims: "211 claims",
        image: "/assets/donation_flood.webp",
        alt: "Flood recovery donation pool",
    },
    {
        name: "Student Continuity Pool",
        description: "Support for students whose learning is interrupted by emergency hardship.",
        balance: "$52K",
        claims: "In design",
        image: "/assets/donation_student.png",
        alt: "Student support donation pool",
    },
];

const workSteps = [
    {
        title: "Donate to a defined pool",
        text: "Donors choose a program, campaign, or pool with clear conditions and visible balances.",
    },
    {
        title: "Verify eligibility",
        text: "Recipients claim relief only after the relevant source data and program rules are checked.",
    },
    {
        title: "Issue an impact receipt",
        text: "Every finalized claim leaves a transparent receipt without exposing private recipient data.",
    },
];

const trustPoints = [
    "Sonari is donation infrastructure, not insurance or a payout guarantee.",
    "Contracts should trust only signed finalized payloads and verifiable data.",
    "Relayers deliver payloads without changing their meaning.",
    "Sensitive recipient details stay off-chain and are minimized at every boundary.",
];

export default function LandingPage() {
    return (
        <>
            <header className="site-header">
                <div className="wrap nav">
                    <a className="brand" href="#top" aria-label="Sonari home">
                        <Image
                            src="/assets/sonari_logo.png"
                            alt="Sonari"
                            width={56}
                            height={56}
                            priority
                        />
                        <span>Sonari</span>
                    </a>
                    <nav className="nav-links" aria-label="Primary">
                        <a href="/donate">Donate</a>
                        <a href="/dashboard">Dashboard</a>
                        <a href="/leaderboard">Leaderboard</a>
                        <a href="/claim">Claim</a>
                    </nav>
                    <a className="nav-action" href="/donate">
                        Donate
                    </a>
                </div>
            </header>

            <main>
                <section className="hero" aria-labelledby="hero-title">
                    <Image
                        className="hero-image"
                        src="/assets/donation_flood.webp"
                        alt=""
                        fill
                        priority
                        sizes="100vw"
                    />
                    <div className="hero-scrim" />
                    <div className="wrap hero-content">
                        <p className="eyebrow">Transparent donation infrastructure</p>
                        <h1 id="hero-title">Sonari</h1>
                        <p className="hero-lead">
                            Verifiable donation infrastructure that checks who should receive aid
                            and lets donors follow support from pool to impact receipt.
                        </p>
                        <nav className="hero-actions" aria-label="Primary actions">
                            <a className="btn btn-primary" href="/donate">
                                Donate
                            </a>
                            <a className="btn btn-secondary" href="/claim">
                                Claim Relief
                            </a>
                            <a className="btn btn-plain" href="/dashboard">
                                View Dashboard
                            </a>
                        </nav>
                    </div>
                </section>

                <section className="sponsors" aria-labelledby="sponsor-title">
                    <div className="wrap">
                        <p className="section-label" id="sponsor-title">
                            Supported by transparent partners
                        </p>
                    </div>
                    <div className="marquee">
                        {sponsorRows.map((row, rowIndex) => (
                            <div
                                className={`marquee-row ${rowIndex === 1 ? "reverse" : ""}`}
                                key={row.map((sponsor) => sponsor.name).join("-")}
                            >
                                {(["first", "second"] as const).flatMap((copy) =>
                                    row.map((sponsor) => (
                                        <a
                                            className="sponsor-pill"
                                            href="/sponsors"
                                            key={`${copy}-${sponsor.name}`}
                                        >
                                            <span>{sponsor.name}</span>
                                            <small>{sponsor.tier}</small>
                                        </a>
                                    )),
                                )}
                            </div>
                        ))}
                    </div>
                </section>

                <section className="impact section-band" aria-labelledby="impact-title">
                    <div className="wrap">
                        <div className="section-head">
                            <p className="section-label">Live impact</p>
                            <h2 id="impact-title">A public view of what moved, where, and why.</h2>
                        </div>
                        <div className="stats-grid">
                            {impactStats.map((stat) => (
                                <article className="stat-card" key={stat.label}>
                                    <span>{stat.label}</span>
                                    <strong>{stat.value}</strong>
                                    <p>{stat.detail}</p>
                                </article>
                            ))}
                        </div>
                    </div>
                </section>

                <section className="supporters" aria-labelledby="supporters-title">
                    <div className="wrap split-section">
                        <div className="section-head">
                            <p className="section-label">Top supporters</p>
                            <h2 id="supporters-title">
                                Recognition for people and sponsors backing aid.
                            </h2>
                            <a className="text-link" href="/leaderboard">
                                View full leaderboard
                            </a>
                        </div>
                        <div className="leaderboard-grid">
                            <SupporterList
                                title="Individual Donors"
                                supporters={individualSupporters}
                            />
                            <SupporterList
                                title="Corporate Sponsors"
                                supporters={corporateSupporters}
                            />
                        </div>
                    </div>
                </section>

                <section className="how section-band" aria-labelledby="how-title">
                    <div className="wrap">
                        <div className="section-head">
                            <p className="section-label">How Sonari works</p>
                            <h2 id="how-title">Simple for donors, strict at the trust boundary.</h2>
                        </div>
                        <div className="step-grid">
                            {workSteps.map((step, index) => (
                                <article className="step" key={step.title}>
                                    <span>{String(index + 1).padStart(2, "0")}</span>
                                    <h3>{step.title}</h3>
                                    <p>{step.text}</p>
                                </article>
                            ))}
                        </div>
                    </div>
                </section>

                <section className="featured-pools" aria-labelledby="pools-title">
                    <div className="wrap">
                        <div className="section-head section-head-row">
                            <div>
                                <p className="section-label">Featured pools</p>
                                <h2 id="pools-title">Give to active pools with clear purpose.</h2>
                            </div>
                            <a className="text-link" href="/pools">
                                View all pools
                            </a>
                        </div>
                        <div className="pool-grid">
                            {pools.map((pool) => (
                                <article className="pool-card" key={pool.name}>
                                    <figure>
                                        <Image
                                            src={pool.image}
                                            alt={pool.alt}
                                            fill
                                            sizes="(min-width: 920px) 33vw, 100vw"
                                        />
                                    </figure>
                                    <div className="pool-card-body">
                                        <h3>{pool.name}</h3>
                                        <p>{pool.description}</p>
                                        <div className="pool-meta">
                                            <span>{pool.balance}</span>
                                            <span>{pool.claims}</span>
                                        </div>
                                    </div>
                                </article>
                            ))}
                        </div>
                    </div>
                </section>

                <section className="trust section-band" aria-labelledby="trust-title">
                    <div className="wrap trust-layout">
                        <div className="section-head">
                            <p className="section-label">Trust and privacy</p>
                            <h2 id="trust-title">
                                Aid can be transparent without exposing people.
                            </h2>
                            <p>
                                Sonari separates detection, verification, relaying, and contract
                                checks so no single off-chain actor becomes the source of truth.
                            </p>
                        </div>
                        <ul className="trust-list">
                            {trustPoints.map((point) => (
                                <li key={point}>{point}</li>
                            ))}
                        </ul>
                    </div>
                </section>
            </main>

            <footer className="site-footer">
                <div className="wrap footer-layout">
                    <div>
                        <a className="brand footer-brand" href="#top" aria-label="Sonari home">
                            <Image
                                src="/assets/sonari_logo.png"
                                alt="Sonari"
                                width={52}
                                height={52}
                            />
                            <span>Sonari</span>
                        </a>
                        <p>Transparent donation infrastructure for verified aid.</p>
                    </div>
                    <nav className="footer-links" aria-label="Footer">
                        <a href="/donate">Donate</a>
                        <a href="/claim">Claim</a>
                        <a href="/events">Events</a>
                        <a href="/receipts">Receipts</a>
                    </nav>
                </div>
            </footer>
        </>
    );
}

function SupporterList({ title, supporters }: { title: string; supporters: Supporter[] }) {
    return (
        <article className="supporter-card">
            <h3>{title}</h3>
            <ol>
                {supporters.map((supporter) => (
                    <li key={supporter.name}>
                        <span>{supporter.name}</span>
                        <strong>{supporter.amount}</strong>
                    </li>
                ))}
            </ol>
        </article>
    );
}
