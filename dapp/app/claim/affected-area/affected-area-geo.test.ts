import { latLngToCell } from "h3-js";
import { describe, expect, it } from "vitest";
import { h3HexToDecimal } from "../../register/residence/h3-geo";
import { parseAffectedCells } from "./affected-cells";
import {
    MAX_AFFECTED_VIEWPORT_CELLS,
    computeAffectedAreaBounds,
    selectMapMode,
    selectVisibleCells,
} from "./affected-area-geo";

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

// ---------------------------------------------------------------------------
// selectVisibleCells (STEP 3)
// ---------------------------------------------------------------------------
// テスト用定数
// CELL1: lat 39.542..., lng 143.609... (太平洋沖)
// CELL2: lat 39.402..., lng 142.127... (三陸沖)
//
// bounds 設計メモ:
// - "CELL1 のみ包含" bounds: south=39.5, north=39.6, west=143.5, east=143.7
// - "CELL2 のみ包含" bounds: south=39.3, north=39.5, west=142.0, east=142.3
// - "両方包含" bounds: south=39.3, north=39.6, west=142.0, east=143.7
// - "どちらも包含しない" bounds: south=35.0, north=36.0, west=138.0, east=139.0

const BOUNDS_CELL1_ONLY = { north: 39.6, south: 39.5, east: 143.7, west: 143.5 };
const BOUNDS_CELL2_ONLY = { north: 39.5, south: 39.3, east: 142.3, west: 142.0 };
const BOUNDS_BOTH = { north: 39.6, south: 39.3, east: 143.7, west: 142.0 };
const BOUNDS_NONE = { north: 36.0, south: 35.0, east: 139.0, west: 138.0 };

describe("selectVisibleCells: MAX_AFFECTED_VIEWPORT_CELLS 定数", () => {
    it("MAX_AFFECTED_VIEWPORT_CELLS は 600 である", () => {
        expect(MAX_AFFECTED_VIEWPORT_CELLS).toBe(600);
    });
});

describe("selectVisibleCells: bounds 内外の混在", () => {
    it("bounds 内のセルのみ返し、bounds 外は除外する（順序保持）", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const result = selectVisibleCells({ cells, bounds: BOUNDS_CELL1_ONLY });
        expect(result).toHaveLength(1);
        expect(result[0]?.decimal).toBe(CELL1_DECIMAL);
    });

    it("CELL2 のみ bounds 内 → CELL2 だけ返る", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const result = selectVisibleCells({ cells, bounds: BOUNDS_CELL2_ONLY });
        expect(result).toHaveLength(1);
        expect(result[0]?.decimal).toBe(CELL2_DECIMAL);
    });

    it("両方 bounds 内 → 両方返る（入力順）", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const result = selectVisibleCells({ cells, bounds: BOUNDS_BOTH });
        expect(result).toHaveLength(2);
        expect(result[0]?.decimal).toBe(CELL1_DECIMAL);
        expect(result[1]?.decimal).toBe(CELL2_DECIMAL);
    });

    it("どちらも bounds 外 → 空配列", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const result = selectVisibleCells({ cells, bounds: BOUNDS_NONE });
        expect(result).toHaveLength(0);
    });

    it("cells が空配列 → 空配列", () => {
        const result = selectVisibleCells({ cells: [], bounds: BOUNDS_BOTH });
        expect(result).toHaveLength(0);
    });
});

describe("selectVisibleCells: limit（cap）", () => {
    it("limit 未指定時は MAX_AFFECTED_VIEWPORT_CELLS がデフォルト（2件全件返る）", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const result = selectVisibleCells({ cells, bounds: BOUNDS_BOTH });
        expect(result).toHaveLength(2);
    });

    it("limit=1 かつ 2件 bounds 内 → 先頭 1 件のみ（入力順で cap）", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const result = selectVisibleCells({ cells, bounds: BOUNDS_BOTH, limit: 1 });
        expect(result).toHaveLength(1);
        expect(result[0]?.decimal).toBe(CELL1_DECIMAL);
    });

    it("limit=2 かつ 2件 bounds 内 → 全件返る（cap に引っかからない）", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const result = selectVisibleCells({ cells, bounds: BOUNDS_BOTH, limit: 2 });
        expect(result).toHaveLength(2);
    });

    it("limit=0 かつ 2件 bounds 内 → 空配列（ただし highlighted は除く）", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const result = selectVisibleCells({ cells, bounds: BOUNDS_BOTH, limit: 0 });
        expect(result).toHaveLength(0);
    });

    it("入力配列を破壊しない（元の cells は変更されない）", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const originalLength = cells.length;
        selectVisibleCells({ cells, bounds: BOUNDS_BOTH, limit: 1 });
        expect(cells).toHaveLength(originalLength);
    });
});

describe("selectVisibleCells: 強調セル（highlightedDecimal）", () => {
    it("強調セルが bounds 内かつ cap 内 → 重複追加されない（1 件のみ）", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        // 両方 bounds 内、limit=2、強調=CELL1 → 重複なし
        const result = selectVisibleCells({
            cells,
            bounds: BOUNDS_BOTH,
            limit: 2,
            highlightedDecimal: CELL1_DECIMAL,
        });
        expect(result).toHaveLength(2);
        const cell1Entries = result.filter((c) => c.decimal === CELL1_DECIMAL);
        expect(cell1Entries).toHaveLength(1);
    });

    it("強調セルが bounds 外 → cap 後結果の末尾に追加される", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        // CELL1 bounds 内（1件）、CELL2 bounds 外、強調=CELL2
        // → cap 後: [CELL1]、末尾追加: [CELL1, CELL2]
        const result = selectVisibleCells({
            cells,
            bounds: BOUNDS_CELL1_ONLY,
            highlightedDecimal: CELL2_DECIMAL,
        });
        expect(result).toHaveLength(2);
        expect(result[0]?.decimal).toBe(CELL1_DECIMAL);
        expect(result[1]?.decimal).toBe(CELL2_DECIMAL);
    });

    it("強調セルが cap で溢れた（bounds 内だが limit 超）→ 末尾に追加される", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        // 両方 bounds 内、limit=1（CELL1 のみ cap 内）、強調=CELL2
        // → cap 後: [CELL1]、CELL2 は cap で溢れたので末尾追加: [CELL1, CELL2]
        const result = selectVisibleCells({
            cells,
            bounds: BOUNDS_BOTH,
            limit: 1,
            highlightedDecimal: CELL2_DECIMAL,
        });
        expect(result).toHaveLength(2);
        expect(result[0]?.decimal).toBe(CELL1_DECIMAL);
        expect(result[1]?.decimal).toBe(CELL2_DECIMAL);
    });

    it("強調セル指定が cells に存在しない無効値 → 無視（追加されない）", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
        ]);
        const result = selectVisibleCells({
            cells,
            bounds: BOUNDS_CELL1_ONLY,
            highlightedDecimal: "9999999999999999999", // 存在しない
        });
        expect(result).toHaveLength(1);
        expect(result[0]?.decimal).toBe(CELL1_DECIMAL);
    });

    it("highlightedDecimal が null → 強調処理なし（通常 cap のみ）", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const result = selectVisibleCells({
            cells,
            bounds: BOUNDS_BOTH,
            limit: 1,
            highlightedDecimal: null,
        });
        expect(result).toHaveLength(1);
        expect(result[0]?.decimal).toBe(CELL1_DECIMAL);
    });

    it("highlightedDecimal 未指定 → 強調処理なし（通常 cap のみ）", () => {
        const cells = parseAffectedCells([
            [CELL1_DECIMAL, 3],
            [CELL2_DECIMAL, 1],
        ]);
        const result = selectVisibleCells({
            cells,
            bounds: BOUNDS_BOTH,
            limit: 1,
        });
        expect(result).toHaveLength(1);
        expect(result[0]?.decimal).toBe(CELL1_DECIMAL);
    });
});

describe("selectVisibleCells: 境界線上のセル（境界包含）", () => {
    it("セル中心が bounds の north 境界上 → 含む（<=）", () => {
        // CELL1 の lat = 39.54213437644575
        // north をその lat に設定 → 境界上で含む
        const boundsExact: { north: number; south: number; east: number; west: number } = {
            north: 39.54213437644575,
            south: 39.3,
            east: 143.7,
            west: 142.0,
        };
        const cells = parseAffectedCells([[CELL1_DECIMAL, 3]]);
        const result = selectVisibleCells({ cells, bounds: boundsExact });
        expect(result).toHaveLength(1);
    });

    it("セル中心が bounds の south 境界上 → 含む（>=）", () => {
        // CELL2 の lat = 39.40296976134385
        const boundsExact: { north: number; south: number; east: number; west: number } = {
            north: 39.6,
            south: 39.40296976134385,
            east: 143.7,
            west: 142.0,
        };
        const cells = parseAffectedCells([[CELL2_DECIMAL, 1]]);
        const result = selectVisibleCells({ cells, bounds: boundsExact });
        expect(result).toHaveLength(1);
    });

    it("セル中心が bounds の east 境界上 → 含む（<=）", () => {
        // CELL1 の lng = 143.60919843298643
        const boundsExact: { north: number; south: number; east: number; west: number } = {
            north: 39.6,
            south: 39.3,
            east: 143.60919843298643,
            west: 142.0,
        };
        const cells = parseAffectedCells([[CELL1_DECIMAL, 3]]);
        const result = selectVisibleCells({ cells, bounds: boundsExact });
        expect(result).toHaveLength(1);
    });

    it("セル中心が bounds の west 境界上 → 含む（>=）", () => {
        // CELL2 の lng = 142.1271107685466
        const boundsExact: { north: number; south: number; east: number; west: number } = {
            north: 39.6,
            south: 39.3,
            east: 143.7,
            west: 142.1271107685466,
        };
        const cells = parseAffectedCells([[CELL2_DECIMAL, 1]]);
        const result = selectVisibleCells({ cells, bounds: boundsExact });
        expect(result).toHaveLength(1);
    });
});
