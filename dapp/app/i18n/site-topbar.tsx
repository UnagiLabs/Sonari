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
                    <a
                        className={`nav-item topbar-mypage${active === "mypage" ? " active" : ""}`}
                        href={MYPAGE_ITEM.href}
                    >
                        {t("nav.mypage")}
                    </a>
                    <LocaleSwitcher current={locale} />
                    <WalletConnect />
                    <SiteMobileMenu
                        active={active}
                        items={mobileItems}
                        menuLabel={t("menuOpenAria")}
                        navLabels={navLabels}
                    />
                </div>
            </header>
            <NetworkMismatchBanner />
        </>
    );
}
