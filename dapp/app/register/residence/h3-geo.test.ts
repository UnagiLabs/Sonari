import { parseH3Index } from "@sonari/proof-core";
import { latLngToCell } from "h3-js";
import { describe, expect, it } from "vitest";
import {
    h3DecimalToHex,
    h3HexToDecimal,
    latLngToResidenceCell,
    normalizeResidenceCellInput,
    RESIDENCE_H3_RESOLUTION,
    residenceCellBoundary,
    residenceCellCenter,
    residenceCellsInViewport,
} from "./h3-geo";

// 渋谷周辺（非ペンタゴン通常六角セル）
const SHIBUYA_LAT = 35.6595;
const SHIBUYA_LNG = 139.7005;

describe("h3-geo: 定数", () => {
    it("RESIDENCE_H3_RESOLUTION は 7 である", () => {
        expect(RESIDENCE_H3_RESOLUTION).toBe(7);
    });
});

describe("h3-geo: latLngToResidenceCell", () => {
    it("渋谷座標から ResidenceCell を生成できる", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        expect(cell).toHaveProperty("hex");
        expect(cell).toHaveProperty("decimal");
    });

    it("hex は小文字16進15桁で '87' 始まり（res7）", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        expect(cell.hex).toMatch(/^87[0-9a-f]{13}$/);
    });

    it("decimal は parseH3Index(decimal, 7) を通過する", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        expect(() => parseH3Index(cell.decimal, 7)).not.toThrow();
    });
});

describe("h3-geo: h3HexToDecimal / h3DecimalToHex 双方向変換", () => {
    it("hex → decimal → hex で元に戻る", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const dec = h3HexToDecimal(cell.hex);
        const hex = h3DecimalToHex(dec);
        expect(hex).toBe(cell.hex);
    });

    it("decimal → hex → decimal で元に戻る", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const hex = h3DecimalToHex(cell.decimal);
        const dec = h3HexToDecimal(hex);
        expect(dec).toBe(cell.decimal);
    });

    it("h3HexToDecimal の結果は parseH3Index で検証できる", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const dec = h3HexToDecimal(cell.hex);
        expect(() => parseH3Index(dec, 7)).not.toThrow();
    });
});

describe("h3-geo: residenceCellCenter (round-trip)", () => {
    it("center を求め、その座標を再度セル変換すると同じ decimal になる", () => {
        const original = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const center = residenceCellCenter(original);

        expect(typeof center.lat).toBe("number");
        expect(typeof center.lng).toBe("number");

        const roundTripped = latLngToResidenceCell(center.lat, center.lng);
        expect(roundTripped.decimal).toBe(original.decimal);
    });

    it("hex 文字列を渡しても動作する", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const center = residenceCellCenter(cell.hex);
        expect(typeof center.lat).toBe("number");
        expect(typeof center.lng).toBe("number");
    });
});

describe("h3-geo: residenceCellBoundary", () => {
    it("ResidenceCell を渡すと複数の {lat, lng} を返す", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const boundary = residenceCellBoundary(cell);

        expect(boundary.length).toBeGreaterThan(2);
        for (const pt of boundary) {
            expect(typeof pt.lat).toBe("number");
            expect(typeof pt.lng).toBe("number");
        }
    });

    it("hex 文字列を渡しても動作する", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const boundary = residenceCellBoundary(cell.hex);
        expect(boundary.length).toBeGreaterThan(2);
    });
});

describe("h3-geo: residenceCellsInViewport", () => {
    it("渋谷周辺の小さな範囲から複数セルを返す", () => {
        const bounds = {
            north: SHIBUYA_LAT + 0.05,
            south: SHIBUYA_LAT - 0.05,
            east: SHIBUYA_LNG + 0.05,
            west: SHIBUYA_LNG - 0.05,
        };
        const cells = residenceCellsInViewport(bounds);
        expect(cells.length).toBeGreaterThan(1);
        for (const hex of cells) {
            expect(hex).toMatch(/^[0-9a-f]+$/);
        }
    });

    it("中心セルが含まれる", () => {
        const bounds = {
            north: SHIBUYA_LAT + 0.05,
            south: SHIBUYA_LAT - 0.05,
            east: SHIBUYA_LNG + 0.05,
            west: SHIBUYA_LNG - 0.05,
        };
        const centerCell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const cells = residenceCellsInViewport(bounds);
        expect(cells).toContain(centerCell.hex);
    });
});

describe("h3-geo: normalizeResidenceCellInput", () => {
    it("素の hex を受理する", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const result = normalizeResidenceCellInput(cell.hex);
        expect(result.hex).toBe(cell.hex);
        expect(result.decimal).toBe(cell.decimal);
    });

    it("'h3-' 接頭辞付き hex を受理する", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const result = normalizeResidenceCellInput(`h3-${cell.hex}`);
        expect(result.hex).toBe(cell.hex);
        expect(result.decimal).toBe(cell.decimal);
    });

    it("'0x' 接頭辞付き hex を受理する", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const result = normalizeResidenceCellInput(`0x${cell.hex}`);
        expect(result.hex).toBe(cell.hex);
        expect(result.decimal).toBe(cell.decimal);
    });

    it("大文字 hex を受理して小文字に正規化する", () => {
        const cell = latLngToResidenceCell(SHIBUYA_LAT, SHIBUYA_LNG);
        const result = normalizeResidenceCellInput(cell.hex.toUpperCase());
        expect(result.hex).toBe(cell.hex);
    });

    it("res7 でない有効な H3 hex は throw する", () => {
        // res5 のセル（渋谷周辺）
        const res5Hex = latLngToCell(SHIBUYA_LAT, SHIBUYA_LNG, 5);
        expect(() => normalizeResidenceCellInput(res5Hex)).toThrow();
    });

    it("不正な文字列は throw する", () => {
        expect(() => normalizeResidenceCellInput("not-a-valid-cell")).toThrow();
        expect(() => normalizeResidenceCellInput("")).toThrow();
        expect(() => normalizeResidenceCellInput("xyz")).toThrow();
    });
});
