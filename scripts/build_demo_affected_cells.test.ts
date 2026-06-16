import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAffectedCellTile } from "../dapp/app/claim/affected-area/affected-area-tiles.js";
import { bandColor } from "../dapp/app/claim/catalog/cell-band-rules.js";
import {
    computeAffectedCellsBounds,
    extractAffectedCells,
    generateAffectedAreaArtifacts,
    tileOutputRelativePath,
} from "./build_demo_affected_cells.js";

const FIXTURE_PATH = path.join(
    process.cwd(),
    "nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/affected_cells.json",
);
const OUTPUT_DIR = path.join(process.cwd(), "dapp/public/demo/tohoku-2011");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "affected-cells.json");
const MANIFEST_OUTPUT_PATH = path.join(OUTPUT_DIR, "affected-area-manifest.json");

async function loadFixtureCells(): Promise<[string, number][]> {
    const raw = await readFile(FIXTURE_PATH, "utf8");
    const input: unknown = JSON.parse(raw);
    return extractAffectedCells(input);
}

async function ensureGeneratedOutput() {
    const cells = await loadFixtureCells();
    const artifacts = generateAffectedAreaArtifacts(cells);
    try {
        await readFile(OUTPUT_PATH, "utf8");
        await readFile(MANIFEST_OUTPUT_PATH, "utf8");
    } catch {
        await mkdir(OUTPUT_DIR, { recursive: true });
        await writeFile(OUTPUT_PATH, artifacts.affectedCellsJson, "utf8");
        await writeFile(MANIFEST_OUTPUT_PATH, JSON.stringify(artifacts.manifest), "utf8");
    }
    return artifacts;
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

    it("throws when cell_band is invalid", () => {
        const inputs = [
            { h3_index: "608795190286614527", intensity_value: 820, cell_band: 0 },
            { h3_index: "608795190286614527", intensity_value: 820, cell_band: 4 },
            { h3_index: "608795190286614527", intensity_value: 820 },
            { h3_index: "608795190286614527", intensity_value: 820, cell_band: 1.5 },
            { h3_index: "608795190286614527", intensity_value: 820, cell_band: "1" },
        ];
        for (const cell of inputs) {
            expect(() => extractAffectedCells({ affected_cells: [cell] })).toThrow();
        }
    });
});

describe("real fixture integration", () => {
    it("transforms affected_cells.json with correct total count and band distribution", async () => {
        const result = await loadFixtureCells();

        expect(result).toHaveLength(39221);
        expect(result.filter(([, band]) => band === 1)).toHaveLength(10692);
        expect(result.filter(([, band]) => band === 2)).toHaveLength(15650);
        expect(result.filter(([, band]) => band === 3)).toHaveLength(12879);
    });

    it("includes representative cells in correct positions", async () => {
        const result = await loadFixtureCells();

        expect(result).toContainEqual(["608795190286614527", 3]);
        expect(result).toContainEqual(["608795262395088895", 1]);
    });
});

describe("generateAffectedAreaArtifacts", () => {
    it("maps tile keys to extension-bearing public file paths", () => {
        expect(tileOutputRelativePath("raster", "6/56/24")).toStrictEqual([
            "raster",
            "6",
            "56",
            "24.svg",
        ]);
        expect(tileOutputRelativePath("cells", "11/1818/801")).toStrictEqual([
            "cells",
            "11",
            "1818",
            "801.json",
        ]);
    });

    it("generates deterministic canonical JSON and manifest", async () => {
        const cells = await loadFixtureCells();

        const first = generateAffectedAreaArtifacts(cells);
        const second = generateAffectedAreaArtifacts(cells);

        expect(first.affectedCellsJson).toBe(second.affectedCellsJson);
        expect(first.manifest).toStrictEqual(second.manifest);
        expect(first.rasterTiles).toStrictEqual(second.rasterTiles);
        expect(first.cellTiles).toStrictEqual(second.cellTiles);
    });

    it("manifest count, sourceSha256, bounds, and tile keys match generated artifacts", async () => {
        const cells = await loadFixtureCells();
        const artifacts = generateAffectedAreaArtifacts(cells);
        const expectedSha256 = createHash("sha256")
            .update(artifacts.affectedCellsJson)
            .digest("hex");

        expect(artifacts.manifest.cellCount).toBe(cells.length);
        expect(artifacts.manifest.sourceSha256).toBe(expectedSha256);
        expect(artifacts.manifest.bounds).toStrictEqual(computeAffectedCellsBounds(cells));
        expect(artifacts.manifest.rasterTileKeys).toHaveLength(artifacts.rasterTiles.size);
        expect(artifacts.manifest.cellTileKeys).toHaveLength(artifacts.cellTiles.size);
        expect(artifacts.manifest.rasterTileKeys.length).toBeGreaterThan(0);
        expect(artifacts.manifest.cellTileKeys.length).toBeGreaterThan(0);
    });

    it("raster SVG tiles use bandColor() and polygon fill opacity", async () => {
        const cells = await loadFixtureCells();
        const artifacts = generateAffectedAreaArtifacts(cells);
        const combinedSvg = [...artifacts.rasterTiles.values()].join("");

        expect(combinedSvg).toContain(`data-band="1" fill="${bandColor(1)}" fill-opacity="0.35"`);
        expect(combinedSvg).toContain(`data-band="2" fill="${bandColor(2)}" fill-opacity="0.35"`);
        expect(combinedSvg).toContain(`data-band="3" fill="${bandColor(3)}" fill-opacity="0.35"`);
    });

    it("cell tile feature union equals canonical affected cells and preserves bands", async () => {
        const cells = await loadFixtureCells();
        const canonicalBands = new Map(cells.map(([decimal, band]) => [decimal, band]));
        const artifacts = generateAffectedAreaArtifacts(cells);
        const union = new Set<string>();
        let duplicatedFeatureCount = 0;

        for (const rawTile of artifacts.cellTiles.values()) {
            const tile = parseAffectedCellTile(JSON.parse(rawTile));
            expect(tile).not.toBeNull();
            if (tile === null) {
                continue;
            }
            for (const feature of tile.features) {
                if (union.has(feature.decimal)) {
                    duplicatedFeatureCount += 1;
                }
                union.add(feature.decimal);
                expect(feature.band).toBe(canonicalBands.get(feature.decimal));
            }
        }

        expect(union).toStrictEqual(new Set(cells.map(([decimal]) => decimal)));
        expect(duplicatedFeatureCount).toBeGreaterThan(0);
    });
});

describe("generated asset", () => {
    it("dapp/public/demo/tohoku-2011/affected-cells.json exists and is deterministic", async () => {
        const artifacts = await ensureGeneratedOutput();
        const rawOutput = await readFile(OUTPUT_PATH, "utf8");

        expect(rawOutput).toBe(artifacts.affectedCellsJson);
        expect(JSON.parse(rawOutput)).toHaveLength(39221);
    });

    it("dapp/public/demo/tohoku-2011/affected-area-manifest.json matches generated manifest", async () => {
        const artifacts = await ensureGeneratedOutput();
        const rawOutput = await readFile(MANIFEST_OUTPUT_PATH, "utf8");

        expect(JSON.parse(rawOutput)).toStrictEqual(artifacts.manifest);
    });
});
