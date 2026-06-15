import type { Metadata } from "next";
import { cookies } from "next/headers";
import enMessages from "../../../messages/en.json";
import jaMessages from "../../../messages/ja.json";
import { SonariIntlProvider } from "../../i18n/intl-provider";
import { canonicalMetadata } from "../../i18n/site-metadata";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "../../register/wizard/locale";
import { ClaimDetailView } from "./claim-detail-view";

// locale ごとの翻訳カタログ。cookie ベース切替のため /claim/[campaignId] も
// dynamic rendering になる（/claim と同じ挙動）。
const messagesByLocale: Record<SonariLocale, typeof enMessages> = {
    en: enMessages,
    ja: jaMessages,
};

// 動的 canonical: campaignId ごとに正規 URL が異なるため generateMetadata で解決する。
export async function generateMetadata({
    params,
}: {
    params: Promise<{ campaignId: string }>;
}): Promise<Metadata> {
    const { campaignId } = await params;
    return canonicalMetadata(`/claim/${campaignId}`);
}

export default async function ClaimDetailPage({
    params,
}: {
    params: Promise<{ campaignId: string }>;
}) {
    const { campaignId } = await params;
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <SonariIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <ClaimDetailView campaignId={campaignId} locale={locale} />
        </SonariIntlProvider>
    );
}
