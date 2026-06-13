"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { SiteTopbar } from "./i18n/site-topbar";
import type { SonariLocale } from "./register/wizard/locale";

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
    key: "main" | "earthquake";
    balance: string;
    receivedAmount: string;
    deliveredAmount: string;
    percent: number;
    icon: IconName;
    image: string;
};

type Donor = {
    name: string;
    amount: string;
    meta: string;
    corporate?: boolean;
};

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
        key: "main",
        balance: "$1.28M",
        receivedAmount: "$2.10M",
        deliveredAmount: "$820K",
        percent: 61,
        icon: "waves",
        image: "/assets/donation_flood.webp",
    },
    {
        key: "earthquake",
        balance: "$642K",
        receivedAmount: "$980K",
        deliveredAmount: "$337K",
        percent: 66,
        icon: "bolt",
        image: "/assets/donation_earthquake.png",
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

const stepKeys = ["step1", "step2", "step3", "step4"] as const;
const stepNumbers: Record<(typeof stepKeys)[number], string> = {
    step1: "01",
    step2: "02",
    step3: "03",
    step4: "04",
};

const valueKeys = [
    { key: "witnessable", icon: "eye" as const },
    { key: "private", icon: "lock" as const },
    { key: "checked", icon: "shield" as const },
] as const;

const trustKeys = ["item1", "item2", "item3", "item4", "item5", "item6"] as const;

const footerColumns = [
    {
        titleKey: "publicTitle",
        links: [
            { key: "linkDonate", href: "/donate" },
            { key: "linkDashboard", href: "/dashboard" },
        ],
    },
    {
        titleKey: "recipientTitle",
        links: [
            { key: "linkClaim", href: "/claim" },
            { key: "linkRegister", href: "/register" },
            { key: "linkReceipts", href: "/receipts" },
        ],
    },
    {
        titleKey: "transparencyTitle",
        links: [
            { key: "linkPools", href: "/pools" },
            { key: "linkEvents", href: "/events" },
            { key: "linkSponsors", href: "/sponsors" },
        ],
    },
] as const;

export function HomeView({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("home");

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="home" locale={locale} />

                <main className="page">
                    <section className="hero" aria-labelledby="hero-title">
                        <div className="hero-grid">
                            <div>
                                <div className="hero-eyebrow">
                                    <Icon name="sprout" size={14} />
                                    {t("hero.eyebrow")}
                                </div>
                                <h1 id="hero-title">
                                    {t("hero.titleBefore")}
                                    <span className="alt">{t("hero.titleHighlight")}</span>
                                    <br />
                                    {t("hero.titleAfter")}
                                </h1>
                                <p className="hero-sub">{t("hero.sub")}</p>
                                <nav className="hero-ctas" aria-label="Primary actions">
                                    <a className="btn btn-primary btn-lg" href="/donate">
                                        <Icon name="heart" size={16} />
                                        {t("hero.ctaDonate")}
                                    </a>
                                    <a className="btn btn-secondary btn-lg" href="/register">
                                        {t("hero.ctaMember")}
                                        <Icon name="arrowRight" size={16} />
                                    </a>
                                    <a className="btn btn-ghost btn-lg" href="/claim">
                                        {t("hero.ctaClaim")}
                                    </a>
                                    <a className="btn btn-ghost btn-lg" href="/dashboard">
                                        {t("hero.ctaDashboard")}
                                    </a>
                                </nav>
                                <div className="hero-notes">
                                    <span>
                                        <Icon name="lock" size={14} />
                                        {t("hero.notePrivate")}
                                    </span>
                                    <span>
                                        <Icon name="verified" size={14} />
                                        {t("hero.noteVerified")}
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
                    </section>

                    <section className="section-tight" aria-labelledby="sponsors-title">
                        <div className="eyebrow sponsor-title" id="sponsors-title">
                            {t("sponsors.title")}
                        </div>
                        <SponsorMarquee />
                    </section>

                    <section className="section" aria-labelledby="how-title">
                        <SectionHeader
                            eyebrow={t("how.eyebrow")}
                            sub={t("how.sub")}
                            title={t("how.title")}
                        />
                        <ol className="steps" aria-label={t("how.title")}>
                            {stepKeys.map((key) => (
                                <li className="step" key={key}>
                                    <span className="step-num">{stepNumbers[key]}</span>
                                    <h4>{t(`how.${key}.title`)}</h4>
                                    <p>{t(`how.${key}.body`)}</p>
                                </li>
                            ))}
                        </ol>
                    </section>

                    <section className="section" aria-labelledby="pools-title">
                        <SectionHeader
                            action={
                                <a className="btn btn-ghost" href="/pools">
                                    {t("pools.allPools")} <Icon name="arrowRight" size={14} />
                                </a>
                            }
                            eyebrow={t("pools.eyebrow")}
                            title={t("pools.title")}
                        />
                        <div className="pools-grid">
                            {pools.map((pool) => (
                                <PoolCard key={pool.key} pool={pool} />
                            ))}
                        </div>
                    </section>

                    <section className="section" aria-labelledby="supporters-title">
                        <SectionHeader
                            eyebrow={t("supporters.eyebrow")}
                            title={t("supporters.title")}
                        />
                        <SupporterList />
                    </section>

                    <section className="section" aria-labelledby="why-title">
                        <SectionHeader eyebrow={t("why.eyebrow")} title={t("why.title")} />
                        <div className="value-grid">
                            {valueKeys.map((value) => (
                                <article className="value-item" key={value.key}>
                                    <div className="icon-wrap">
                                        <Icon name={value.icon} size={22} />
                                    </div>
                                    <h4>{t(`why.${value.key}.title`)}</h4>
                                    <p>{t(`why.${value.key}.body`)}</p>
                                </article>
                            ))}
                        </div>
                    </section>

                    <section className="section">
                        <div className="trust-banner">
                            <div>
                                <div className="eyebrow">{t("trust.eyebrow")}</div>
                                <h2>{t("trust.title")}</h2>
                                <p className="muted trust-copy">{t("trust.copy")}</p>
                            </div>
                            <div className="trust-list">
                                {trustKeys.map((key) => (
                                    <div className="trust-list-item" key={key}>
                                        <div className="check">
                                            <Icon name="check" size={13} />
                                        </div>
                                        <span>{t(`trust.${key}`)}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </section>
                </main>

                <footer className="footer">
                    <div className="footer-inner">
                        <div className="footer-col footer-brand-col">
                            <a className="brand" href="/" aria-label="Sonari home">
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
                            <p className="muted">{t("footer.brandDesc")}</p>
                        </div>
                        {footerColumns.map((column) => (
                            <div className="footer-col" key={column.titleKey}>
                                <h5>{t(`footer.${column.titleKey}`)}</h5>
                                {column.links.map((link) => (
                                    <a href={link.href} key={link.key}>
                                        {t(`footer.${link.key}`)}
                                    </a>
                                ))}
                            </div>
                        ))}
                    </div>
                    <div className="footer-bottom">
                        <span>{t("footer.year")}</span>
                        <span>{t("footer.tagline")}</span>
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
    const t = useTranslations("home.pools");

    return (
        <a className="pool-card" href="/pools">
            <figure className="pool-image">
                <Image
                    src={pool.image}
                    alt={t(`${pool.key}.imageAlt`)}
                    fill
                    sizes="(min-width: 920px) 33vw, 100vw"
                />
            </figure>
            <div className="header">
                <div className="icon">
                    <Icon name={pool.icon} size={20} />
                </div>
                <span className="tag tag-ok tag-dot">{t("statusActive")}</span>
            </div>
            <div>
                <h3>{t(`${pool.key}.name`)}</h3>
                <p className="muted">{t(`${pool.key}.description`)}</p>
            </div>
            <div>
                <div className="balance">{pool.balance}</div>
                <div className="faint">{t("available")}</div>
            </div>
            <div>
                <div className="meter">
                    <div className="meter-fill" style={{ width: `${pool.percent}%` }} />
                </div>
                <div className="footer-row">
                    <span>{t("received", { amount: pool.receivedAmount })}</span>
                    <span>{t("delivered", { amount: pool.deliveredAmount })}</span>
                </div>
            </div>
        </a>
    );
}

function SupporterList() {
    const t = useTranslations("home.supporters");

    return (
        <div className="supporter-list">
            <SupporterGroup donors={individualDonors} label={t("individuals")} />
            <SupporterGroup donors={corporateDonors} label={t("corporate")} />
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
