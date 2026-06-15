import { latLngToCell } from "h3-js";
import { describe, expect, it } from "vitest";
import { h3HexToDecimal } from "../../register/residence/h3-geo";
import { parseAffectedCells } from "./affected-cells";

// ---------------------------------------------------------------------------
// テスト用アンカーセル
// "608795190286614527" → hex "872e00001ffffff" (res7, band 3)
// "608795262395088895" → hex "872e010cbffffff" (res7, band 1 相当)
// ---------------------------------------------------------------------------

const BAND3_DECIMAL = "608795190286614527";
const BAND3_HEX = "872e00001ffffff";
const BAND1_DECIMAL = "608795262395088895";
const BAND1_HEX = "872e010cbffffff";

// 解像度違いの10進セル（スキップ検証用）
function resNDecimal(res: number): string {
    const hex = latLngToCell(38.2688, 140.8721, res);
    return h3HexToDecimal(hex);
}

// ---------------------------------------------------------------------------
// 正常系
// ---------------------------------------------------------------------------

describe("parseAffectedCells: 正常系", () => {
    it("有効なタプルを正しく変換する", () => {
        const result = parseAffectedCells([[BAND3_DECIMAL, 3]]);
        expect(result).toHaveLength(1);
        expect(result[0].decimal).toBe(BAND3_DECIMAL);
        expect(result[0].hex).toBe(BAND3_HEX);
        expect(result[0].band).toBe(3);
    });

    it("複数の有効タプルをすべて変換し、件数が一致する", () => {
        const input = [
            [BAND3_DECIMAL, 3],
            [BAND1_DECIMAL, 1],
        ];
        const result = parseAffectedCells(input);
        expect(result).toHaveLength(2);
    });

    it("入力順を保持する", () => {
        const input = [
            [BAND1_DECIMAL, 1],
            [BAND3_DECIMAL, 3],
        ];
        const result = parseAffectedCells(input);
        expect(result[0].decimal).toBe(BAND1_DECIMAL);
        expect(result[0].band).toBe(1);
        expect(result[1].decimal).toBe(BAND3_DECIMAL);
        expect(result[1].band).toBe(3);
    });

    it("band2 のセルも正しく変換する", () => {
        const result = parseAffectedCells([[BAND3_DECIMAL, 2]]);
        expect(result[0].band).toBe(2);
    });

    it("アンカーセルの hex が仕様と一致する", () => {
        const result = parseAffectedCells([[BAND3_DECIMAL, 3]]);
        expect(result[0].hex).toBe("872e00001ffffff");
    });

    it("BAND1_HEX が期待どおり", () => {
        const result = parseAffectedCells([[BAND1_DECIMAL, 1]]);
        expect(result[0].hex).toBe(BAND1_HEX);
    });
});

// ---------------------------------------------------------------------------
// 空入力
// ---------------------------------------------------------------------------

describe("parseAffectedCells: 空入力", () => {
    it("空配列 → 空配列を返す", () => {
        expect(parseAffectedCells([])).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 非配列入力 → 空配列
// ---------------------------------------------------------------------------

describe("parseAffectedCells: 非配列入力", () => {
    it("null → []", () => {
        expect(parseAffectedCells(null)).toEqual([]);
    });

    it("undefined → []", () => {
        expect(parseAffectedCells(undefined)).toEqual([]);
    });

    it("object → []", () => {
        expect(parseAffectedCells({})).toEqual([]);
    });

    it("文字列 → []", () => {
        expect(parseAffectedCells("x")).toEqual([]);
    });

    it("数値 → []", () => {
        expect(parseAffectedCells(123)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 不正要素はスキップ（有効分のみ残す）
// ---------------------------------------------------------------------------

describe("parseAffectedCells: 不正要素のスキップ", () => {
    it("長さ0のタプルはスキップ", () => {
        const result = parseAffectedCells([[], [BAND3_DECIMAL, 3]]);
        expect(result).toHaveLength(1);
        expect(result[0].decimal).toBe(BAND3_DECIMAL);
    });

    it("長さ1のタプルはスキップ", () => {
        const result = parseAffectedCells([[BAND3_DECIMAL], [BAND1_DECIMAL, 1]]);
        expect(result).toHaveLength(1);
    });

    it("長さ3以上のタプルはスキップ", () => {
        const result = parseAffectedCells([[BAND3_DECIMAL, 3, "extra"], [BAND1_DECIMAL, 1]]);
        expect(result).toHaveLength(1);
        expect(result[0].decimal).toBe(BAND1_DECIMAL);
    });

    it("[0] が数値（非文字列）はスキップ", () => {
        const result = parseAffectedCells([[12345, 3], [BAND3_DECIMAL, 3]]);
        expect(result).toHaveLength(1);
        expect(result[0].decimal).toBe(BAND3_DECIMAL);
    });

    it("[0] が null はスキップ", () => {
        const result = parseAffectedCells([[null, 3], [BAND3_DECIMAL, 3]]);
        expect(result).toHaveLength(1);
    });

    it("[0] が object はスキップ", () => {
        const result = parseAffectedCells([[{}, 3], [BAND3_DECIMAL, 3]]);
        expect(result).toHaveLength(1);
    });

    it("[0] が不正な decimal 文字列（'abc'）はスキップ", () => {
        const result = parseAffectedCells([["abc", 3], [BAND3_DECIMAL, 3]]);
        expect(result).toHaveLength(1);
    });

    it("[0] が空文字はスキップ", () => {
        const result = parseAffectedCells([["", 3], [BAND3_DECIMAL, 3]]);
        expect(result).toHaveLength(1);
    });

    it("[0] が非H3 数値文字列はスキップ", () => {
        const result = parseAffectedCells([["12345678", 3], [BAND3_DECIMAL, 3]]);
        expect(result).toHaveLength(1);
    });

    it("[0] が res7 以外のセルはスキップ", () => {
        const res9Decimal = resNDecimal(9);
        const result = parseAffectedCells([[res9Decimal, 3], [BAND3_DECIMAL, 3]]);
        expect(result).toHaveLength(1);
        expect(result[0].decimal).toBe(BAND3_DECIMAL);
    });

    it("[1] が 0（範囲外 band）はスキップ", () => {
        const result = parseAffectedCells([[BAND3_DECIMAL, 0], [BAND1_DECIMAL, 1]]);
        expect(result).toHaveLength(1);
        expect(result[0].decimal).toBe(BAND1_DECIMAL);
    });

    it("[1] が 4（範囲外 band）はスキップ", () => {
        const result = parseAffectedCells([[BAND3_DECIMAL, 4], [BAND1_DECIMAL, 1]]);
        expect(result).toHaveLength(1);
    });

    it("[1] が 1.5（非整数 band）はスキップ", () => {
        const result = parseAffectedCells([[BAND3_DECIMAL, 1.5], [BAND1_DECIMAL, 1]]);
        expect(result).toHaveLength(1);
    });

    it("[1] が文字列 'x'（非数値）はスキップ", () => {
        const result = parseAffectedCells([[BAND3_DECIMAL, "x"], [BAND1_DECIMAL, 1]]);
        expect(result).toHaveLength(1);
    });

    it("[1] が null はスキップ", () => {
        const result = parseAffectedCells([[BAND3_DECIMAL, null], [BAND1_DECIMAL, 1]]);
        expect(result).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// 混在: 有効＋不正が混ざった配列 → 有効分のみ、順序保持
// ---------------------------------------------------------------------------

describe("parseAffectedCells: 混在ケース", () => {
    it("有効＋不正が混ざった場合、有効分のみ返し順序を保持する", () => {
        const input = [
            [BAND1_DECIMAL, 1],     // 有効
            ["abc", 3],             // 不正 decimal
            [BAND3_DECIMAL, 3],     // 有効
            [BAND3_DECIMAL, 0],     // 不正 band
            [null, 2],              // 不正 [0]
            [BAND1_DECIMAL, 2],     // 有効
        ];
        const result = parseAffectedCells(input);
        expect(result).toHaveLength(3);
        expect(result[0].decimal).toBe(BAND1_DECIMAL);
        expect(result[0].band).toBe(1);
        expect(result[1].decimal).toBe(BAND3_DECIMAL);
        expect(result[1].band).toBe(3);
        expect(result[2].decimal).toBe(BAND1_DECIMAL);
        expect(result[2].band).toBe(2);
    });
});
