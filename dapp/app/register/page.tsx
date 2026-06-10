import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { Suspense } from "react";
import enMessages from "../../messages/en.json";
import jaMessages from "../../messages/ja.json";
import { RegisterTopbar } from "./register-shared";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "./wizard/locale";
import { RegisterWizard } from "./wizard/register-wizard";

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
        <NextIntlClientProvider
            locale={locale}
            messages={messagesByLocale[locale]}
            timeZone="Asia/Tokyo"
        >
            <div className="watercolor-bg" />
            <div className="app">
                <RegisterTopbar locale={locale} />
                <main className="page wizard-page">
                    {/* useSearchParams を使う client コンポーネントは Suspense 境界が必須 */}
                    <Suspense fallback={null}>
                        <RegisterWizard />
                    </Suspense>
                </main>
            </div>
        </NextIntlClientProvider>
    );
}
