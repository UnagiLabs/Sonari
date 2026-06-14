import type { Metadata } from "next";
import { cookies } from "next/headers";
import enMessages from "../../../messages/en.json";
import jaMessages from "../../../messages/ja.json";
import { SiteTopbar } from "../../i18n/site-topbar";
import { MypageIntlProvider } from "../../mypage/mypage-intl-provider";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "../../register/wizard/locale";
import { DemoMypageView } from "./demo-mypage-view";

// デモ用ページは検索エンジンに載せない。本番 /mypage と URL が別なので
// canonical は設定せず、noindex にして本番マイページの正規性を侵さない。
export const metadata: Metadata = {
    title: "Demo · My Page — Sonari",
    robots: { index: false, follow: false },
};

// locale ごとの翻訳カタログ。cookie ベース切替のため本番 /mypage と同じく
// dynamic rendering になる。
const messagesByLocale: Record<SonariLocale, typeof enMessages> = {
    en: enMessages,
    ja: jaMessages,
};

export default async function DemoMyPage() {
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <MypageIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="mypage" locale={locale} />
                <main className="page wizard-page">
                    <DemoMypageView locale={locale} />
                </main>
            </div>
        </MypageIntlProvider>
    );
}
