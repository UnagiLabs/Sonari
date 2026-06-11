"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import type { SonariLocale } from "../register/wizard/locale";
import { LocaleSwitcher } from "../register/wizard/locale-switcher";
import { WalletConnect } from "../wallet/wallet-connect";
import { type NavKey, resolveNavItems } from "./topbar-nav";

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

    return (
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
            </div>
        </header>
    );
}
