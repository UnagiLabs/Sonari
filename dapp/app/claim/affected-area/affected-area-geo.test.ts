import { latLngToCell } from "h3-js";
import { describe, expect, it } from "vitest";
import { h3HexToDecimal } from "../../register/residence/h3-geo";
import { parseAffectedCells } from "./affected-cells";
import { computeAffectedAreaBounds, selectMapMode } from "./affected-area-geo";

// ---------------------------------------------------------------------------
// テスト用アンカーセル（STEP 1 テストと同じ実データ）
// セル1: 608795190286614527 → 872e00001ffffff (lat: 39.542..., lng: 143.609...)
// セル2: 608795262395088895 → 872e010cbffffff (lat: 39.402..., lng: 142.127...)
// ---------------------------------------------------------------------------

const CELL1_DECIMAL = "608795190286614527"; // res7 有効
const CELL1_HEX = "872e00001ffffff";
const CELL2_DECIMAL = "608795262395088895"; // res7 有効
const CELL2_HEX = "872e010cbffffff";

// テストでのみ使う res7 以外のセル（res9）
function res9Decimal(): string {
    const hex = latLngToCell(38.2688, 140.8721, 9);
    return h3HexToDecimal(hex);
}

// ---------------------------------------------------------------------------
// selectMapMode
// ---------------------------------------------------------------------------

describe("selectMapMode: home モード", () => {
    it("有効な res7 居住セル → 'home'", () => {
        expect(selectMapMode(CELL1_DECIMAL)).toBe("home");
    });

    it("別の有効 res7 セル → 'home'", () => {
        expect(selectMapMode(CELL2_DECIMAL)).toBe("home");
    });
});

describe("selectMapMode: overview モード（無効・未指定入力）", () => {
    it("null → 'overview'", () => {
        expect(selectMapMode(null)).toBe("overview");
    });

    it("undefined → 'overview'", () => {
        expect(selectMapMode(undefined)).toBe("overview");
    });

    it("空文字 → 'overview'", () => {
        expect(selectMapMode("")).toBe("overview");
    });

    it("不正文字列 'abc' → 'overview'", () => {
        expect(selectMapMode("abc")).toBe("overview");
    });

    it("H3 でない数値文字列 '0' → 'overview'", () => {
        expect(selectMapMode("0")).toBe("overview");
    });

    it("H3 でない数値文字列 '12345678' → 'overview'", () => {
        expect(selectMapMode("12345678")).toBe("overview");
    });

    it("res7 以外の H3 セル（res9）→ 'overview'", () => {
        expect(selectMapMode(res9Decimal())).toBe("overview");
    });
});

// ---------------------------------------------------------------------------
// computeAffectedAreaBounds
// ---------------------------------------------------------------------------

describe("computeAffectedAreaBounds: 空配列", () => {
    it("空配列 → null を返す", () => {
        expect(computeAffectedAreaBounds([])).toBeNull();
    });
});

describe("computeAffectedAreaBounds: 1セル", () => {
    it("1セル → north≈south かつ east≈west（そのセル中心）", () => {
        const cells = parseAffectedCells([[CELL1_DECIMAL, 3]]);
        const bounds = computeAffectedAreaBounds(cells);
        expect(bounds).not.toBeNull();
        // lat: 39.542..., lng: 143.609...
        expect(bounds?.north).toBeCloseTo(39.54213437644575, 5);
        expect(bounds?.south).toBeCloseTo(39.54213437644575, 5);
        expect(bounds?.east).toBeCloseTo(143.60919843298643, 5);
        expect(bounds?.west).toBeCloseTo(143.60919843298643, 5);
        // north === south（退化）
        expect(bounds?.north).toBeCloseTo(bounds?.south ?? 0, 10);
        expect(bounds?.east).toBeCloseTo(bounds?.west ?? 0, 10);
    });
});

describe("computeAffectedAreaBounds: 複数セル", () => {
    it("2セルで north >= south、east >= west", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const bounds = computeAffectedAreaBounds(cells);
        expect(bounds).not.toBeNull();
        expect(bounds!.north).toBeGreaterThanOrEqual(bounds!.south);
        expect(bounds!.east).toBeGreaterThanOrEqual(bounds!.west);
    });

    it("2セルの north がより高緯度セルの中心 lat と一致する", () => {
        // CELL1: lat 39.542... (高い) / CELL2: lat 39.402... (低い)
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const bounds = computeAffectedAreaBounds(cells);
        expect(bounds?.north).toBeCloseTo(39.54213437644575, 5);
    });

    it("2セルの south がより低緯度セルの中心 lat と一致する", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const bounds = computeAffectedAreaBounds(cells);
        expect(bounds?.south).toBeCloseTo(39.40296976134385, 5);
    });

    it("2セルの east がより東経度セルの中心 lng と一致する", () => {
        // CELL1: lng 143.609... (東) / CELL2: lng 142.127... (西)
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const bounds = computeAffectedAreaBounds(cells);
        expect(bounds?.east).toBeCloseTo(143.60919843298643, 5);
    });

    it("2セルの west がより西経度セルの中心 lng と一致する", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const bounds = computeAffectedAreaBounds(cells);
        expect(bounds?.west).toBeCloseTo(142.1271107685466, 5);
    });

    it("セル配列の順序に依存せず同じ bounds を返す（決定的）", () => {
        const cellsAB = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const cellsBA = parseAffectedCells([
            [CELL2_DECIMAL, 1],
            [CELL1_DECIMAL, 3],
        ]);
        const boundsAB = computeAffectedAreaBounds(cellsAB);
        const boundsBA = computeAffectedAreaBounds(cellsBA);
        expect(boundsAB?.north).toBeCloseTo(boundsBA?.north ?? 0, 10);
        expect(boundsAB?.south).toBeCloseTo(boundsBA?.south ?? 0, 10);
        expect(boundsAB?.east).toBeCloseTo(boundsBA?.east ?? 0, 10);
        expect(boundsAB?.west).toBeCloseTo(boundsBA?.west ?? 0, 10);
    });

    it("CELL1 hex を直接 AffectedCell として渡しても同じ bounds", () => {
        // AffectedCell を手動で組み立てるケース
        const cells = [
            { decimal: CELL1_DECIMAL, hex: CELL1_HEX, band: 3 as const },
            { decimal: CELL2_DECIMAL, hex: CELL2_HEX, band: 1 as const },
        ];
        const bounds = computeAffectedAreaBounds(cells);
        expect(bounds?.north).toBeCloseTo(39.54213437644575, 5);
        expect(bounds?.south).toBeCloseTo(39.40296976134385, 5);
        expect(bounds?.east).toBeCloseTo(143.60919843298643, 5);
        expect(bounds?.west).toBeCloseTo(142.1271107685466, 5);
    });
});
