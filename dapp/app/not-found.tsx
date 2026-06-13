import { cookies } from "next/headers";
import enMessages from "../messages/en.json";
import jaMessages from "../messages/ja.json";
import { SonariIntlProvider } from "./i18n/intl-provider";
import { NotFoundView } from "./not-found-view";
import { parseLocale, SONARI_LOCALE_COOKIE, type SonariLocale } from "./register/wizard/locale";

const messagesByLocale: Record<SonariLocale, { notFound: typeof enMessages.notFound }> = {
    en: { notFound: enMessages.notFound },
    ja: { notFound: jaMessages.notFound },
};

export default async function NotFound() {
    const cookieStore = await cookies();
    const locale = parseLocale(cookieStore.get(SONARI_LOCALE_COOKIE)?.value);

    return (
        <SonariIntlProvider locale={locale} messages={messagesByLocale[locale]}>
            <NotFoundView locale={locale} />
        </SonariIntlProvider>
    );
}
