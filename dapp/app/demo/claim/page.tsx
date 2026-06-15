import type { Metadata } from "next";
import { cookies } from "next/headers";
import enMessages from "../../../messages/en.json";
import jaMessages from "../../../messages/ja.json";
import { SonariIntlProvider } from "../../i18n/intl-provider";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "../../register/wizard/locale";
import { DemoClaimListView } from "./demo-claim-list-view";

// デモ用ページは検索エンジンに載せない。本番 /claim と URL が別なので
// canonical は設定せず、noindex にして本番ページの正規性を侵さない。
export const metadata: Metadata = {
    title: "Demo · Claim — Sonari",
    robots: { index: false, follow: false },
};

// locale ごとの翻訳カタログ。cookie ベース切替のため本番 /claim と同じく
// dynamic rendering になる。
const messagesByLocale: Record<SonariLocale, typeof enMessages> = {
    en: enMessages,
    ja: jaMessages,
};

export default async function DemoClaimPage() {
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <SonariIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <DemoClaimListView locale={locale} />
        </SonariIntlProvider>
    );
}
