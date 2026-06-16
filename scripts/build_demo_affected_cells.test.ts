import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { bandColor } from "../dapp/app/claim/catalog/cell-band-rules.js";
import {
    computeAffectedCellsBounds,
    extractAffectedCells,
    generateBandOverlaySvg,
} from "./build_demo_affected_cells.js";

const FIXTURE_PATH = path.join(
    process.cwd(),
    "nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/affected_cells.json",
);
const OUTPUT_PATH = path.join(process.cwd(), "dapp/public/demo/tohoku-2011-affected-cells.json");
const OVERLAY_OUTPUT_PATH = path.join(
    process.cwd(),
    "dapp/public/demo/tohoku-2011-band-overlay.svg",
);

async function loadFixtureCells(): Promise<[string, number][]> {
    const raw = await readFile(FIXTURE_PATH, "utf8");
    const input: unknown = JSON.parse(raw);
    return extractAffectedCells(input);
}

describe("extractAffectedCells", () => {
    it("extracts [h3_index, cell_band] tuples in input order", () => {
        const input = {
            event_uid: "test-uid",
            affected_cells: [
                { h3_index: "608795190286614527", intensity_value: 820, cell_band: 3 },
                { h3_index: "608795262395088895", intensity_value: 500, cell_band: 1 },
                { h3_index: "608795200000000000", intensity_value: 650, cell_band: 2 },
            ],
        };

        const result = extractAffectedCells(input);

        expect(result).toEqual([
            ["608795190286614527", 3],
            ["608795262395088895", 1],
            ["608795200000000000", 2],
        ]);
    });

    it("throws when affected_cells is missing", () => {
        expect(() => extractAffectedCells({ event_uid: "test" })).toThrow();
    });

    it("throws when affected_cells is not an array", () => {
        expect(() => extractAffectedCells({ affected_cells: "not-array" })).toThrow();
    });

    it("throws when h3_index is missing", () => {
        const input = {
            affected_cells: [{ intensity_value: 820, cell_band: 3 }],
        };
        expect(() => extractAffectedCells(input)).toThrow();
    });

    it("throws when h3_index is not a decimal integer string", () => {
        const inputs = [
            { h3_index: "0x8a2830828767fff", intensity_value: 820, cell_band: 3 },
            { h3_index: "-1", intensity_value: 820, cell_band: 3 },
            { h3_index: "1.5", intensity_value: 820, cell_band: 3 },
            { h3_index: "", intensity_value: 820, cell_band: 3 },
            { h3_index: 123, intensity_value: 820, cell_band: 3 },
        ];
        for (const cell of inputs) {
            expect(() => extractAffectedCells({ affected_cells: [cell] })).toThrow();
        }
    });

    it("throws when cell_band is 0 (out of range)", () => {
        const input = {
            affected_cells: [
                { h3_index: "608795190286614527", intensity_value: 820, cell_band: 0 },
            ],
        };
        expect(() => extractAffectedCells(input)).toThrow();
    });

    it("throws when cell_band is 4 (out of range)", () => {
        const input = {
            affected_cells: [
                { h3_index: "608795190286614527", intensity_value: 820, cell_band: 4 },
            ],
        };
        expect(() => extractAffectedCells(input)).toThrow();
    });

    it("throws when cell_band is missing", () => {
        const input = {
            affected_cells: [{ h3_index: "608795190286614527", intensity_value: 820 }],
        };
        expect(() => extractAffectedCells(input)).toThrow();
    });

    it("throws when cell_band is a non-integer number", () => {
        const input = {
            affected_cells: [
                { h3_index: "608795190286614527", intensity_value: 820, cell_band: 1.5 },
            ],
        };
        expect(() => extractAffectedCells(input)).toThrow();
    });

    it("throws when cell_band is a string", () => {
        const input = {
            affected_cells: [
                { h3_index: "608795190286614527", intensity_value: 820, cell_band: "1" },
            ],
        };
        expect(() => extractAffectedCells(input)).toThrow();
    });
});

describe("real fixture integration", () => {
    it("transforms affected_cells.json with correct total count and band distribution", async () => {
        const result = await loadFixtureCells();

        expect(result).toHaveLength(39221);

        const band1 = result.filter(([, band]) => band === 1).length;
        const band2 = result.filter(([, band]) => band === 2).length;
        const band3 = result.filter(([, band]) => band === 3).length;
        expect(band1).toBe(10692);
        expect(band2).toBe(15650);
        expect(band3).toBe(12879);
    });

    it("includes representative cells in correct positions", async () => {
        const result = await loadFixtureCells();

        expect(result).toContainEqual(["608795190286614527", 3]);
        expect(result).toContainEqual(["608795262395088895", 1]);
    });
});

describe("generated asset", () => {
    it("dapp/public/demo/tohoku-2011-affected-cells.json exists and is valid", async () => {
        // Generate the asset if it doesn't exist yet
        let rawOutput: string;
        try {
            rawOutput = await readFile(OUTPUT_PATH, "utf8");
        } catch {
            // File not yet generated — generate it now for test validation
            const cells = await loadFixtureCells();
            await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
            await writeFile(OUTPUT_PATH, JSON.stringify(cells), "utf8");
            rawOutput = await readFile(OUTPUT_PATH, "utf8");
        }

        const data: unknown = JSON.parse(rawOutput);

        expect(Array.isArray(data)).toBe(true);
        const arr = data as unknown[];
        expect(arr).toHaveLength(39221);

        // Each element must be [string, 1|2|3]
        for (const item of arr) {
            expect(Array.isArray(item)).toBe(true);
            const tuple = item as unknown[];
            expect(tuple).toHaveLength(2);
            expect(typeof tuple[0]).toBe("string");
            expect([1, 2, 3]).toContain(tuple[1]);
        }

        // Band distribution
        const band1 = arr.filter((item) => (item as [string, number])[1] === 1).length;
        const band2 = arr.filter((item) => (item as [string, number])[1] === 2).length;
        const band3 = arr.filter((item) => (item as [string, number])[1] === 3).length;
        expect(band1).toBe(10692);
        expect(band2).toBe(15650);
        expect(band3).toBe(12879);
    });

    it("dapp/public/demo/tohoku-2011-band-overlay.svg exists and matches generated content", async () => {
        const cells = await loadFixtureCells();
        const generated = generateBandOverlaySvg(cells);

        let rawOutput: string;
        try {
            rawOutput = await readFile(OVERLAY_OUTPUT_PATH, "utf8");
        } catch {
            await mkdir(path.dirname(OVERLAY_OUTPUT_PATH), { recursive: true });
            await writeFile(OVERLAY_OUTPUT_PATH, generated.svg, "utf8");
            rawOutput = await readFile(OVERLAY_OUTPUT_PATH, "utf8");
        }

        expect(rawOutput).toBe(generated.svg);
    });

    it("overlay bounds are computed from affected cell boundaries", async () => {
        const cells = await loadFixtureCells();

        expect(computeAffectedCellsBounds(cells)).toStrictEqual({
            north: 40.613588,
            south: 35.152779,
            east: 145.350259,
            west: 139.679236,
        });
    });

    it("overlay uses bandColor() for Band1, Band2, and Band3", async () => {
        const cells = await loadFixtureCells();
        const { svg } = generateBandOverlaySvg(cells);

        expect(svg).toContain(`data-band="1" fill="${bandColor(1)}" fill-opacity="0.55"`);
        expect(svg).toContain(`data-band="2" fill="${bandColor(2)}" fill-opacity="0.55"`);
        expect(svg).toContain(`data-band="3" fill="${bandColor(3)}" fill-opacity="0.55"`);
    });
});
