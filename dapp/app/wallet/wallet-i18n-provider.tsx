"use client";

import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import enMessages from "../../messages/en.json";
import jaMessages from "../../messages/ja.json";
import {
    DEFAULT_LOCALE,
    parseLocale,
    SONARI_LOCALE_COOKIE,
    type SonariLocale,
} from "../register/wizard/locale";

// wallet 関連コンポーネント（WalletConnect / NetworkMismatchBanner）専用の
// i18n provider。これらは home / claim / donate / dashboard など
// NextIntlClientProvider を持たないページでも描画されるため、自前で wallet
// namespace の翻訳カタログを供給する必要がある。
//
// 既に上位で SonariIntlProvider が居るページ（register / mypage）では provider が
// 入れ子になるが、内側で読むのは wallet.* のみなので影響はない。
const messagesByLocale: Record<SonariLocale, { wallet: Record<string, string> }> = {
    en: { wallet: enMessages.wallet },
    ja: { wallet: jaMessages.wallet },
};

// クライアント側で cookie から locale を解決する。
// SSR では document が無いため DEFAULT_LOCALE（en）にフォールバックする。
function readLocale(): SonariLocale {
    if (typeof document === "undefined") {
        return DEFAULT_LOCALE;
    }
    const match = document.cookie
        .split("; ")
        .find((row) => row.startsWith(`${SONARI_LOCALE_COOKIE}=`));
    return parseLocale(match?.split("=")[1]);
}

export function WalletI18nProvider({ children }: { readonly children: ReactNode }) {
    const locale = readLocale();
    return (
        <NextIntlClientProvider
            locale={locale}
            messages={messagesByLocale[locale]}
            timeZone="Asia/Tokyo"
        >
            {children}
        </NextIntlClientProvider>
    );
}
