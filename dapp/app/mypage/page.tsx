import { cookies } from "next/headers";
import enMessages from "../../messages/en.json";
import jaMessages from "../../messages/ja.json";
import { canonicalMetadata } from "../i18n/site-metadata";
import { SiteTopbar } from "../i18n/site-topbar";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "../register/wizard/locale";
import { MypageIntlProvider } from "./mypage-intl-provider";
import { MypageView } from "./mypage-view";

export const metadata = canonicalMetadata("/mypage");

// locale ごとの翻訳カタログ。/register と同じく cookie ベース切替のため
// /mypage も dynamic rendering になる。
const messagesByLocale: Record<SonariLocale, typeof enMessages> = {
    en: enMessages,
    ja: jaMessages,
};

export default async function MyPage() {
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <MypageIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="mypage" locale={locale} />
                <main className="page wizard-page">
                    <MypageView locale={locale} />
                </main>
            </div>
        </MypageIntlProvider>
    );
}
