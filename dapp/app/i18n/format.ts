import type { SonariLocale } from "../register/wizard/locale";

// 金額・日時・相対時間をロケールに合わせて文字列化する純粋関数を 1 箇所にまとめる。
// 外部ライブラリは使わず標準の Intl API だけを使う。表示の正は各ページでなく
// このユーティリティに集約し、単体テストで挙動を固定する。

/** SonariLocale を Intl が解釈する BCP 47 ロケールタグへ対応づける。 */
export const LOCALE_TAGS: Record<SonariLocale, string> = {
    en: "en-US",
    ja: "ja-JP",
};

/** 金額表示の追加指定。すべて任意で、未指定なら整数の桁区切りだけを行う。 */
export interface FormatAmountOptions {
    /** ISO 4217 通貨コード（例: "USD"）。指定すると通貨表示になる。 */
    readonly currency?: string;
    /** 小数部の最小桁数。 */
    readonly minimumFractionDigits?: number;
    /** 小数部の最大桁数。 */
    readonly maximumFractionDigits?: number;
}

/**
 * 数値をロケールの桁区切り・通貨形式で表示する（Intl.NumberFormat）。
 * exactOptionalPropertyTypes 下でも undefined を渡さないよう、指定された
 * オプションだけを条件付きで組み立てる。
 */
export function formatAmount(
    value: number,
    locale: SonariLocale,
    options: FormatAmountOptions = {},
): string {
    const intlOptions: Intl.NumberFormatOptions = {
        ...(options.currency !== undefined
            ? { style: "currency", currency: options.currency }
            : {}),
        ...(options.minimumFractionDigits !== undefined
            ? { minimumFractionDigits: options.minimumFractionDigits }
            : {}),
        ...(options.maximumFractionDigits !== undefined
            ? { maximumFractionDigits: options.maximumFractionDigits }
            : {}),
    };
    return new Intl.NumberFormat(LOCALE_TAGS[locale], intlOptions).format(value);
}

/** formatDate の既定表示。年月日のみ（既存の日付表示と同じ形式）。 */
const DEFAULT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "long",
    day: "numeric",
};

/**
 * ミリ秒タイムスタンプをロケールに合わせた日時文字列にする（Intl.DateTimeFormat）。
 * 非正値（0 = 未設定、負値）は null を返し、UI 側で「未設定」表示に切り替えられる。
 * options を渡すと時刻などの表示項目を足せる。
 */
export function formatDate(
    ms: number,
    locale: SonariLocale,
    options: Intl.DateTimeFormatOptions = DEFAULT_DATE_OPTIONS,
): string | null {
    if (ms <= 0) {
        return null;
    }
    return new Intl.DateTimeFormat(LOCALE_TAGS[locale], options).format(new Date(ms));
}

/**
 * 相対時間を「2 日前」「3 時間後」のような文字列にする（Intl.RelativeTimeFormat）。
 * value が負なら過去、正なら未来。numeric:"auto" で「昨日」などの語にも寄せる。
 */
export function formatRelativeTime(
    value: number,
    unit: Intl.RelativeTimeFormatUnit,
    locale: SonariLocale,
): string {
    return new Intl.RelativeTimeFormat(LOCALE_TAGS[locale], { numeric: "auto" }).format(value, unit);
}
