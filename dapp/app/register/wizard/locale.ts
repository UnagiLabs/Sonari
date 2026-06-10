// 表示 locale の定義。URL prefix は使わず cookie ベースで切り替える
// （波及範囲を /register に閉じるため。全ページ展開時に next-intl の
// ルーティング構成へ移行する余地は残す）。

export const SONARI_LOCALE_COOKIE = "SONARI_LOCALE";

export const SUPPORTED_LOCALES = ["en", "ja"] as const;

export type SonariLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SonariLocale = "en";

/** cookie 値などの未検証入力を locale へ解釈する。未知の値は en に落とす。 */
export function parseLocale(value: string | null | undefined): SonariLocale {
    return (SUPPORTED_LOCALES as readonly string[]).includes(value ?? "")
        ? (value as SonariLocale)
        : DEFAULT_LOCALE;
}
