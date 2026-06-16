import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "@sonari/proof-core";
import { describe, expect, it } from "vitest";
import {
    generateAffectedAreaArtifacts,
    normalizeAffectedAreaBaseUrl,
    tileOutputRelativePath,
} from "./affected_area_artifacts.js";

const BASE_URL = "https://affected-area-assets.sonari.help/";

const EVENT_UID = "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";
const AFFECTED_CELLS_ROOT =
    "0x44e8c444631ebc5b7183787cf42f42b15dd45c3107cb1daf261c1b58a7e999d5";
const ANTI_MERIDIAN_EVENT_UID =
    "0xcd131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";
const ANTI_MERIDIAN_ROOT =
    "0xc6db0f890d7f3cff0172e1ccd623c6febd302845cfad3bf8ffe44d9e3d2d7cfe";
const ANTI_MERIDIAN_CLUSTER_ROOT =
    "0xbe843717b8b7a6d37f5abf715fa3e8d24507d6d8843eb861aa9c98ddabc41931";

function smallAffectedCellsJson(): string {
    return JSON.stringify({
        event_uid: EVENT_UID,
        event_revision: 1,
        oracle_version: 1,
        geo_resolution: 7,
        cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
        cell_metric: "USGS_MMI",
        cell_aggregation: "GRID_POINT_P90",
        intensity_scale: "MMI_X100",
        affected_cells: [
            { h3_index: "608819013547458559", intensity_value: 831, cell_band: 3 },
            { h3_index: "608819013614567423", intensity_value: 723, cell_band: 1 },
        ],
    });
}

function antiMeridianAffectedCellsJson(): string {
    return JSON.stringify({
        event_uid: ANTI_MERIDIAN_EVENT_UID,
        event_revision: 1,
        oracle_version: 1,
        geo_resolution: 7,
        cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
        cell_metric: "USGS_MMI",
        cell_aggregation: "GRID_POINT_P90",
        intensity_scale: "MMI_X100",
        affected_cells: [
            { h3_index: "612270033996873727", intensity_value: 831, cell_band: 3 },
        ],
    });
}

function antiMeridianClusterAffectedCellsJson(): string {
    return JSON.stringify({
        event_uid: ANTI_MERIDIAN_EVENT_UID,
        event_revision: 1,
        oracle_version: 1,
        geo_resolution: 7,
        cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
        cell_metric: "USGS_MMI",
        cell_aggregation: "GRID_POINT_P90",
        intensity_scale: "MMI_X100",
        affected_cells: [
            { h3_index: "612270033996873727", intensity_value: 831, cell_band: 3 },
            { h3_index: "612270034013650943", intensity_value: 831, cell_band: 3 },
        ],
    });
}

async function loadTohokuFixtureBytes(): Promise<Uint8Array> {
    return readFile(
        path.join(
            process.cwd(),
            "../..",
            "nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/affected_cells.json",
        ),
    );
}

describe("normalizeAffectedAreaBaseUrl", () => {
    it("removes trailing slashes and rejects empty values", () => {
        expect(normalizeAffectedAreaBaseUrl("https://assets.example.com///")).toBe(
            "https://assets.example.com",
        );
        expect(normalizeAffectedAreaBaseUrl("   ")).toBeNull();
    });
});

describe("tileOutputRelativePath", () => {
    it("maps tile keys to extension-bearing relative paths", () => {
        expect(tileOutputRelativePath("raster", "6/56/24")).toStrictEqual([
            "raster",
            "6",
            "56",
            "24.svg",
        ]);
        expect(tileOutputRelativePath("cells", "11/1832/808")).toStrictEqual([
            "cells",
            "11",
            "1832",
            "808.json",
        ]);
    });
});

describe("generateAffectedAreaArtifacts", () => {
    it("generates deterministic canonical JSON, manifest, raster tiles, and cell tiles", () => {
        const bytes = new TextEncoder().encode(smallAffectedCellsJson());

        const first = generateAffectedAreaArtifacts({
            bytes,
            affectedCellsRoot: AFFECTED_CELLS_ROOT,
            baseUrl: BASE_URL,
        });
        const second = generateAffectedAreaArtifacts({
            bytes,
            affectedCellsRoot: AFFECTED_CELLS_ROOT,
            baseUrl: BASE_URL,
        });

        expect(first.affectedCellsJson).toBe(second.affectedCellsJson);
        expect(first.manifest).toStrictEqual(second.manifest);
        expect(first.rasterTiles).toStrictEqual(second.rasterTiles);
        expect(first.cellTiles).toStrictEqual(second.cellTiles);
        expect(first.affectedCellsJson.endsWith("\n")).toBe(false);
    });

    it("uses canonical JSON bytes for sourceSha256 and manifest counts", () => {
        const artifacts = generateAffectedAreaArtifacts({
            bytes: new TextEncoder().encode(smallAffectedCellsJson()),
            affectedCellsRoot: AFFECTED_CELLS_ROOT,
            baseUrl: BASE_URL,
        });
        const expectedSourceSha256 = sha256Hex(
            new TextEncoder().encode(artifacts.affectedCellsJson),
        ).slice(2);

        expect(artifacts.manifest.sourceSha256).toBe(expectedSourceSha256);
        expect(artifacts.manifest.cellCount).toBe(2);
        expect(artifacts.manifest.affectedCellsRoot).toBe(AFFECTED_CELLS_ROOT);
        expect(artifacts.manifest.rasterTileUrlTemplate).toBe(
            `${BASE_URL.replace(/\/+$/u, "")}/affected-area/events/${EVENT_UID}/revisions/1/raster/{z}/{x}/{y}.svg`,
        );
        expect(artifacts.manifest.cellTileUrlTemplate).toBe(
            `${BASE_URL.replace(/\/+$/u, "")}/affected-area/events/${EVENT_UID}/revisions/1/cells/{z}/{x}/{y}.json`,
        );
    });

    it("rejects an affected_cells_root mismatch before returning artifacts", () => {
        expect(() =>
            generateAffectedAreaArtifacts({
                bytes: new TextEncoder().encode(smallAffectedCellsJson()),
                affectedCellsRoot: `0x${"00".repeat(32)}`,
                baseUrl: BASE_URL,
            }),
        ).toThrow(/affected_cells_root mismatch/u);
    });

    it("does not expand anti-meridian cells into near-global tile ranges", () => {
        const artifacts = generateAffectedAreaArtifacts({
            bytes: new TextEncoder().encode(antiMeridianAffectedCellsJson()),
            affectedCellsRoot: ANTI_MERIDIAN_ROOT,
            baseUrl: BASE_URL,
        });

        expect(artifacts.manifest.rasterTileKeys.length).toBeLessThan(50);
        expect(artifacts.manifest.cellTileKeys.length).toBeLessThan(20);
        expect(artifacts.manifest.bounds.east).toBeGreaterThanOrEqual(artifacts.manifest.bounds.west);
        expect(artifacts.manifest.bounds.east - artifacts.manifest.bounds.west).toBeLessThan(1);
    });

    it("keeps anti-meridian cluster manifest bounds local", () => {
        const artifacts = generateAffectedAreaArtifacts({
            bytes: new TextEncoder().encode(antiMeridianClusterAffectedCellsJson()),
            affectedCellsRoot: ANTI_MERIDIAN_CLUSTER_ROOT,
            baseUrl: BASE_URL,
        });

        expect(artifacts.manifest.bounds.east).toBeGreaterThanOrEqual(artifacts.manifest.bounds.west);
        expect(artifacts.manifest.bounds.east - artifacts.manifest.bounds.west).toBeLessThan(1);
    });

    it("rejects malformed canonical source data", () => {
        const bad = JSON.parse(smallAffectedCellsJson()) as {
            affected_cells: Array<{ h3_index: string; intensity_value: number; cell_band: number }>;
        };
        bad.affected_cells = [bad.affected_cells[1]!, bad.affected_cells[0]!];

        expect(() =>
            generateAffectedAreaArtifacts({
                bytes: new TextEncoder().encode(JSON.stringify(bad)),
                affectedCellsRoot: AFFECTED_CELLS_ROOT,
                baseUrl: BASE_URL,
            }),
        ).toThrow(/affected_cells file is invalid/u);
    });

    it("full fixture produces stable tile counts and feature union", async () => {
        const artifacts = generateAffectedAreaArtifacts({
            bytes: await loadTohokuFixtureBytes(),
            affectedCellsRoot:
                "0x51cd4a4ddc99acbad52b6e5b0003827f9a5b27501f3fc902c8e025a1a92a59ee",
            baseUrl: BASE_URL,
        });
        const canonical = JSON.parse(artifacts.affectedCellsJson) as {
            affected_cells: Array<{ h3_index: string; cell_band: number }>;
        };
        const canonicalBands = new Map(
            canonical.affected_cells.map((cell) => [cell.h3_index, cell.cell_band]),
        );
        const union = new Set<string>();

        for (const rawTile of artifacts.cellTiles.values()) {
            const parsed = JSON.parse(rawTile) as {
                features: Array<{ decimal: string; band: number }>;
            };
            for (const feature of parsed.features) {
                union.add(feature.decimal);
                expect(canonicalBands.get(feature.decimal)).toBe(feature.band);
            }
        }

        expect(canonical.affected_cells).toHaveLength(39221);
        expect(artifacts.rasterTiles.size).toBe(364);
        expect(artifacts.cellTiles.size).toBe(927);
        expect(union).toStrictEqual(
            new Set(canonical.affected_cells.map((cell) => cell.h3_index)),
        );
    }, 20_000);
});
