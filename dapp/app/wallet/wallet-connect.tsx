"use client";

import dynamic from "next/dynamic";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import enMessages from "../../messages/en.json";
import jaMessages from "../../messages/ja.json";
import {
    DEFAULT_LOCALE,
    parseLocale,
    SONARI_LOCALE_COOKIE,
    type SonariLocale,
} from "../register/wizard/locale";

// locale ごとの翻訳カタログ（wallet namespace のみ使う）。
const messagesByLocale: Record<SonariLocale, { wallet: Record<string, string> }> = {
    en: { wallet: enMessages.wallet },
    ja: { wallet: jaMessages.wallet },
};

// クライアント側で cookie を読み locale を解決する。
// SSR では document が存在しないため DEFAULT_LOCALE にフォールバックする。
function readLocale(): SonariLocale {
    if (typeof document === "undefined") {
        return DEFAULT_LOCALE;
    }
    const match = document.cookie
        .split("; ")
        .find((row) => row.startsWith(`${SONARI_LOCALE_COOKIE}=`));
    return parseLocale(match?.split("=")[1]);
}

// useTranslations は NextIntlClientProvider 内でのみ安全なため、
// 内側のコンポーネントに分離する。
function WalletConnectFallbackInner() {
    const t = useTranslations("wallet");
    return (
        <span className="wallet-connect-fallback" aria-hidden="true">
            <span className="wallet-dot" />
            {t("connect")}
        </span>
    );
}

// SSR・チャンク読み込み中に表示する placeholder。
// loading 関数内で hooks は直接書けないため、専用コンポーネントに切り出す。
// IntlProvider を持たないページ（claim/donate/home 等）でも使われるため、
// 自己完結した NextIntlClientProvider でラップする。
function WalletConnectFallback() {
    const locale = readLocale();
    return (
        <NextIntlClientProvider locale={locale} messages={messagesByLocale[locale]}>
            <WalletConnectFallbackInner />
        </NextIntlClientProvider>
    );
}

// 各ページが import する公開エントリ。
// ConnectWalletButton は @mysten/dapp-kit-react/ui（server 非対応の web component）を
// 含むため、dynamic(ssr:false) で client 専用に閉じる。
// loading は SSR の静的 HTML とチャンク読み込み中に表示する placeholder で、
// topbar / panel の既存レイアウトを崩さないための見た目を保つ。
export const WalletConnect = dynamic(
    () => import("./connect-wallet-button").then((mod) => mod.ConnectWalletButton),
    {
        ssr: false,
        loading: () => <WalletConnectFallback />,
    },
);
