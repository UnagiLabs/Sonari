import Image from "next/image";
import type { ReactNode } from "react";
import { WalletConnect } from "./wallet/wallet-connect";

type IconName =
    | "arrowRight"
    | "check"
    | "eye"
    | "heart"
    | "lock"
    | "shield"
    | "sprout"
    | "verified"
    | "waves"
    | "bolt";

type Sponsor = {
    name: string;
    logo: string;
    color: string;
};

type Pool = {
    name: string;
    description: string;
    balance: string;
    received: string;
    delivered: string;
    percent: number;
    icon: IconName;
    image: string;
    imageAlt: string;
};

type Donor = {
    name: string;
    amount: string;
    meta: string;
    corporate?: boolean;
};

const impactStats = [
    { label: "Total donated", value: "$3.2M", meta: "+ $48,200 in 24h" },
    { label: "Relief delivered", value: "$1.2M", meta: "1,291 verified claims" },
    { label: "Active pools", value: "2", meta: "Main and earthquake" },
    { label: "Verified events", value: "14", meta: "USGS source data" },
];

const sponsors: Sponsor[] = [
    { name: "Aizome Foundation", logo: "AF", color: "oklch(0.55 0.06 145)" },
    { name: "Kibou Capital", logo: "KC", color: "oklch(0.58 0.07 120)" },
    { name: "Midori Logistics", logo: "ML", color: "oklch(0.5 0.05 170)" },
    { name: "Hinode Bank", logo: "HB", color: "oklch(0.6 0.07 50)" },
    { name: "Sora Networks", logo: "SN", color: "oklch(0.5 0.06 230)" },
    { name: "Kogane Energy", logo: "KE", color: "oklch(0.62 0.08 80)" },
    { name: "Yume Robotics", logo: "YR", color: "oklch(0.5 0.06 290)" },
    { name: "Hana Health", logo: "HH", color: "oklch(0.6 0.06 10)" },
    { name: "Niji Studios", logo: "NS", color: "oklch(0.58 0.07 300)" },
    { name: "Kawa Mobility", logo: "KM", color: "oklch(0.5 0.05 180)" },
    { name: "Tomoshibi Co-op", logo: "TC", color: "oklch(0.55 0.06 140)" },
    { name: "Mori Cloud", logo: "MC", color: "oklch(0.54 0.05 200)" },
];

const pools: Pool[] = [
    {
        name: "Main Pool",
        description: "General relief reserves across active programs.",
        balance: "$1.28M",
        received: "$2.10M received",
        delivered: "$820K delivered",
        percent: 61,
        icon: "waves",
        image: "/assets/donation_flood.webp",
        imageAlt: "Community recovery aid after flooding",
    },
    {
        name: "Earthquake Relief Pool",
        description: "Reserved for finalized earthquake events.",
        balance: "$642K",
        received: "$980K received",
        delivered: "$337K delivered",
        percent: 66,
        icon: "bolt",
        image: "/assets/donation_earthquake.png",
        imageAlt: "Earthquake relief supplies",
    },
];

const individualDonors: Donor[] = [
    { name: "haru.sui", amount: "$89,400", meta: "41 donations, Earthquake" },
    { name: "Anonymous Donor", amount: "$52,100", meta: "19 donations, Main" },
    { name: "matcha_dev", amount: "$34,200", meta: "52 donations, Earthquake" },
];

const corporateDonors: Donor[] = [
    { name: "Aizome Foundation", amount: "$524,800", meta: "84 donations", corporate: true },
    { name: "Kibou Capital", amount: "$412,300", meta: "62 donations", corporate: true },
    { name: "Midori Logistics", amount: "$76,250", meta: "28 donations", corporate: true },
];

const steps = [
    {
        number: "01",
        title: "Donate in USDC",
        body: "Choose a pool. Donations are recorded on-chain with a DonorPass contribution history.",
    },
    {
        number: "02",
        title: "Disaster verified",
        body: "USGS reports are re-fetched and signed only after the source data matches.",
    },
    {
        number: "03",
        title: "Eligibility checked",
        body: "Recipients need an active pass and a residence proof inside the affected H3 cells.",
    },
    {
        number: "04",
        title: "Relief, with a receipt",
        body: "Each payout creates an anonymized Impact Receipt without exposing personal details.",
    },
];

const values = [
    {
        icon: "eye" as const,
        title: "Witnessable end to end",
        body: "Donation, eligibility, and payout activity is visible through public receipts.",
    },
    {
        icon: "lock" as const,
        title: "Recipient-private by design",
        body: "Raw addresses, phone numbers, and personal identifiers stay off-chain.",
    },
    {
        icon: "shield" as const,
        title: "Checked before aid moves",
        body: "A finalized event, active pass, and valid residence proof are required.",
    },
];

const trustItems = [
    "Donating does not create claim rights.",
    "Top donors get recognition, not payout priority.",
    "Relief is paid to the verified Membership SBT owner.",
    "KYC and World ID follow the same full-support route.",
    "Pause, oracle, and sponsor controls are visible.",
    "Sponsor logos require verification and approval.",
];

export default function LandingPage() {
    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <header className="topbar">
                    <div className="topbar-inner">
                        <a className="brand" href="#top" aria-label="Sonari home">
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
                            <a className="nav-item active" href="#top">
                                Home
                            </a>
                            <a className="nav-item" href="/donate">
                                Donate
                            </a>
                            <a className="nav-item" href="/dashboard">
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
                        <WalletConnect />
                    </div>
                </header>

                <main className="page">
                    <section className="hero" aria-labelledby="hero-title">
                        <div className="hero-grid">
                            <div>
                                <div className="hero-eyebrow">
                                    <Icon name="sprout" size={14} />
                                    Transparent donation infrastructure
                                </div>
                                <h1 id="hero-title">
                                    Donations that <span className="alt">arrive</span>
                                    <br />
                                    where they're needed.
                                </h1>
                                <p className="hero-sub">
                                    Sonari verifies who should receive aid after a disaster using
                                    public source data, privacy-preserving residence proofs, and
                                    transparent receipts.
                                </p>
                                <nav className="hero-ctas" aria-label="Primary actions">
                                    <a className="btn btn-primary btn-lg" href="/donate">
                                        <Icon name="heart" size={16} />
                                        Donate now
                                    </a>
                                    <a className="btn btn-secondary btn-lg" href="/claim">
                                        Claim relief
                                        <Icon name="arrowRight" size={16} />
                                    </a>
                                    <a className="btn btn-ghost btn-lg" href="/dashboard">
                                        View dashboard
                                    </a>
                                </nav>
                                <div className="hero-notes">
                                    <span>
                                        <Icon name="lock" size={14} />
                                        Residence data stays private
                                    </span>
                                    <span>
                                        <Icon name="verified" size={14} />
                                        Verified disaster events
                                    </span>
                                </div>
                            </div>

                            <div className="hero-illustration" aria-hidden="true">
                                <Image
                                    src="/assets/sonari_logo.png"
                                    alt=""
                                    width={720}
                                    height={720}
                                    priority
                                />
                            </div>
                        </div>

                        <div className="metrics-strip hero-stats-grid">
                            {impactStats.map((stat) => (
                                <StatCard
                                    key={stat.label}
                                    label={stat.label}
                                    meta={stat.meta}
                                    value={stat.value}
                                />
                            ))}
                        </div>
                    </section>

                    <section className="section-tight" aria-labelledby="sponsors-title">
                        <div className="eyebrow sponsor-title" id="sponsors-title">
                            Supported by transparent partners
                        </div>
                        <SponsorMarquee />
                    </section>

                    <section className="section" aria-labelledby="how-title">
                        <SectionHeader
                            eyebrow="How Sonari works"
                            sub="No hidden discretion. No payout promises. Just verifiable steps anyone can audit."
                            title="Four steps from donation to relief."
                        />
                        <ol className="steps" aria-label="Donation to relief flow">
                            {steps.map((step) => (
                                <li className="step" key={step.number}>
                                    <span className="step-num">{step.number}</span>
                                    <h4>{step.title}</h4>
                                    <p>{step.body}</p>
                                </li>
                            ))}
                        </ol>
                    </section>

                    <section className="section" aria-labelledby="pools-title">
                        <SectionHeader
                            action={
                                <a className="btn btn-ghost" href="/pools">
                                    All pools <Icon name="arrowRight" size={14} />
                                </a>
                            }
                            eyebrow="Featured pools"
                            title="See where each dollar lives."
                        />
                        <div className="pools-grid">
                            {pools.map((pool) => (
                                <PoolCard key={pool.name} pool={pool} />
                            ))}
                        </div>
                    </section>

                    <section className="section" aria-labelledby="supporters-title">
                        <SectionHeader
                            action={
                                <a className="btn btn-ghost" href="/leaderboard">
                                    Full leaderboard <Icon name="arrowRight" size={14} />
                                </a>
                            }
                            eyebrow="Top supporters"
                            title="People and partners keeping the reserve full."
                        />
                        <SupporterList />
                    </section>

                    <section className="section" aria-labelledby="why-title">
                        <SectionHeader
                            eyebrow="Why Sonari"
                            title="Donation infrastructure, not a payout promise."
                        />
                        <div className="value-grid">
                            {values.map((value) => (
                                <article className="value-item" key={value.title}>
                                    <div className="icon-wrap">
                                        <Icon name={value.icon} size={22} />
                                    </div>
                                    <h4>{value.title}</h4>
                                    <p>{value.body}</p>
                                </article>
                            ))}
                        </div>
                    </section>

                    <section className="section">
                        <div className="trust-banner">
                            <div>
                                <div className="eyebrow">Important to know</div>
                                <h2>Sonari is aid infrastructure for transparent donations.</h2>
                                <p className="muted trust-copy">
                                    DonorPass records contribution history only. Receiving relief
                                    depends on verified eligibility for a finalized disaster event.
                                </p>
                            </div>
                            <div className="trust-list">
                                {trustItems.map((item) => (
                                    <div className="trust-list-item" key={item}>
                                        <div className="check">
                                            <Icon name="check" size={13} />
                                        </div>
                                        <span>{item}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </section>
                </main>

                <footer className="footer">
                    <div className="footer-inner">
                        <div className="footer-col footer-brand-col">
                            <a className="brand" href="#top" aria-label="Sonari home">
                                <span className="brand-mark">
                                    <Image
                                        src="/assets/sonari_logo.png"
                                        alt="Sonari"
                                        width={36}
                                        height={36}
                                    />
                                </span>
                                <span className="brand-name">Sonari</span>
                            </a>
                            <p className="muted">
                                Transparent donation infrastructure for verified aid.
                            </p>
                        </div>
                        <FooterColumn
                            links={["Donate", "Dashboard", "Leaderboard"]}
                            title="Public"
                        />
                        <FooterColumn links={["Claim", "Register", "Receipts"]} title="Recipient" />
                        <FooterColumn
                            links={["Pools", "Events", "Sponsors"]}
                            title="Transparency"
                        />
                    </div>
                    <div className="footer-bottom">
                        <span>2026 Sonari</span>
                        <span>Donation, aid, support, impact.</span>
                    </div>
                </footer>
            </div>
        </>
    );
}

function SectionHeader({
    action,
    eyebrow,
    sub,
    title,
}: {
    action?: ReactNode;
    eyebrow: string;
    sub?: string;
    title: string;
}) {
    return (
        <div className="section-title-row">
            <div>
                <div className="eyebrow">{eyebrow}</div>
                <h2>{title}</h2>
                {sub ? <p className="sub muted">{sub}</p> : null}
            </div>
            {action ? <div>{action}</div> : null}
        </div>
    );
}

function StatCard({ label, meta, value }: { label: string; meta: string; value: string }) {
    return (
        <article className="metric-item">
            <div className="label">{label}</div>
            <div className="value">{value}</div>
            <div className="meta">{meta}</div>
        </article>
    );
}

function SponsorMarquee() {
    const firstRow = sponsors.slice(0, 6);
    const secondRow = sponsors.slice(6, 12);

    return (
        <div className="sponsor-marquee">
            <SponsorRow sponsors={firstRow} />
            <SponsorRow reverse sponsors={secondRow} />
        </div>
    );
}

function SponsorRow({
    reverse = false,
    sponsors: row,
}: {
    reverse?: boolean;
    sponsors: Sponsor[];
}) {
    return (
        <div className="marquee-wrap">
            <div className={`marquee ${reverse ? "reverse" : ""}`}>
                {(["first", "second"] as const).flatMap((copy) =>
                    row.map((sponsor) => (
                        <a
                            className="marquee-item"
                            href="/sponsors"
                            key={`${copy}-${sponsor.name}`}
                        >
                            <span className="logo-square" style={{ background: sponsor.color }}>
                                {sponsor.logo}
                            </span>
                            <span>{sponsor.name}</span>
                        </a>
                    )),
                )}
            </div>
        </div>
    );
}

function PoolCard({ pool }: { pool: Pool }) {
    return (
        <a className="pool-card" href="/pools">
            <figure className="pool-image">
                <Image
                    src={pool.image}
                    alt={pool.imageAlt}
                    fill
                    sizes="(min-width: 920px) 33vw, 100vw"
                />
            </figure>
            <div className="header">
                <div className="icon">
                    <Icon name={pool.icon} size={20} />
                </div>
                <span className="tag tag-ok tag-dot">active</span>
            </div>
            <div>
                <h3>{pool.name}</h3>
                <p className="muted">{pool.description}</p>
            </div>
            <div>
                <div className="balance">{pool.balance}</div>
                <div className="faint">available balance</div>
            </div>
            <div>
                <div className="meter">
                    <div className="meter-fill" style={{ width: `${pool.percent}%` }} />
                </div>
                <div className="footer-row">
                    <span>{pool.received}</span>
                    <span>{pool.delivered}</span>
                </div>
            </div>
        </a>
    );
}

function SupporterList() {
    return (
        <div className="supporter-list">
            <SupporterGroup donors={individualDonors} label="Individuals" />
            <SupporterGroup donors={corporateDonors} label="Corporate sponsors" />
        </div>
    );
}

function SupporterGroup({ donors, label }: { donors: Donor[]; label: string }) {
    return (
        <section className="supporter-group" aria-label={label}>
            <div className="supporter-group-label">{label}</div>
            {donors.map((donor, index) => (
                <div className="row-item" key={donor.name}>
                    <div className={`avatar ${donor.corporate ? "avatar-sq" : ""}`}>
                        {donor.name
                            .replace(/[^A-Za-z]/g, "")
                            .slice(0, 2)
                            .toUpperCase() || "?"}
                    </div>
                    <div>
                        <div className="row-name">{donor.name}</div>
                        <div className="row-meta">{donor.meta}</div>
                    </div>
                    <div className="row-amount">
                        <span className="stat-num">{donor.amount}</span>
                        <small>#{index + 1}</small>
                    </div>
                </div>
            ))}
        </section>
    );
}

function FooterColumn({ links, title }: { links: string[]; title: string }) {
    return (
        <div className="footer-col">
            <h5>{title}</h5>
            {links.map((link) => (
                <a href={`/${link.toLowerCase()}`} key={link}>
                    {link}
                </a>
            ))}
        </div>
    );
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
    const iconTitle: Record<IconName, string> = {
        arrowRight: "Arrow right",
        bolt: "Bolt",
        check: "Check",
        eye: "Eye",
        heart: "Heart",
        lock: "Lock",
        shield: "Shield",
        sprout: "Sprout",
        verified: "Verified",
        waves: "Waves",
    };
    const props = {
        "aria-hidden": true,
        fill: "none",
        focusable: false,
        height: size,
        role: "presentation",
        stroke: "currentColor",
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
        strokeWidth: 1.6,
        viewBox: "0 0 24 24",
        width: size,
    };

    switch (name) {
        case "arrowRight":
            return (
                <svg {...props}>
                    <title>{iconTitle[name]}</title>
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                </svg>
            );
        case "bolt":
            return (
                <svg {...props}>
                    <title>{iconTitle[name]}</title>
                    <path d="m13 2-9 12h7l-1 8 9-12h-7l1-8z" />
                </svg>
            );
        case "check":
            return (
                <svg {...props}>
                    <title>{iconTitle[name]}</title>
                    <path d="M20 6 9 17l-5-5" />
                </svg>
            );
        case "eye":
            return (
                <svg {...props}>
                    <title>{iconTitle[name]}</title>
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                    <circle cx="12" cy="12" r="3" />
                </svg>
            );
        case "heart":
            return (
                <svg {...props}>
                    <title>{iconTitle[name]}</title>
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l7.78-7.78a5.5 5.5 0 0 0 1.06-8.84z" />
                </svg>
            );
        case "lock":
            return (
                <svg {...props}>
                    <title>{iconTitle[name]}</title>
                    <rect height="11" rx="2" width="18" x="3" y="11" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
            );
        case "shield":
            return (
                <svg {...props}>
                    <title>{iconTitle[name]}</title>
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    <path d="m9 12 2 2 4-4" />
                </svg>
            );
        case "sprout":
            return (
                <svg {...props}>
                    <title>{iconTitle[name]}</title>
                    <path d="M7 20h10" />
                    <path d="M12 20V8" />
                    <path d="M12 8c0-3 2-5 5-5 0 3-2 5-5 5z" />
                    <path d="M12 12c0-2-2-4-5-4 0 2 2 4 5 4z" />
                </svg>
            );
        case "verified":
            return (
                <svg {...props}>
                    <title>{iconTitle[name]}</title>
                    <path d="M12 2 9.5 5 6 4l-1 3.5L2 9.5 4 13l-2 3.5L5 18l1 3.5L9.5 19 12 22l2.5-3 3.5 1 1-3.5 3-2-2-3.5 2-3.5L18 4l-1-3.5L13.5 5 12 2z" />
                    <path d="m9 12 2 2 4-4" />
                </svg>
            );
        case "waves":
            return (
                <svg {...props}>
                    <title>{iconTitle[name]}</title>
                    <path d="M2 6c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2" />
                    <path d="M2 12c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2" />
                    <path d="M2 18c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2" />
                </svg>
            );
    }
}
