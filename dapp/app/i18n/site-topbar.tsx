"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import type { SonariLocale } from "../register/wizard/locale";
import { LocaleSwitcher } from "../register/wizard/locale-switcher";
import { WalletConnect } from "../wallet/wallet-connect";

// 全ページ共通の topbar。ナビ・言語切替・wallet 接続をまとめ、各ページは
// active なナビ項目と右側アクション（寄付 CTA / wallet）の有無を props で渡す。
// 文言は topbar.* カタログから引く。register/mypage は専用 topbar を持つため
// ここでは扱わない。

type NavKey = "home" | "donate" | "dashboard" | "leaderboard" | "register" | "claim";

const navItems: readonly { key: NavKey; href: string }[] = [
    { key: "home", href: "/" },
    { key: "donate", href: "/donate" },
    { key: "dashboard", href: "/dashboard" },
    { key: "leaderboard", href: "/leaderboard" },
    { key: "register", href: "/register" },
    { key: "claim", href: "/claim" },
];

export function SiteTopbar({
    active,
    locale,
    showDonateCta = false,
    showWallet = true,
}: {
    readonly active: NavKey;
    readonly locale: SonariLocale;
    readonly showDonateCta?: boolean;
    readonly showWallet?: boolean;
}) {
    const t = useTranslations("topbar");

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
