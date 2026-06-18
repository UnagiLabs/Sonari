import { cookies } from "next/headers";
import enMessages from "../../messages/en.json";
import jaMessages from "../../messages/ja.json";
import { SonariIntlProvider } from "../i18n/intl-provider";
import { canonicalMetadata } from "../i18n/site-metadata";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "../register/wizard/locale";
import { PoolsView } from "./pools-view";

export const metadata = canonicalMetadata("/pools");

// locale ごとの翻訳カタログ。cookie ベース切替のため /pools も dynamic
// rendering になる（/claim・/register・/mypage と同じ挙動）。
const messagesByLocale: Record<SonariLocale, typeof enMessages> = {
    en: enMessages,
    ja: jaMessages,
};

export default async function PoolsPage() {
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <SonariIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <PoolsView locale={locale} />
        </SonariIntlProvider>
    );
}
