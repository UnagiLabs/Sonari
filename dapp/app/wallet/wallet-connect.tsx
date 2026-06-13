"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { WalletI18nProvider } from "./wallet-i18n-provider";

// SSR・チャンク読み込み中に表示する placeholder のラベル。
// dynamic の loading 関数は WalletConnect の WalletI18nProvider 配下で描画されるため、
// ここで useTranslations を安全に使える。
function WalletConnectFallbackLabel() {
    const t = useTranslations("wallet");
    return (
        <span className="wallet-connect-fallback" aria-hidden="true">
            <span className="wallet-dot" />
            {t("connect")}
        </span>
    );
}

// ConnectWalletButton は @mysten/dapp-kit-react/ui（server 非対応の web component）を
// 含むため、dynamic(ssr:false) で client 専用に閉じる。
// loading は SSR の静的 HTML とチャンク読み込み中に表示する placeholder で、
// topbar / panel の既存レイアウトを崩さないための見た目を保つ。
const ConnectWalletButtonDynamic = dynamic(
    () => import("./connect-wallet-button").then((mod) => mod.ConnectWalletButton),
    {
        ssr: false,
        loading: () => <WalletConnectFallbackLabel />,
    },
);

// 各ページが import する公開エントリ。
// ConnectWalletButton と loading fallback の両方が wallet 文言を必要とするため、
// WalletI18nProvider で両者をまとめて包む。
// home / claim / donate / dashboard は NextIntlClientProvider を持たないため、
// この provider が無いと fallback の useTranslations が実行時に throw する。
export function WalletConnect() {
    return (
        <WalletI18nProvider>
            <ConnectWalletButtonDynamic />
        </WalletI18nProvider>
    );
}
