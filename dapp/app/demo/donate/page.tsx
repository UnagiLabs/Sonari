import type { Metadata } from "next";
import { cookies } from "next/headers";
import enMessages from "../../../messages/en.json";
import jaMessages from "../../../messages/ja.json";
import { SonariIntlProvider } from "../../i18n/intl-provider";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "../../register/wizard/locale";
import { DemoDonateView } from "./demo-donate-view";

// デモ用ページは検索エンジンに載せない。本番 /donate と URL が別なので
// canonical は設定せず、noindex にして本番ページの正規性を侵さない。
export const metadata: Metadata = {
    title: "Demo · Donate — Sonari",
    robots: { index: false, follow: false },
};

// locale ごとの翻訳カタログ。cookie ベース切替のため本番 /donate と同じく
// dynamic rendering になる。
const messagesByLocale: Record<SonariLocale, typeof enMessages> = {
    en: enMessages,
    ja: jaMessages,
};

export default async function DemoDonatePage() {
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <SonariIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <DemoDonateView locale={locale} />
        </SonariIntlProvider>
    );
}
