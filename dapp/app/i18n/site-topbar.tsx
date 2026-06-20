"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import type { SonariLocale } from "../register/wizard/locale";
import { LocaleSwitcher } from "../register/wizard/locale-switcher";
import { NetworkMismatchBanner } from "../wallet/network-mismatch-banner";
import { WalletConnect } from "../wallet/wallet-connect";
import { SiteMobileMenu } from "./site-mobile-menu";
import { NAV_DEFS, type NavKey, type ResolvedNavItem, resolveNavItems } from "./topbar-nav";

// 全ページ共通の topbar（issue #330）。ナビ・言語切替・wallet 接続をまとめ、
// すべてのページが同じヘッダーを使う。プライマリナビは全ページ同一の共通項目で、
// ページごとの出し分けはしない。My Page はアカウント導線として右側に固定し、
// wallet 接続ボタンも常時表示する。各ページは active なナビ項目だけを渡す。
// 文言は topbar.nav.* カタログから引く。

// My Page はプライマリナビとは性質が違うため、右クラスタに固定する。
// モバイルメニューにも載せるため、href は共通ナビと同じ NAV_DEFS から引く。
const MYPAGE_ITEM: ResolvedNavItem = { key: "mypage", href: NAV_DEFS.mypage.href };

export function SiteTopbar({
    active,
    locale,
}: {
    readonly active: NavKey;
    readonly locale: SonariLocale;
}) {
    const t = useTranslations("topbar");
    const navItems = resolveNavItems();
    // ハンバーガーメニューは翻訳に依存しないため、ここで全 nav キーの文言を解決して渡す。
    const navLabels = Object.fromEntries(
        (Object.keys(NAV_DEFS) as NavKey[]).map((key) => [key, t(`nav.${key}`)]),
    ) as Record<NavKey, string>;
    // モバイルメニューでもマイページへ行けるよう、共通ナビの末尾に My Page を足す。
    const mobileItems: readonly ResolvedNavItem[] = [...navItems, MYPAGE_ITEM];

    return (
        <>
            <header className="topbar">
                <div className="topbar-inner">
                    <a aria-label={t("brandHomeAria")} className="brand" href="/">
                        <span className="brand-mark">
                            <Image
                                alt="Sonari"
                                height={36}
                                priority
                                src="/assets/sonari_logo.png"
                                width={36}
                            />
                        </span>
                        <span className="brand-name">Sonari</span>
                    </a>
                    <nav aria-label="Primary" className="nav">
                        {navItems.map((item) => (
                            <a
                                className={`nav-item${item.key === active ? " active" : ""}`}
                                href={item.href}
                                key={item.key}
                            >
                                {t(`nav.${item.key}`)}
                            </a>
                        ))}
                    </nav>
                    <div className="topbar-spacer" />
                    {/* 言語切替・wallet・My Page を 1 つの右クラスタにまとめ、
                        区切り線で「言語」と「アカウント」の役割を視覚的に分ける。 */}
                    <div className="topbar-actions">
                        <LocaleSwitcher current={locale} />
                        <span aria-hidden="true" className="topbar-divider" />
                        <WalletConnect />
                        <a
                            className={`topbar-mypage${active === "mypage" ? " active" : ""}`}
                            href={MYPAGE_ITEM.href}
                        >
                            <span aria-hidden="true" className="topbar-mypage-avatar">
                                <svg
                                    aria-hidden="true"
                                    fill="none"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    width="14"
                                >
                                    <circle
                                        cx="12"
                                        cy="8.5"
                                        r="3.6"
                                        stroke="currentColor"
                                        strokeWidth="1.8"
                                    />
                                    <path
                                        d="M5.5 19c1.2-3.2 3.7-4.6 6.5-4.6s5.3 1.4 6.5 4.6"
                                        stroke="currentColor"
                                        strokeLinecap="round"
                                        strokeWidth="1.8"
                                    />
                                </svg>
                            </span>
                            {t("nav.mypage")}
                        </a>
                    </div>
                    {/* モバイル専用クラスタ（820px 以下で表示）。デザイン刷新により、
                        ヘッダー右側は「wallet 接続ボタン + ハンバーガー」を横並びにする。
                        wallet は本物の接続ボタンを直接見せ（接続後は接続済みプロバイダを表示）、
                        言語切替はハンバーガー内に寄せる。デスクトップ側の topbar-actions は
                        CSS で隠さず従来どおり使う。 */}
                    <div className="topbar-mobile-cluster">
                        <WalletConnect />
                        <SiteMobileMenu
                            active={active}
                            extras={<LocaleSwitcher current={locale} />}
                            items={mobileItems}
                            menuLabel={t("menuOpenAria")}
                            navLabels={navLabels}
                        />
                    </div>
                </div>
            </header>
            <NetworkMismatchBanner />
        </>
    );
}
