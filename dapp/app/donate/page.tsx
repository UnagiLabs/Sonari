import { cookies } from "next/headers";
import enMessages from "../../messages/en.json";
import jaMessages from "../../messages/ja.json";
import { SonariIntlProvider } from "../i18n/intl-provider";
import { canonicalMetadata } from "../i18n/site-metadata";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "../register/wizard/locale";
import { DonateView } from "./donate-view";

export const metadata = canonicalMetadata("/donate");

// locale ごとの翻訳カタログ。cookie ベース切替のため /donate も dynamic
// rendering になる（/register・/mypage と同じ挙動）。
const messagesByLocale: Record<SonariLocale, typeof enMessages> = {
    en: enMessages,
    ja: jaMessages,
};

export default async function DonatePage() {
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <SonariIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <DonateView locale={locale} />
        </SonariIntlProvider>
    );
}
