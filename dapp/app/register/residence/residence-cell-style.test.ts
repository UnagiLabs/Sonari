import { describe, expect, it } from "vitest";
import { buildCellLegendEntries, polygonStyleForKind } from "./residence-cell-style";

describe("polygonStyleForKind", () => {
    it("selected は strokeWeight 3.5 を持つ", () => {
        const style = polygonStyleForKind("selected");
        expect(style.strokeWeight).toBe(3.5);
    });

    it("selectable は strokeWeight 1.5 を持つ", () => {
        const style = polygonStyleForKind("selectable");
        expect(style.strokeWeight).toBe(1.5);
    });

    it("disabled は strokeWeight 1 を持つ", () => {
        const style = polygonStyleForKind("disabled");
        expect(style.strokeWeight).toBe(1);
    });

    it("pending は strokeWeight 1 を持つ", () => {
        const style = polygonStyleForKind("pending");
        expect(style.strokeWeight).toBe(1);
    });

    it("4 種別の strokeWeight に明確な差がある（selected > selectable > disabled/pending）", () => {
        const selected = polygonStyleForKind("selected").strokeWeight ?? 0;
        const selectable = polygonStyleForKind("selectable").strokeWeight ?? 0;
        const disabled = polygonStyleForKind("disabled").strokeWeight ?? 0;
        const pending = polygonStyleForKind("pending").strokeWeight ?? 0;
        expect(selected).toBeGreaterThan(selectable);
        expect(selectable).toBeGreaterThan(disabled);
        expect(disabled).toBe(pending);
    });

    it("disabled は clickable:true を維持する（海セルの理由表示のため）", () => {
        const style = polygonStyleForKind("disabled");
        expect(style.clickable).toBe(true);
    });

    it("selected は clickable:true を持つ", () => {
        expect(polygonStyleForKind("selected").clickable).toBe(true);
    });

    it("selectable は clickable:true を持つ", () => {
        expect(polygonStyleForKind("selectable").clickable).toBe(true);
    });

    it("pending は clickable:true を持つ", () => {
        expect(polygonStyleForKind("pending").clickable).toBe(true);
    });
});

describe("buildCellLegendEntries", () => {
    it("3 要素を返す（selected / selectable / disabled）", () => {
        const entries = buildCellLegendEntries();
        expect(entries).toHaveLength(3);
    });

    it("pending は凡例に含めない", () => {
        const entries = buildCellLegendEntries();
        expect(entries.every((e) => e.kind !== "pending")).toBe(true);
    });

    it("selected エントリの labelKey が 'legend.selected'", () => {
        const entries = buildCellLegendEntries();
        const entry = entries.find((e) => e.kind === "selected");
        expect(entry).toBeDefined();
        expect(entry?.labelKey).toBe("legend.selected");
    });

    it("selectable エントリの labelKey が 'legend.selectable'", () => {
        const entries = buildCellLegendEntries();
        const entry = entries.find((e) => e.kind === "selectable");
        expect(entry).toBeDefined();
        expect(entry?.labelKey).toBe("legend.selectable");
    });

    it("disabled エントリの labelKey が 'legend.disabled'", () => {
        const entries = buildCellLegendEntries();
        const entry = entries.find((e) => e.kind === "disabled");
        expect(entry).toBeDefined();
        expect(entry?.labelKey).toBe("legend.disabled");
    });

    it("selected エントリの swatch が 'solid-bold'", () => {
        const entries = buildCellLegendEntries();
        const entry = entries.find((e) => e.kind === "selected");
        expect(entry?.swatch).toBe("solid-bold");
    });

    it("selectable エントリの swatch が 'solid'", () => {
        const entries = buildCellLegendEntries();
        const entry = entries.find((e) => e.kind === "selectable");
        expect(entry?.swatch).toBe("solid");
    });

    it("disabled エントリの swatch が 'dashed'", () => {
        const entries = buildCellLegendEntries();
        const entry = entries.find((e) => e.kind === "disabled");
        expect(entry?.swatch).toBe("dashed");
    });

    it("各エントリに kind, labelKey, swatch が含まれる", () => {
        const entries = buildCellLegendEntries();
        for (const entry of entries) {
            expect(entry).toHaveProperty("kind");
            expect(entry).toHaveProperty("labelKey");
            expect(entry).toHaveProperty("swatch");
        }
    });
});
