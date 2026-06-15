// ---------------------------------------------------------------------------
// CellBand: バンド（実データの値） 1〜3 のリテラル union
//
// 金額は表示用のデモ値。バンドは実データの値（on-chain の band フィールド）。
// ---------------------------------------------------------------------------

/** セルのバンド値。実データから取得する整数 1〜3。 */
export type CellBand = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// parseCellBand
// ---------------------------------------------------------------------------

/**
 * `unknown` を受け取り、有効な `CellBand`（1〜3 の整数）であれば返す。
 * 範囲外（0 や 4 以上）、非整数、数値以外はすべて `null` を返す（fail-closed）。
 * 文字列 "1" / "2" / "3" は厳密に一致する場合のみ受け付ける。
 * 空白を含む文字列・小数を表す文字列は `null` を返す。
 */
export function parseCellBand(value: unknown): CellBand | null {
    let n: number;

    if (typeof value === "number") {
        n = value;
    } else if (typeof value === "string") {
        // "1" / "2" / "3" のみ受け付ける（空白・小数点を含む文字列は拒否）
        if (value !== "1" && value !== "2" && value !== "3") {
            return null;
        }
        n = Number(value);
    } else {
        return null;
    }

    if (!Number.isInteger(n)) {
        return null;
    }
    if (n < 1 || n > 3) {
        return null;
    }

    return n as CellBand;
}

// ---------------------------------------------------------------------------
// バンド→金額（デモ値）
//
// 金額は表示用のデモ値。バンドは実データの値。
// 実支給額（floor_amount_by_band 等）は on-chain フィクスチャが確定次第更新する。
// ---------------------------------------------------------------------------

/** バンドに対応する表示用金額（USDC）。 */
const BAND_AMOUNT: Readonly<Record<CellBand, number>> = {
    1: 100,
    2: 200,
    3: 300,
};

/**
 * バンドに対応する表示用金額（USDC）を返す。
 * 金額は表示用のデモ値。バンドは実データの値。
 */
export function bandAmount(band: CellBand): number {
    return BAND_AMOUNT[band];
}

// ---------------------------------------------------------------------------
// バンド→色
//
// 薄い→濃いの3段階（黄系→橙系→赤系）。CSS で使える色文字列。
// ---------------------------------------------------------------------------

/** バンドに対応する CSS 色文字列。薄い（Band1）→濃い（Band3）の順。 */
const BAND_COLOR: Readonly<Record<CellBand, string>> = {
    1: "#fde68a", // 薄い黄色（Band1: 軽微）
    2: "#f97316", // 橙色（Band2: 中程度）
    3: "#dc2626", // 赤色（Band3: 深刻）
};

/**
 * バンドに対応する CSS 色文字列を返す。
 * 3バンドで明確に区別できる固定値（黄系→橙系→赤系）。
 */
export function bandColor(band: CellBand): string {
    return BAND_COLOR[band];
}

// ---------------------------------------------------------------------------
// buildBandLegendEntries
// ---------------------------------------------------------------------------

/** 凡例エントリ。色だけに頼らず band と金額をテキスト表示できる構造。 */
export interface BandLegendEntry {
    /** バンド値（実データの値）。 */
    readonly band: CellBand;
    /**
     * 表示用金額（USDC）。
     * 金額は表示用のデモ値。バンドは実データの値。
     */
    readonly amount: number;
    /** CSS 色文字列。 */
    readonly color: string;
}

/**
 * 凡例に表示する全バンドのエントリを返す（Band1 → Band2 → Band3 の順）。
 *
 * UI 側はこのエントリを使って「バンド名＋金額」をテキスト表示できる。
 * 色だけに頼らない凡例表現を可能にする。
 */
export function buildBandLegendEntries(): readonly BandLegendEntry[] {
    return [
        { band: 1, amount: bandAmount(1), color: bandColor(1) },
        { band: 2, amount: bandAmount(2), color: bandColor(2) },
        { band: 3, amount: bandAmount(3), color: bandColor(3) },
    ] as const;
}
