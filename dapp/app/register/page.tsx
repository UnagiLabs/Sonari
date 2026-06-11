import { cookies } from "next/headers";
import { Suspense } from "react";
import enMessages from "../../messages/en.json";
import jaMessages from "../../messages/ja.json";
import { canonicalMetadata } from "../i18n/site-metadata";
import { SiteTopbar } from "../i18n/site-topbar";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "./wizard/locale";
import { RegisterIntlProvider } from "./wizard/register-intl-provider";
import { RegisterWizard } from "./wizard/register-wizard";

export const metadata = canonicalMetadata("/register");

// locale ごとの翻訳カタログ。cookie ベース切替のため /register だけが
// dynamic rendering になる（他ページへの i18n の波及はない）。
const messagesByLocale: Record<SonariLocale, typeof enMessages> = {
    en: enMessages,
    ja: jaMessages,
};

export default async function RegisterPage() {
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <RegisterIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <div className="watercolor-bg" />
            <div className="app">
                {/* register の nav は leaderboard なしの 5 項目（旧専用 topbar と同一） */}
                <SiteTopbar
                    active="register"
                    items={["home", "donate", "dashboard", "register", "claim"]}
                    locale={locale}
                />
                <main className="page wizard-page">
                    {/* useSearchParams を使う client コンポーネントは Suspense 境界が必須 */}
                    <Suspense fallback={null}>
                        <RegisterWizard />
                    </Suspense>
                </main>
            </div>
        </RegisterIntlProvider>
    );
}
