"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { WalletConnect } from "../wallet/wallet-connect";
import type { SonariLocale } from "./wizard/locale";
import { LocaleSwitcher } from "./wizard/locale-switcher";

// 登録ウィザード用の簡略 topbar。ナビ・言語切替・wallet 接続のみを置き、
// 画面の主役はウィザード本体に譲る。
export function RegisterTopbar({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("register.topbar");

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
                    <a className="nav-item" href="/">
                        {t("home")}
                    </a>
                    <a className="nav-item" href="/donate">
                        {t("donate")}
                    </a>
                    <a className="nav-item" href="/dashboard">
                        {t("dashboard")}
                    </a>
                    <a className="nav-item active" href="/register">
                        {t("register")}
                    </a>
                    <a className="nav-item" href="/claim">
                        {t("claim")}
                    </a>
                </nav>
                <div className="topbar-spacer" />
                <LocaleSwitcher current={locale} />
                <WalletConnect />
            </div>
        </header>
    );
}
