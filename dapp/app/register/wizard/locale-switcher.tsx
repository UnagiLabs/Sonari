"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { SONARI_LOCALE_COOKIE, type SonariLocale, SUPPORTED_LOCALES } from "./locale";

// 各 locale の表示メタ。code はトリガー/チップ用の短い表記、native はその言語自身での
// 名称、eng は英語での言語名。表示中の UI 言語に依存しない固定ラベルなので i18n しない。
const localeMeta: Record<
    SonariLocale,
    { readonly code: string; readonly native: string; readonly eng: string }
> = {
    en: { code: "EN", native: "English", eng: "English" },
    ja: { code: "JA", native: "日本語", eng: "Japanese" },
};

// 言語切替。cookie を更新して router.refresh() でサーバー側の locale 解決をやり直す
// （URL は変えない）。開閉は <details> に任せて JS を抑え（site mobile menu と同じ方針）、
// 選択後・パネル外クリック・Escape では明示的に閉じる。
export function LocaleSwitcher({ current }: { readonly current: SonariLocale }) {
    const router = useRouter();
    const detailsRef = useRef<HTMLDetailsElement>(null);

    function handleSelect(next: SonariLocale) {
        // 同じ言語を選んでもメニューは閉じる。
        if (detailsRef.current) {
            detailsRef.current.open = false;
        }
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

    // <details> は外側クリック・Escape では閉じないため、ここで補う。
    useEffect(() => {
        function onPointerDown(event: PointerEvent) {
            const el = detailsRef.current;
            if (el?.open && !el.contains(event.target as Node)) {
                el.open = false;
            }
        }
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape" && detailsRef.current) {
                detailsRef.current.open = false;
            }
        }
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, []);

    const currentMeta = localeMeta[current];

    return (
        <details className="locale-switcher" ref={detailsRef}>
            <summary aria-label="Language" className="locale-switcher-trigger">
                <svg
                    aria-hidden="true"
                    className="locale-switcher-globe"
                    fill="none"
                    viewBox="0 0 24 24"
                >
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M3 12h18" stroke="currentColor" strokeWidth="1.4" />
                    <path
                        d="M12 3c2.4 2.6 2.4 15.4 0 18M12 3c-2.4 2.6-2.4 15.4 0 18"
                        stroke="currentColor"
                        strokeWidth="1.4"
                    />
                </svg>
                <span className="locale-switcher-code">{currentMeta.code}</span>
                <svg
                    aria-hidden="true"
                    className="locale-switcher-chevron"
                    fill="none"
                    viewBox="0 0 24 24"
                >
                    <path
                        d="M6 9l6 6 6-6"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2.6"
                    />
                </svg>
            </summary>
            <div className="locale-switcher-panel">
                <p className="locale-switcher-heading">Choose language</p>
                {SUPPORTED_LOCALES.map((locale) => {
                    const meta = localeMeta[locale];
                    const active = locale === current;
                    return (
                        <button
                            aria-pressed={active}
                            className={`locale-switcher-option${active ? " active" : ""}`}
                            key={locale}
                            onClick={() => handleSelect(locale)}
                            type="button"
                        >
                            <span className="locale-switcher-chip">{meta.code}</span>
                            <span className="locale-switcher-names">
                                <span className="locale-switcher-native">{meta.native}</span>
                                <span className="locale-switcher-eng">{meta.eng}</span>
                            </span>
                            {active ? (
                                <svg
                                    aria-hidden="true"
                                    className="locale-switcher-check"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        d="M20 6 9 17l-5-5"
                                        stroke="currentColor"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="3"
                                    />
                                </svg>
                            ) : null}
                        </button>
                    );
                })}
            </div>
        </details>
    );
}
