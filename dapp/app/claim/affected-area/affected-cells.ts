import { parseH3Index } from "@sonari/proof-core";
import { type CellBand, parseCellBand } from "../catalog/cell-band-rules";
import {
    RESIDENCE_H3_RESOLUTION,
    h3DecimalToHex,
} from "../../register/residence/h3-geo";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/**
 * 検証済みの被災セル。
 * `decimal` は on-chain h3 index の 10進 u64 文字列。
 * `hex` は h3-js native の小文字 16 進文字列。
 * `band` は被災度バンド（1: 軽微 〜 3: 深刻）。
 */
export interface AffectedCell {
    readonly decimal: string;
    readonly hex: string;
    readonly band: CellBand;
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * 単一要素（`unknown`）を検証して `AffectedCell` を返す。
 * 不正な場合は `null` を返す（fail-closed / スキップ方式）。
 *
 * 有効条件:
 * - 長さ 2 の配列
 * - `[0]` が typeof "string" かつ `parseH3Index` で res7 として検証可能
 * - `[1]` が `parseCellBand` で 1〜3 として解釈可能
 */
function parseAffectedCell(element: unknown): AffectedCell | null {
    // 配列かつ長さ 2 であること
    if (!Array.isArray(element) || element.length !== 2) {
        return null;
    }

    const [rawDecimal, rawBand] = element;

    // [0]: 文字列であること
    if (typeof rawDecimal !== "string") {
        return null;
    }

    // [0]: res7 の有効な H3 index であること（不正は throw → null でスキップ）
    try {
        parseH3Index(rawDecimal, RESIDENCE_H3_RESOLUTION);
    } catch {
        return null;
    }

    // [1]: 有効な CellBand（1 / 2 / 3）であること
    const band = parseCellBand(rawBand);
    if (band === null) {
        return null;
    }

    const hex = h3DecimalToHex(rawDecimal);
    return { decimal: rawDecimal, hex, band };
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * 外部 JSON（`[h3_decimal_string, band]` タプルの配列）を受け取り、
 * 検証済みの `AffectedCell[]` を返す。
 *
 * fail-closed 挙動:
 * - 入力が配列でない場合は空配列 `[]` を返す。
 * - 各要素が不正な場合はその要素だけスキップし、有効な要素は残す。
 *   （1 件の不正で地図全体を空にしない。表示専用データのため頑健性を優先）
 * - 入力順を保持する（決定的出力）。
 */
export function parseAffectedCells(input: unknown): AffectedCell[] {
    // 配列でない場合は即座に空配列を返す
    if (!Array.isArray(input)) {
        return [];
    }

    const result: AffectedCell[] = [];
    for (const element of input) {
        const cell = parseAffectedCell(element);
        if (cell !== null) {
            result.push(cell);
        }
    }
    return result;
}
