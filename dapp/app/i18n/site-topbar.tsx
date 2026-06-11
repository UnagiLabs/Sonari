"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import type { SonariLocale } from "../register/wizard/locale";
import { LocaleSwitcher } from "../register/wizard/locale-switcher";
import { NetworkMismatchBanner } from "../wallet/network-mismatch-banner";
import { WalletConnect } from "../wallet/wallet-connect";
import { SiteMobileMenu } from "./site-mobile-menu";
import { NAV_DEFS, type NavKey, resolveNavItems } from "./topbar-nav";

// 全ページ共通の topbar。ナビ・言語切替・wallet 接続をまとめ、各ページは
// active なナビ項目と右側アクション（寄付 CTA / wallet）の有無を props で渡す。
// 表示する nav 項目はページごとに異なるため items で並びを渡せる（省略時は
// 既定 6 項目）。文言は topbar.nav.* カタログから引く。

export function SiteTopbar({
    active,
    locale,
    items,
    showDonateCta = false,
    showWallet = true,
}: {
    readonly active: NavKey;
    readonly locale: SonariLocale;
    readonly items?: readonly NavKey[];
    readonly showDonateCta?: boolean;
    readonly showWallet?: boolean;
}) {
    const t = useTranslations("topbar");
    const navItems = resolveNavItems(items);
    // ハンバーガーメニューは翻訳に依存しないため、ここで全 nav キーの文言を解決して渡す。
    const navLabels = Object.fromEntries(
        (Object.keys(NAV_DEFS) as NavKey[]).map((key) => [key, t(`nav.${key}`)]),
    ) as Record<NavKey, string>;

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
                    {showDonateCta ? (
                        <a className="wallet-btn" href="/donate">
                            <span className="wallet-dot" />
                            {t("donateCta")}
                        </a>
                    ) : null}
                    <LocaleSwitcher current={locale} />
                    {showWallet ? <WalletConnect /> : null}
                    <SiteMobileMenu
                        active={active}
                        items={navItems}
                        menuLabel={t("menuOpenAria")}
                        navLabels={navLabels}
                    />
                </div>
            </header>
            {showWallet ? <NetworkMismatchBanner /> : null}
        </>
    );
}
