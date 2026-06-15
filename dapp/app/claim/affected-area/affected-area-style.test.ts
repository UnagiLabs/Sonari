import { describe, expect, it } from "vitest";
import { bandAmount, bandColor } from "../catalog/cell-band-rules";
import type { AffectedCell } from "./affected-cells";
import {
    buildCellDetail,
    polygonStyleForBand,
    shortenCellId,
} from "./affected-area-style";

// ---------------------------------------------------------------------------
// テスト用定数（affected-area-geo.test.ts と同一アンカーセル）
// セル1: 608795190286614527 → Band3 の被災セル
// セル2: 608795262395088895 → Band1 の被災セル
// ---------------------------------------------------------------------------

const CELL1_DECIMAL = "608795190286614527"; // 18桁
const CELL1_HEX = "872e00001ffffff";

// ---------------------------------------------------------------------------
// polygonStyleForBand
// ---------------------------------------------------------------------------

describe("polygonStyleForBand: fillColor はバンド色と一致する", () => {
    it("Band1 の fillColor は bandColor(1) と一致する", () => {
        const style = polygonStyleForBand(1, false);
        expect(style.fillColor).toBe(bandColor(1));
    });

    it("Band2 の fillColor は bandColor(2) と一致する", () => {
        const style = polygonStyleForBand(2, false);
        expect(style.fillColor).toBe(bandColor(2));
    });

    it("Band3 の fillColor は bandColor(3) と一致する", () => {
        const style = polygonStyleForBand(3, false);
        expect(style.fillColor).toBe(bandColor(3));
    });

    it("highlighted=true でも fillColor はバンド色のまま（枠で強調）", () => {
        expect(polygonStyleForBand(1, true).fillColor).toBe(bandColor(1));
        expect(polygonStyleForBand(2, true).fillColor).toBe(bandColor(2));
        expect(polygonStyleForBand(3, true).fillColor).toBe(bandColor(3));
    });
});

describe("polygonStyleForBand: 強調セルは通常セルより strokeWeight・zIndex が大きい", () => {
    it("Band1: highlighted=true の strokeWeight > highlighted=false の strokeWeight", () => {
        const normal = polygonStyleForBand(1, false);
        const highlighted = polygonStyleForBand(1, true);
        expect(highlighted.strokeWeight).toBeGreaterThan(normal.strokeWeight);
    });

    it("Band2: highlighted=true の strokeWeight > highlighted=false の strokeWeight", () => {
        const normal = polygonStyleForBand(2, false);
        const highlighted = polygonStyleForBand(2, true);
        expect(highlighted.strokeWeight).toBeGreaterThan(normal.strokeWeight);
    });

    it("Band3: highlighted=true の strokeWeight > highlighted=false の strokeWeight", () => {
        const normal = polygonStyleForBand(3, false);
        const highlighted = polygonStyleForBand(3, true);
        expect(highlighted.strokeWeight).toBeGreaterThan(normal.strokeWeight);
    });

    it("Band1: highlighted=true の zIndex > highlighted=false の zIndex", () => {
        const normal = polygonStyleForBand(1, false);
        const highlighted = polygonStyleForBand(1, true);
        expect(highlighted.zIndex).toBeGreaterThan(normal.zIndex);
    });

    it("Band2: highlighted=true の zIndex > highlighted=false の zIndex", () => {
        const normal = polygonStyleForBand(2, false);
        const highlighted = polygonStyleForBand(2, true);
        expect(highlighted.zIndex).toBeGreaterThan(normal.zIndex);
    });

    it("Band3: highlighted=true の zIndex > highlighted=false の zIndex", () => {
        const normal = polygonStyleForBand(3, false);
        const highlighted = polygonStyleForBand(3, true);
        expect(highlighted.zIndex).toBeGreaterThan(normal.zIndex);
    });
});

describe("polygonStyleForBand: opacity は 0〜1 の範囲", () => {
    it("通常セル（Band1）の fillOpacity は 0〜1 の範囲", () => {
        const style = polygonStyleForBand(1, false);
        expect(style.fillOpacity).toBeGreaterThanOrEqual(0);
        expect(style.fillOpacity).toBeLessThanOrEqual(1);
    });

    it("通常セル（Band1）の strokeOpacity は 0〜1 の範囲", () => {
        const style = polygonStyleForBand(1, false);
        expect(style.strokeOpacity).toBeGreaterThanOrEqual(0);
        expect(style.strokeOpacity).toBeLessThanOrEqual(1);
    });

    it("強調セル（Band3）の fillOpacity は 0〜1 の範囲", () => {
        const style = polygonStyleForBand(3, true);
        expect(style.fillOpacity).toBeGreaterThanOrEqual(0);
        expect(style.fillOpacity).toBeLessThanOrEqual(1);
    });

    it("強調セル（Band3）の strokeOpacity は 0〜1 の範囲", () => {
        const style = polygonStyleForBand(3, true);
        expect(style.strokeOpacity).toBeGreaterThanOrEqual(0);
        expect(style.strokeOpacity).toBeLessThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// shortenCellId
// ---------------------------------------------------------------------------

describe("shortenCellId: 18桁の decimal を先頭6 + '…' + 末尾4 に省略する", () => {
    it("18桁 '608795190286614527' → '608795…4527'", () => {
        const result = shortenCellId(CELL1_DECIMAL);
        expect(result).toBe(`${CELL1_DECIMAL.slice(0, 6)}…${CELL1_DECIMAL.slice(-4)}`);
    });

    it("省略記号は U+2026（…）1文字", () => {
        const result = shortenCellId(CELL1_DECIMAL);
        // '608795…4527': 先頭6 + U+2026 + 末尾4 = 11文字
        expect(result).toHaveLength(11);
        expect(result[6]).toBe("…");
    });

    it("12桁の場合は省略される（length > 11 のため）", () => {
        const decimal = "123456789012"; // 12桁
        const result = shortenCellId(decimal);
        expect(result).toBe(`${decimal.slice(0, 6)}…${decimal.slice(-4)}`);
    });
});

describe("shortenCellId: 11桁以下はそのまま返す", () => {
    it("11桁ちょうど → そのまま返す（省略なし）", () => {
        const decimal = "12345678901"; // 11桁
        expect(shortenCellId(decimal)).toBe(decimal);
    });

    it("10桁 → そのまま返す", () => {
        const decimal = "1234567890"; // 10桁
        expect(shortenCellId(decimal)).toBe(decimal);
    });

    it("6桁 → そのまま返す", () => {
        const decimal = "123456"; // 6桁
        expect(shortenCellId(decimal)).toBe(decimal);
    });

    it("空文字 → そのまま返す", () => {
        expect(shortenCellId("")).toBe("");
    });
});

// ---------------------------------------------------------------------------
// buildCellDetail
// ---------------------------------------------------------------------------

describe("buildCellDetail: Band3 セルから正しいデータを組み立てる", () => {
    const band3Cell: AffectedCell = {
        decimal: CELL1_DECIMAL,
        hex: CELL1_HEX,
        band: 3,
    };

    it("band === 3", () => {
        const detail = buildCellDetail(band3Cell);
        expect(detail.band).toBe(3);
    });

    it("amountUsdc === bandAmount(3)（=300）", () => {
        const detail = buildCellDetail(band3Cell);
        expect(detail.amountUsdc).toBe(bandAmount(3));
        expect(detail.amountUsdc).toBe(300);
    });

    it("shortCellId === shortenCellId(decimal)", () => {
        const detail = buildCellDetail(band3Cell);
        expect(detail.shortCellId).toBe(shortenCellId(CELL1_DECIMAL));
    });

    it("decimal が元の decimal と一致する", () => {
        const detail = buildCellDetail(band3Cell);
        expect(detail.decimal).toBe(CELL1_DECIMAL);
    });
});

describe("buildCellDetail: Band1・Band2 で amountUsdc が #382 規則と一致する", () => {
    it("Band1: amountUsdc === bandAmount(1)（=100）", () => {
        const cell: AffectedCell = {
            decimal: "608795262395088895",
            hex: "872e010cbffffff",
            band: 1,
        };
        const detail = buildCellDetail(cell);
        expect(detail.amountUsdc).toBe(bandAmount(1));
        expect(detail.amountUsdc).toBe(100);
    });

    it("Band2: amountUsdc === bandAmount(2)（=200）", () => {
        const cell: AffectedCell = {
            decimal: "608795262395088895",
            hex: "872e010cbffffff",
            band: 2,
        };
        const detail = buildCellDetail(cell);
        expect(detail.amountUsdc).toBe(bandAmount(2));
        expect(detail.amountUsdc).toBe(200);
    });
});
