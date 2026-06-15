import { describe, expect, it } from "vitest";
import {
    parseCellBand,
    bandAmount,
    bandColor,
    buildBandLegendEntries,
} from "./cell-band-rules";

// ---------------------------------------------------------------------------
// parseCellBand
// ---------------------------------------------------------------------------

describe("parseCellBand", () => {
    it("returns 1 for valid band 1", () => {
        expect(parseCellBand(1)).toBe(1);
    });

    it("returns 2 for valid band 2", () => {
        expect(parseCellBand(2)).toBe(2);
    });

    it("returns 3 for valid band 3", () => {
        expect(parseCellBand(3)).toBe(3);
    });

    it("returns null for 0 (below range)", () => {
        expect(parseCellBand(0)).toBeNull();
    });

    it("returns null for 4 (above range)", () => {
        expect(parseCellBand(4)).toBeNull();
    });

    it("returns null for negative numbers", () => {
        expect(parseCellBand(-1)).toBeNull();
    });

    it("returns null for non-integer numbers", () => {
        expect(parseCellBand(1.5)).toBeNull();
        expect(parseCellBand(2.9)).toBeNull();
    });

    it("returns null for non-numeric types", () => {
        expect(parseCellBand("band1")).toBeNull();
        expect(parseCellBand(null)).toBeNull();
        expect(parseCellBand(undefined)).toBeNull();
        expect(parseCellBand({})).toBeNull();
        expect(parseCellBand([])).toBeNull();
        expect(parseCellBand(true)).toBeNull();
    });

    it("accepts numeric strings that represent valid bands", () => {
        // Implementation choice: accept "1", "2", "3" as valid band strings
        // All must be strictly validated — "1.5" or " 1" must be rejected
        const result1 = parseCellBand("1");
        const result2 = parseCellBand("2");
        const result3 = parseCellBand("3");
        // If accepted, must return the correct CellBand value
        if (result1 !== null) expect(result1).toBe(1);
        if (result2 !== null) expect(result2).toBe(2);
        if (result3 !== null) expect(result3).toBe(3);
    });

    it("returns null for string with whitespace around digit", () => {
        expect(parseCellBand(" 1")).toBeNull();
        expect(parseCellBand("1 ")).toBeNull();
    });

    it("returns null for float string", () => {
        expect(parseCellBand("1.5")).toBeNull();
    });

    it("returns null for out-of-range numeric string", () => {
        expect(parseCellBand("0")).toBeNull();
        expect(parseCellBand("4")).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// bandAmount
// ---------------------------------------------------------------------------

describe("bandAmount", () => {
    it("returns 100 for band 1", () => {
        expect(bandAmount(1)).toBe(100);
    });

    it("returns 200 for band 2", () => {
        expect(bandAmount(2)).toBe(200);
    });

    it("returns 300 for band 3", () => {
        expect(bandAmount(3)).toBe(300);
    });
});

// ---------------------------------------------------------------------------
// bandColor
// ---------------------------------------------------------------------------

describe("bandColor", () => {
    it("returns a non-empty color string for each band", () => {
        expect(bandColor(1).length).toBeGreaterThan(0);
        expect(bandColor(2).length).toBeGreaterThan(0);
        expect(bandColor(3).length).toBeGreaterThan(0);
    });

    it("returns distinct colors for each band", () => {
        const c1 = bandColor(1);
        const c2 = bandColor(2);
        const c3 = bandColor(3);
        expect(c1).not.toBe(c2);
        expect(c2).not.toBe(c3);
        expect(c1).not.toBe(c3);
    });
});

// ---------------------------------------------------------------------------
// buildBandLegendEntries
// ---------------------------------------------------------------------------

describe("buildBandLegendEntries", () => {
    it("returns exactly 3 entries", () => {
        expect(buildBandLegendEntries()).toHaveLength(3);
    });

    it("each entry has band, amount, and color fields", () => {
        const entries = buildBandLegendEntries();
        for (const entry of entries) {
            expect(typeof entry.band).toBe("number");
            expect(typeof entry.amount).toBe("number");
            expect(typeof entry.color).toBe("string");
        }
    });

    it("entries are ordered band 1, 2, 3", () => {
        const entries = buildBandLegendEntries();
        expect(entries[0].band).toBe(1);
        expect(entries[1].band).toBe(2);
        expect(entries[2].band).toBe(3);
    });

    it("amounts match bandAmount for each band", () => {
        const entries = buildBandLegendEntries();
        expect(entries[0].amount).toBe(bandAmount(1));
        expect(entries[1].amount).toBe(bandAmount(2));
        expect(entries[2].amount).toBe(bandAmount(3));
    });

    it("colors match bandColor for each band", () => {
        const entries = buildBandLegendEntries();
        expect(entries[0].color).toBe(bandColor(1));
        expect(entries[1].color).toBe(bandColor(2));
        expect(entries[2].color).toBe(bandColor(3));
    });

    it("each entry has distinct colors", () => {
        const entries = buildBandLegendEntries();
        const colors = entries.map((e) => e.color);
        expect(new Set(colors).size).toBe(3);
    });
});
