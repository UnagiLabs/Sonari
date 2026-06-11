"use client";

import { useRouter } from "next/navigation";
import { SONARI_LOCALE_COOKIE, type SonariLocale, SUPPORTED_LOCALES } from "./locale";

const localeLabels: Record<SonariLocale, string> = {
    en: "EN",
    ja: "日本語",
};

// 言語切替。cookie を更新して router.refresh() でサーバー側の locale 解決を
// やり直す（URL は変えない）。表示中の言語に依存しないラベルなので i18n しない。
export function LocaleSwitcher({ current }: { readonly current: SonariLocale }) {
    const router = useRouter();

    function handleSelect(next: SonariLocale) {
        if (next === current) {
            return;
        }
        // cookieStore API は Safari / Firefox の対応が不十分で言語切替が壊れる恐れがあるため、
        // 全ブラウザで確実に動く document.cookie を使う。
        // biome-ignore lint/suspicious/noDocumentCookie: 上記の互換性理由により document.cookie を使う
        document.cookie = `${SONARI_LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        document.documentElement.lang = next;
        router.refresh();
    }

    return (
        <fieldset aria-label="Language" className="locale-switcher">
            {SUPPORTED_LOCALES.map((locale) => (
                <button
                    aria-pressed={locale === current}
                    className={`locale-switcher-option${locale === current ? " active" : ""}`}
                    key={locale}
                    onClick={() => handleSelect(locale)}
                    type="button"
                >
                    {localeLabels[locale]}
                </button>
            ))}
        </fieldset>
    );
}
