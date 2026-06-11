import { cookies } from "next/headers";
import enMessages from "../../messages/en.json";
import jaMessages from "../../messages/ja.json";
import { SonariIntlProvider } from "../i18n/intl-provider";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "../register/wizard/locale";
import { DashboardView } from "./dashboard-view";

// locale ごとの翻訳カタログ。cookie ベース切替のため /dashboard も dynamic
// rendering になる（/register・/mypage と同じ挙動）。
const messagesByLocale: Record<SonariLocale, typeof enMessages> = {
    en: enMessages,
    ja: jaMessages,
};

export default async function DashboardPage() {
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <SonariIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <DashboardView locale={locale} />
        </SonariIntlProvider>
    );
}
