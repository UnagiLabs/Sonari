"use client";

import { useCurrentClient } from "@mysten/dapp-kit-react";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
    GENESIS_OBJECT_KIND,
    readGenesisObjectIds,
    selectGenesisObjectId,
} from "./chain/genesis-objects";
import { readDashboardPools } from "./dashboard/dashboard-chain";
import { type DashboardPoolSummary, deriveFeaturedPools } from "./dashboard/dashboard-view-model";
import { readDonateDestinations } from "./donate/donate-destinations";
import {
    type DonateDestinationReadState,
    selectEmergencyBannerCampaign,
} from "./donate/donate-view-state";
import { EmergencyBanner } from "./donate/emergency-banner";
import type { EmergencyBannerCampaign } from "./donate/emergency-banner-state";
import { SiteTopbar } from "./i18n/site-topbar";
import type { SonariLocale } from "./register/wizard/locale";
import { readWalletNetwork, resolveGrpcBaseUrl } from "./wallet/wallet-network";

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

// ハッカソンの実スポンサー。表示順は指定どおり固定する。
// logo は public/assets/sponsors の画像パス。
// chip が true のロゴは黒一色で背景に埋もれるため、白背景チップに乗せる。
const sponsors = [
    { name: "Sui", logo: "/assets/sponsors/sui.png", chip: false },
    { name: "Walrus", logo: "/assets/sponsors/walrus.svg", chip: true },
    { name: "DeepBook", logo: "/assets/sponsors/deepbook.png", chip: false },
    { name: "Mysten Labs", logo: "/assets/sponsors/mysten-labs.png", chip: false },
    { name: "Scallop.io", logo: "/assets/sponsors/scallop.png", chip: false },
    { name: "OpenZeppelin", logo: "/assets/sponsors/openzeppelin.png", chip: false },
    { name: "OtterSec", logo: "/assets/sponsors/ottersec.png", chip: false },
] as const;

// トップページに出す注目プールの静的設定。Operations Pool は運営費のため出さない。
// 金額は実残高をチェーンから取得して埋める（FeaturedPools 参照）。icon と画像は固定。
const FEATURED_POOLS: readonly { key: "main" | "earthquake"; icon: IconName; image: string }[] = [
    { key: "main", icon: "waves", image: "/assets/pool_main_support.jpg" },
    { key: "earthquake", icon: "bolt", image: "/assets/donation_earthquake.png" },
];

// pool ID は環境変数ではなく funding package ID 起点の genesis イベントから導出する。
const fundingPackageId = process.env.NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID ?? "";

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

/**
 * デモ用ホームが固定キャンペーンを差し込むための設定。
 * 本番ホームは demo を渡さないため、緊急バナーはチェーン実データから判定する。
 */
export interface HomeDemoConfig {
    readonly emergencyCampaign: EmergencyBannerCampaign;
}

export function HomeView({
    locale,
    demo,
}: {
    readonly locale: SonariLocale;
    readonly demo?: HomeDemoConfig;
}) {
    const t = useTranslations("home");

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="home" locale={locale} />

                <main className="page">
                    {demo !== undefined ? (
                        <HomeEmergencyBannerView
                            campaign={demo.emergencyCampaign}
                            donateHref="/demo/donate"
                        />
                    ) : (
                        <HomeEmergencyBanner />
                    )}

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
                        <FeaturedPools locale={locale} />
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

// 緊急バナーを描く共通の薄い包み。
// campaign が null のときは EmergencyBanner 側が何も描かない（非表示）。
// onDonate は donateHref への遷移に留め、チェーン送金は起こさない（本番・デモとも）。
function HomeEmergencyBannerView({
    campaign,
    donateHref,
}: {
    campaign: EmergencyBannerCampaign | null;
    donateHref: string;
}) {
    const router = useRouter();
    return (
        <EmergencyBanner
            campaign={campaign}
            onDonate={() => {
                router.push(donateHref);
            }}
        />
    );
}

// 本番ホームの緊急バナー。チェーンからキャンペーンを読み、実施中のものだけ表示する。
// 取得は donate ページと同じ readDonateDestinations を使う。読み込み中・失敗・
// 該当なしのときは selectEmergencyBannerCampaign が null を返し、バナーは出ない（fail-close）。
function HomeEmergencyBanner() {
    const network = readWalletNetwork();
    const [state, setState] = useState<DonateDestinationReadState>({
        status: "loading",
        campaigns: [],
        categories: [],
        errorMessage: null,
    });

    useEffect(() => {
        // funding package 未設定では実施中キャンペーンを判定できないため非表示にする。
        if (fundingPackageId.trim().length === 0) {
            setState({
                status: "error",
                campaigns: [],
                categories: [],
                errorMessage: "NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID is required.",
            });
            return;
        }

        const client = new SuiJsonRpcClient({ network, url: resolveGrpcBaseUrl(network) });
        let cancelled = false;
        setState({ status: "loading", campaigns: [], categories: [], errorMessage: null });

        void (async () => {
            try {
                const result = await readDonateDestinations(client, {
                    packageId: fundingPackageId,
                });
                if (cancelled) {
                    return;
                }
                if (result.kind === "ok") {
                    setState({
                        status: "ready",
                        campaigns: result.campaigns,
                        categories: result.categories,
                        errorMessage: null,
                    });
                    return;
                }
                setState({
                    status: "error",
                    campaigns: [],
                    categories: [],
                    errorMessage: result.message,
                });
            } catch (error) {
                if (cancelled) {
                    return;
                }
                setState({
                    status: "error",
                    campaigns: [],
                    categories: [],
                    errorMessage:
                        error instanceof Error
                            ? error.message
                            : "Failed to load emergency campaign.",
                });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [network]);

    // 現在時刻で実施中判定する。該当が無ければ null になりバナーは非表示。
    const campaign = selectEmergencyBannerCampaign(state, BigInt(Date.now()));
    return <HomeEmergencyBannerView campaign={campaign} donateHref="/donate" />;
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
    // 7社を1行で流す。シームレスにループさせるため同じ並びを2コピー複製する。
    // 各社はロゴ画像と社名を横並びで表示する。リンクはなし。
    // 画像が読み込めないときは alt の社名が表示される。
    return (
        <div className="marquee-wrap">
            <div className="marquee">
                {(["first", "second"] as const).flatMap((copy) =>
                    sponsors.map((sponsor) => (
                        <div className="marquee-item" key={`${copy}-${sponsor.name}`}>
                            <span
                                className={`sponsor-logo-frame${
                                    sponsor.chip ? " sponsor-logo-chip" : ""
                                }`}
                            >
                                {/* biome-ignore lint/performance/noImgElement: next.config の images.unoptimized:true で画像最適化は無効なため next/image の利点がなく、社ごとに縦横比が異なり SVG も含むため素の img が扱いやすい。 */}
                                <img
                                    alt={sponsor.name}
                                    className="sponsor-logo"
                                    src={sponsor.logo}
                                />
                            </span>
                            <span>{sponsor.name}</span>
                        </div>
                    )),
                )}
            </div>
        </div>
    );
}

type FeaturedPoolsState =
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly pools: readonly DashboardPoolSummary[] }
    | { readonly status: "error" };

// Featured pools をチェーンの実残高で描画する。取得はダッシュボードと同じ流れ。
// 読み込み中・失敗時はカードの骨格だけ出し、金額は出さない（fail-close）。
function FeaturedPools({ locale }: { locale: SonariLocale }) {
    const client = useCurrentClient();
    const network = readWalletNetwork();
    const [state, setState] = useState<FeaturedPoolsState>({ status: "loading" });
    const cancelRef = useRef<() => void>(() => {});

    const load = useCallback((): (() => void) => {
        cancelRef.current();

        // 詳細な原因は開発者向けに console へ出し、画面には金額を出さない。
        const failClosed = (detail: string) => {
            console.error(`featured pools load failed: ${detail}`);
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

            const poolResult = await readDashboardPools(client, {
                mainPoolId,
                operationsPoolId,
                categoryPoolId,
            });
            if (cancelled) {
                return;
            }
            if (poolResult.kind === "error") {
                failClosed(poolResult.message);
                return;
            }
            setState({ status: "ready", pools: deriveFeaturedPools(poolResult.pools, locale) });
        })().catch((error: unknown) => {
            if (cancelled) {
                return;
            }
            failClosed(error instanceof Error ? error.message : "unknown error");
        });

        return cancel;
    }, [client, network, locale]);

    useEffect(() => load(), [load]);

    const summaries = state.status === "ready" ? state.pools : [];

    return (
        <div className="pools-grid" aria-busy={state.status === "loading"}>
            {FEATURED_POOLS.map(({ key, icon, image }) => (
                <PoolCard
                    key={key}
                    poolKey={key}
                    icon={icon}
                    image={image}
                    summary={summaries.find((pool) => pool.key === key) ?? null}
                />
            ))}
        </div>
    );
}

function PoolCard({
    poolKey,
    icon,
    image,
    summary,
}: {
    poolKey: "main" | "earthquake";
    icon: IconName;
    image: string;
    summary: DashboardPoolSummary | null;
}) {
    const t = useTranslations("home.pools");
    const placeholder = "—";

    return (
        <a className="pool-card" href="/pools">
            <figure className="pool-image">
                <Image
                    src={image}
                    alt={t(`${poolKey}.imageAlt`)}
                    fill
                    sizes="(min-width: 920px) 33vw, 100vw"
                />
            </figure>
            <div className="header">
                <div className="icon">
                    <Icon name={icon} size={20} />
                </div>
                <span className="tag tag-ok tag-dot">{t("statusActive")}</span>
            </div>
            <div>
                <h3>{t(`${poolKey}.name`)}</h3>
                <p className="muted">{t(`${poolKey}.description`)}</p>
            </div>
            <div>
                <div className="balance">{summary ? summary.available : placeholder}</div>
                <div className="faint">{t("available")}</div>
            </div>
            <div>
                <div className="meter">
                    <div
                        className="meter-fill"
                        style={{ width: `${summary ? summary.percentAvailable : 0}%` }}
                    />
                </div>
                <div className="footer-row">
                    <span>
                        {t("received", { amount: summary ? summary.received : placeholder })}
                    </span>
                    <span>
                        {t("delivered", { amount: summary ? summary.paidOut : placeholder })}
                    </span>
                </div>
            </div>
        </a>
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
