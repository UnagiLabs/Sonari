import { describe, expect, it } from "vitest";
import { latLngToResidenceCell, h3DecimalToHex } from "./h3-geo";
import type { ResidenceCellClass } from "./h3-cell-classifier";
import {
    buildOverlayCells,
    buildResidenceSummary,
    selectResidenceCell,
    type BuildOverlayCellsInput,
    type BuildResidenceSummaryInput,
    type ResidenceSelectionState,
} from "./residence-overlay";

// テスト用の実在 res7 セル（latLngToResidenceCell で生成）
// 注意: res7 のセルサイズは約5km²のため、近い座標は同一セルに落ちる場合がある。
// 異なるセルになることを事前確認した5地点を使用する。
const SHIBUYA = latLngToResidenceCell(35.6595, 139.7005);    // 872f5aad9ffffff
const SHINJUKU = latLngToResidenceCell(35.6938, 139.7034);   // 872f5a375ffffff
const HARAJUKU = latLngToResidenceCell(35.6702, 139.7027);   // 872f5a366ffffff
const IKEBUKURO = latLngToResidenceCell(35.7295, 139.7109);  // 872f5a372ffffff
const GINZA = latLngToResidenceCell(35.6717, 139.7649);      // 872f5aadeffffff

// ---------------------------------------------------------------------------
// buildOverlayCells
// ---------------------------------------------------------------------------

describe("buildOverlayCells", () => {
    it("kind が selected になる: selectedDecimal と一致するセル（分類が land でも selected が優先）", () => {
        const classifications = new Map<string, ResidenceCellClass>([
            [SHIBUYA.decimal, "land"],
        ]);
        const input: BuildOverlayCellsInput = {
            viewportCellsHex: [SHIBUYA.hex, SHINJUKU.hex],
            classifications,
            selectedDecimal: SHIBUYA.decimal,
        };
        const cells = buildOverlayCells(input);
        const shibuya = cells.find((c) => c.decimal === SHIBUYA.decimal);
        expect(shibuya?.kind).toBe("selected");
    });

    it("selected は1つだけ存在する", () => {
        const classifications = new Map<string, ResidenceCellClass>([
            [SHIBUYA.decimal, "land"],
            [SHINJUKU.decimal, "land"],
        ]);
        const input: BuildOverlayCellsInput = {
            viewportCellsHex: [SHIBUYA.hex, SHINJUKU.hex, HARAJUKU.hex],
            classifications,
            selectedDecimal: SHIBUYA.decimal,
        };
        const cells = buildOverlayCells(input);
        const selected = cells.filter((c) => c.kind === "selected");
        expect(selected).toHaveLength(1);
        expect(selected[0]?.decimal).toBe(SHIBUYA.decimal);
    });

    it("kind が disabled になる: water セル", () => {
        const classifications = new Map<string, ResidenceCellClass>([
            [SHIBUYA.decimal, "water"],
        ]);
        const input: BuildOverlayCellsInput = {
            viewportCellsHex: [SHIBUYA.hex],
            classifications,
            selectedDecimal: null,
        };
        const cells = buildOverlayCells(input);
        expect(cells[0]?.kind).toBe("disabled");
    });

    it("kind が selectable になる: land セル", () => {
        const classifications = new Map<string, ResidenceCellClass>([
            [SHIBUYA.decimal, "land"],
        ]);
        const input: BuildOverlayCellsInput = {
            viewportCellsHex: [SHIBUYA.hex],
            classifications,
            selectedDecimal: null,
        };
        const cells = buildOverlayCells(input);
        expect(cells[0]?.kind).toBe("selectable");
    });

    it("kind が selectable になる: unknown セル（degrade として選択許可）", () => {
        const classifications = new Map<string, ResidenceCellClass>([
            [SHIBUYA.decimal, "unknown"],
        ]);
        const input: BuildOverlayCellsInput = {
            viewportCellsHex: [SHIBUYA.hex],
            classifications,
            selectedDecimal: null,
        };
        const cells = buildOverlayCells(input);
        expect(cells[0]?.kind).toBe("selectable");
    });

    it("kind が pending になる: 未分類セル（classificationに存在しない）", () => {
        const classifications = new Map<string, ResidenceCellClass>();
        const input: BuildOverlayCellsInput = {
            viewportCellsHex: [SHIBUYA.hex],
            classifications,
            selectedDecimal: null,
        };
        const cells = buildOverlayCells(input);
        expect(cells[0]?.kind).toBe("pending");
    });

    it("各セルに非空 boundary と decimal がある", () => {
        const classifications = new Map<string, ResidenceCellClass>([
            [SHIBUYA.decimal, "land"],
            [SHINJUKU.decimal, "water"],
            [HARAJUKU.decimal, "unknown"],
        ]);
        const input: BuildOverlayCellsInput = {
            viewportCellsHex: [SHIBUYA.hex, SHINJUKU.hex, HARAJUKU.hex, IKEBUKURO.hex],
            classifications,
            selectedDecimal: null,
        };
        const cells = buildOverlayCells(input);
        expect(cells).toHaveLength(4);
        for (const cell of cells) {
            expect(cell.decimal).toBeTruthy();
            expect(cell.hex).toBeTruthy();
            expect(cell.boundary.length).toBeGreaterThan(0);
        }
    });

    it("入力順を保持する", () => {
        const hexList = [SHIBUYA.hex, SHINJUKU.hex, HARAJUKU.hex, IKEBUKURO.hex, GINZA.hex];
        const classifications = new Map<string, ResidenceCellClass>();
        const input: BuildOverlayCellsInput = {
            viewportCellsHex: hexList,
            classifications,
            selectedDecimal: null,
        };
        const cells = buildOverlayCells(input);
        expect(cells.map((c) => c.hex)).toEqual(hexList);
    });

    it("selectedDecimal が null のとき selected は存在しない", () => {
        const classifications = new Map<string, ResidenceCellClass>([
            [SHIBUYA.decimal, "land"],
        ]);
        const input: BuildOverlayCellsInput = {
            viewportCellsHex: [SHIBUYA.hex],
            classifications,
            selectedDecimal: null,
        };
        const cells = buildOverlayCells(input);
        const selected = cells.filter((c) => c.kind === "selected");
        expect(selected).toHaveLength(0);
    });

    it("kind の振り分け複合テスト: selected/disabled/selectable(land)/selectable(unknown)/pending が混在する", () => {
        const classifications = new Map<string, ResidenceCellClass>([
            [SHIBUYA.decimal, "land"],    // selected（selectedDecimalと一致）
            [SHINJUKU.decimal, "water"],  // disabled
            [HARAJUKU.decimal, "land"],   // selectable
            [IKEBUKURO.decimal, "unknown"], // selectable
            // GINZA は未分類 → pending
        ]);
        const input: BuildOverlayCellsInput = {
            viewportCellsHex: [SHIBUYA.hex, SHINJUKU.hex, HARAJUKU.hex, IKEBUKURO.hex, GINZA.hex],
            classifications,
            selectedDecimal: SHIBUYA.decimal,
        };
        const cells = buildOverlayCells(input);
        const kindMap = new Map(cells.map((c) => [c.decimal, c.kind]));
        expect(kindMap.get(SHIBUYA.decimal)).toBe("selected");
        expect(kindMap.get(SHINJUKU.decimal)).toBe("disabled");
        expect(kindMap.get(HARAJUKU.decimal)).toBe("selectable");
        expect(kindMap.get(IKEBUKURO.decimal)).toBe("selectable");
        expect(kindMap.get(GINZA.decimal)).toBe("pending");
    });
});

// ---------------------------------------------------------------------------
// selectResidenceCell
// ---------------------------------------------------------------------------

describe("selectResidenceCell", () => {
    const initialState: ResidenceSelectionState = { selectedDecimal: null };
    const stateWithSelection: ResidenceSelectionState = { selectedDecimal: SHIBUYA.decimal };

    it("water → rejected:true、state 不変、message あり", () => {
        const result = selectResidenceCell(initialState, SHINJUKU.decimal, "water");
        expect(result.rejected).toBe(true);
        expect(result.state).toEqual(initialState);
        expect(result.message).toBeTruthy();
        expect(typeof result.message).toBe("string");
    });

    it("water → message が正しい内容である", () => {
        const result = selectResidenceCell(initialState, SHINJUKU.decimal, "water");
        expect(result.message).toBe("海上などのセルは居住地として選択できません。");
    });

    it("land → rejected:false、selectedDecimal が更新される", () => {
        const result = selectResidenceCell(initialState, SHINJUKU.decimal, "land");
        expect(result.rejected).toBe(false);
        expect(result.state.selectedDecimal).toBe(SHINJUKU.decimal);
    });

    it("unknown → rejected:false、selectedDecimal が更新される", () => {
        const result = selectResidenceCell(initialState, SHINJUKU.decimal, "unknown");
        expect(result.rejected).toBe(false);
        expect(result.state.selectedDecimal).toBe(SHINJUKU.decimal);
    });

    it("undefined（pending）→ rejected:false、楽観的に selectedDecimal が更新される", () => {
        const result = selectResidenceCell(initialState, SHINJUKU.decimal, undefined);
        expect(result.rejected).toBe(false);
        expect(result.state.selectedDecimal).toBe(SHINJUKU.decimal);
    });

    it("land → 入力 state を破壊しない（元 state の selectedDecimal が変わらない）", () => {
        const before = stateWithSelection.selectedDecimal;
        selectResidenceCell(stateWithSelection, SHINJUKU.decimal, "land");
        expect(stateWithSelection.selectedDecimal).toBe(before);
    });

    it("water → 入力 state を破壊しない", () => {
        const before = stateWithSelection.selectedDecimal;
        selectResidenceCell(stateWithSelection, SHINJUKU.decimal, "water");
        expect(stateWithSelection.selectedDecimal).toBe(before);
    });

    it("既存の選択から別の land セルへの切り替え", () => {
        const result = selectResidenceCell(stateWithSelection, SHINJUKU.decimal, "land");
        expect(result.rejected).toBe(false);
        expect(result.state.selectedDecimal).toBe(SHINJUKU.decimal);
        // 元 state は変わらない
        expect(stateWithSelection.selectedDecimal).toBe(SHIBUYA.decimal);
    });
});

// ---------------------------------------------------------------------------
// buildResidenceSummary
// ---------------------------------------------------------------------------

describe("buildResidenceSummary", () => {
    it("selectedDecimal が null → No cell selected・cellHex null・cellDecimal null・resolution 7", () => {
        const input: BuildResidenceSummaryInput = {
            selectedDecimal: null,
            classification: undefined,
        };
        const summary = buildResidenceSummary(input);
        expect(summary.resolution).toBe(7);
        expect(summary.cellHex).toBeNull();
        expect(summary.cellDecimal).toBeNull();
        expect(summary.allowlistStatus).toBe("No cell selected");
    });

    it("land → 正しい allowlistStatus", () => {
        const input: BuildResidenceSummaryInput = {
            selectedDecimal: SHIBUYA.decimal,
            classification: "land",
        };
        const summary = buildResidenceSummary(input);
        expect(summary.allowlistStatus).toBe("Land cell · in residence allowlist");
    });

    it("water → 正しい allowlistStatus", () => {
        const input: BuildResidenceSummaryInput = {
            selectedDecimal: SHIBUYA.decimal,
            classification: "water",
        };
        const summary = buildResidenceSummary(input);
        expect(summary.allowlistStatus).toBe("Not in allowlist (sea or unsupported area)");
    });

    it("unknown → 正しい allowlistStatus", () => {
        const input: BuildResidenceSummaryInput = {
            selectedDecimal: SHIBUYA.decimal,
            classification: "unknown",
        };
        const summary = buildResidenceSummary(input);
        expect(summary.allowlistStatus).toBe("Allowlist status unavailable");
    });

    it("undefined（pending）→ 正しい allowlistStatus", () => {
        const input: BuildResidenceSummaryInput = {
            selectedDecimal: SHIBUYA.decimal,
            classification: undefined,
        };
        const summary = buildResidenceSummary(input);
        expect(summary.allowlistStatus).toBe("Checking allowlist…");
    });

    it("cellHex が h3DecimalToHex の結果と一致する", () => {
        const input: BuildResidenceSummaryInput = {
            selectedDecimal: SHIBUYA.decimal,
            classification: "land",
        };
        const summary = buildResidenceSummary(input);
        expect(summary.cellHex).toBe(h3DecimalToHex(SHIBUYA.decimal));
    });

    it("cellDecimal が selectedDecimal と一致する", () => {
        const input: BuildResidenceSummaryInput = {
            selectedDecimal: SHIBUYA.decimal,
            classification: "land",
        };
        const summary = buildResidenceSummary(input);
        expect(summary.cellDecimal).toBe(SHIBUYA.decimal);
    });

    it("resolution が常に RESIDENCE_H3_RESOLUTION (7) である", () => {
        for (const classification of ["land", "water", "unknown", undefined] as (ResidenceCellClass | undefined)[]) {
            const input: BuildResidenceSummaryInput = {
                selectedDecimal: SHIBUYA.decimal,
                classification,
            };
            const summary = buildResidenceSummary(input);
            expect(summary.resolution).toBe(7);
        }
    });

    it("エリア名フィールドが存在しない（オブジェクトのキー集合を検査）", () => {
        const input: BuildResidenceSummaryInput = {
            selectedDecimal: SHIBUYA.decimal,
            classification: "land",
        };
        const summary = buildResidenceSummary(input);
        const keys = Object.keys(summary);
        // スコープ外のフィールドが含まれていないこと
        expect(keys).not.toContain("areaName");
        expect(keys).not.toContain("area");
        expect(keys).not.toContain("regionName");
        expect(keys).not.toContain("placeName");
        // 想定するキーのみ存在すること
        expect(keys.sort()).toEqual(["allowlistStatus", "cellDecimal", "cellHex", "resolution"].sort());
    });
});
