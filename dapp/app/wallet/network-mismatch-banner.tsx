"use client";

import { useCurrentNetwork, useWalletConnection } from "@mysten/dapp-kit-react";
import { useTranslations } from "next-intl";
import { WalletI18nProvider } from "./wallet-i18n-provider";
import { shouldWarnNetworkMismatch } from "./wallet-network";

function NetworkMismatchBannerInner() {
    const connection = useWalletConnection();
    const network = useCurrentNetwork();
    const t = useTranslations("wallet");

    if (!shouldWarnNetworkMismatch(connection.status, network)) {
        return null;
    }

    return (
        <div className="wallet-network-warning" role="alert">
            {t("networkWarning", { network: network ?? "" })}
        </div>
    );
}

export function NetworkMismatchBanner() {
    return (
        <WalletI18nProvider>
            <NetworkMismatchBannerInner />
        </WalletI18nProvider>
    );
}
