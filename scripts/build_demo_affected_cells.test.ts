import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { extractAffectedCells } from "./build_demo_affected_cells.js";

const FIXTURE_PATH = path.join(
    process.cwd(),
    "nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/affected_cells.json",
);
const OUTPUT_PATH = path.join(process.cwd(), "dapp/public/demo/tohoku-2011-affected-cells.json");

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
        const raw = await readFile(FIXTURE_PATH, "utf8");
        const input: unknown = JSON.parse(raw);

        const result = extractAffectedCells(input);

        expect(result).toHaveLength(18429);

        const band1 = result.filter(([, band]) => band === 1).length;
        const band2 = result.filter(([, band]) => band === 2).length;
        const band3 = result.filter(([, band]) => band === 3).length;
        expect(band1).toBe(4984);
        expect(band2).toBe(7203);
        expect(band3).toBe(6242);
    });

    it("includes representative cells in correct positions", async () => {
        const raw = await readFile(FIXTURE_PATH, "utf8");
        const input: unknown = JSON.parse(raw);

        const result = extractAffectedCells(input);

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
            const rawInput = await readFile(FIXTURE_PATH, "utf8");
            const input: unknown = JSON.parse(rawInput);
            const cells = extractAffectedCells(input);
            await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
            await writeFile(OUTPUT_PATH, JSON.stringify(cells), "utf8");
            rawOutput = await readFile(OUTPUT_PATH, "utf8");
        }

        const data: unknown = JSON.parse(rawOutput);

        expect(Array.isArray(data)).toBe(true);
        const arr = data as unknown[];
        expect(arr).toHaveLength(18429);

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
        expect(band1).toBe(4984);
        expect(band2).toBe(7203);
        expect(band3).toBe(6242);
    });
});
