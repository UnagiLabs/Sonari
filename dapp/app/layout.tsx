import { cookies } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";
import { rootMetadata } from "./i18n/site-metadata";
import { parseLocale, SONARI_LOCALE_COOKIE } from "./register/wizard/locale";
import { WalletProvider } from "./wallet/wallet-provider";

// OGP・Twitter Card・metadataBase はサイト共通なので site-metadata に集約する。
// favicon は app/icon.png の file convention が担う。canonical は各 page.tsx が設定。
export const metadata = rootMetadata;

// cookie の選択言語を初回 server render の <html lang> に反映する。各ページの
// 翻訳カタログ解決（page.tsx の cookie 読み取りと IntlProvider）はここでは触らず、
// lang 属性の一致だけを担う。client 側の即時切替は locale-switcher が行う。
export default async function RootLayout({ children }: { children: ReactNode }) {
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <html lang={locale}>
            <head>
                <link rel="preconnect" href="https://fonts.googleapis.com" />
                <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
                <link
                    href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Cormorant+Garamond:wght@400;500;600&family=Noto+Sans+JP:wght@400;500;600;700;800&family=Noto+Serif+JP:wght@400;500;600;700&display=swap"
                    rel="stylesheet"
                />
            </head>
            <body id="top">
                <WalletProvider>{children}</WalletProvider>
            </body>
        </html>
    );
}
