"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { buildLoginEntryHref } from "../login-entry/login-next";
import { WalletConnect } from "./wallet-connect";
import { WalletI18nProvider } from "./wallet-i18n-provider";

export function LoginEntryPointFallback() {
    const t = useTranslations("wallet");

    return (
        <span className="wallet-connect-fallback" aria-hidden="true">
            <span className="wallet-dot" />
            {t("connect")}
        </span>
    );
}

function LoginEntryPointContent() {
    const account = useCurrentAccount();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const t = useTranslations("wallet");

    if (pathname === "/" || account) {
        return <WalletConnect />;
    }

    const search = searchParams.toString();
    const next = search ? `${pathname}?${search}` : pathname;

    return (
        <a
            aria-label={t("connect")}
            className="wallet-connect-fallback"
            href={buildLoginEntryHref(next)}
        >
            <span className="wallet-dot" />
            {t("connect")}
        </a>
    );
}

export function LoginEntryPoint() {
    return (
        <WalletI18nProvider>
            <LoginEntryPointContent />
        </WalletI18nProvider>
    );
}
