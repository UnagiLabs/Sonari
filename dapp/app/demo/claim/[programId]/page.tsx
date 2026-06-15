import type { Metadata } from "next";
import { cookies } from "next/headers";
import enMessages from "../../../../messages/en.json";
import jaMessages from "../../../../messages/ja.json";
import { SonariIntlProvider } from "../../../i18n/intl-provider";
import {
    parseLocale,
    SONARI_LOCALE_COOKIE,
    type SonariLocale,
} from "../../../register/wizard/locale";
import { DemoClaimDetailView } from "./demo-claim-detail-view";

// デモ用詳細ページは検索エンジンに載せない。本番 /claim/[campaignId] と URL が別なので
// canonical は設定せず、noindex にして本番ページの正規性を侵さない。
export const metadata: Metadata = {
    title: "Demo · Claim Detail — Sonari",
    robots: { index: false, follow: false },
};

// locale ごとの翻訳カタログ。cookie ベース切替のため dynamic rendering になる。
const messagesByLocale: Record<SonariLocale, typeof enMessages> = {
    en: enMessages,
    ja: jaMessages,
};

export default async function DemoClaimDetailPage({
    params,
}: {
    params: Promise<{ programId: string }>;
}) {
    const { programId } = await params;
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <SonariIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <DemoClaimDetailView locale={locale} programId={programId} />
        </SonariIntlProvider>
    );
}
