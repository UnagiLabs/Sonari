import { describe, expect, it } from "vitest";
import {
    initialSheetState,
    sheetStateAfterSelection,
    toggleSheet,
    type SheetState,
} from "./residence-sheet";

describe("initialSheetState", () => {
    it("collapsed で始まる", () => {
        expect(initialSheetState).toBe<SheetState>("collapsed");
    });
});

describe("toggleSheet", () => {
    it("collapsed → expanded", () => {
        expect(toggleSheet("collapsed")).toBe<SheetState>("expanded");
    });

    it("expanded → collapsed", () => {
        expect(toggleSheet("expanded")).toBe<SheetState>("collapsed");
    });

    it("往復で元に戻る", () => {
        expect(toggleSheet(toggleSheet("collapsed"))).toBe<SheetState>("collapsed");
    });
});

describe("sheetStateAfterSelection", () => {
    it("collapsed → expanded（セル選択で開く）", () => {
        expect(sheetStateAfterSelection("collapsed")).toBe<SheetState>("expanded");
    });

    it("expanded → expanded（既に開いていればそのまま）", () => {
        expect(sheetStateAfterSelection("expanded")).toBe<SheetState>("expanded");
    });
});
