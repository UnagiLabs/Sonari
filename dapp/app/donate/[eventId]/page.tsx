import type { Metadata } from "next";
import { cookies } from "next/headers";
import enMessages from "../../../messages/en.json";
import jaMessages from "../../../messages/ja.json";
import { SonariIntlProvider } from "../../i18n/intl-provider";
import { canonicalMetadata } from "../../i18n/site-metadata";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "../../register/wizard/locale";
import { DisasterDonateView } from "./disaster-donate-view";

// locale ごとの翻訳カタログ。cookie ベース切替のため /donate/[eventId] も
// dynamic rendering になる（/donate・/claim/[campaignId] と同じ挙動）。
const messagesByLocale: Record<SonariLocale, typeof enMessages> = {
    en: enMessages,
    ja: jaMessages,
};

// 動的 canonical: eventId ごとに正規 URL が異なるため generateMetadata で解決する。
export async function generateMetadata({
    params,
}: {
    params: Promise<{ eventId: string }>;
}): Promise<Metadata> {
    const { eventId } = await params;
    return canonicalMetadata(`/donate/${eventId}`);
}

export default async function DisasterDonatePage({
    params,
}: {
    params: Promise<{ eventId: string }>;
}) {
    const { eventId } = await params;
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <SonariIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <DisasterDonateView eventId={eventId} locale={locale} />
        </SonariIntlProvider>
    );
}
