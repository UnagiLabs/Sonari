import { describe, expect, it } from "vitest";
import {
    parseResidenceTile,
    parseResidenceTileManifest,
    RESIDENCE_TILE_MANIFEST_SCHEMA,
    RESIDENCE_TILE_PARENT_RESOLUTION,
    RESIDENCE_TILE_SCHEMA,
} from "./residence-tiles.js";

// res4 parent 842f5abffffffff (decimal 595308219849506815) holds these res7 cells.
const PARENT_H3_INDEX = "595308219849506815";
const CELL_A = "608819013513904127";
const CELL_B = "608819013597790207";
const CELL_C = "608819013681676287";
const MERKLE_ROOT = `0x${"ab".repeat(32)}`;

function validTile(): Record<string, unknown> {
    return {
        schema: RESIDENCE_TILE_SCHEMA,
        schema_version: 1,
        allowlist_version: 1,
        geo_resolution: 7,
        tile_parent_resolution: RESIDENCE_TILE_PARENT_RESOLUTION,
        merkle_root: MERKLE_ROOT,
        parent_h3_index: PARENT_H3_INDEX,
        cells: [CELL_A, CELL_B, CELL_C],
    };
}

function validManifest(): Record<string, unknown> {
    return {
        schema: RESIDENCE_TILE_MANIFEST_SCHEMA,
        schema_version: 1,
        allowlist_version: 1,
        geo_resolution: 7,
        tile_parent_resolution: RESIDENCE_TILE_PARENT_RESOLUTION,
        merkle_root: MERKLE_ROOT,
        object_key_rule:
            "residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/res4/{parent_hex}.json",
        tile_count: 1,
        total_cell_count: 3,
        tiles: [
            {
                parent_h3_index: PARENT_H3_INDEX,
                object_key: "residence-cells/v1/res7/tiles/res4/8427fffffffffff.json",
                cell_count: 3,
                sha256: `0x${"cd".repeat(32)}`,
                byte_size: 256,
            },
        ],
    };
}

describe("parseResidenceTile", () => {
    it("parses a well-formed tile", () => {
        const tile = parseResidenceTile(validTile());
        expect(tile.parent_h3_index).toBe(PARENT_H3_INDEX);
        expect(tile.cells).toEqual([CELL_A, CELL_B, CELL_C]);
        expect(tile.allowlist_version).toBe(1);
        expect(tile.geo_resolution).toBe(7);
    });

    it("returns a normalized cell set helper", () => {
        const tile = parseResidenceTile(validTile());
        expect(tile.cells.includes(CELL_B)).toBe(true);
    });

    it("rejects a wrong schema", () => {
        expect(() => parseResidenceTile({ ...validTile(), schema: "wrong" })).toThrow();
    });

    it("rejects a wrong schema_version", () => {
        expect(() => parseResidenceTile({ ...validTile(), schema_version: 2 })).toThrow();
    });

    it("rejects a wrong tile_parent_resolution", () => {
        expect(() => parseResidenceTile({ ...validTile(), tile_parent_resolution: 5 })).toThrow();
    });

    it("rejects a malformed merkle_root", () => {
        expect(() => parseResidenceTile({ ...validTile(), merkle_root: "0xabc" })).toThrow();
    });

    it("rejects unexpected fields", () => {
        expect(() => parseResidenceTile({ ...validTile(), extra: true })).toThrow();
    });

    it("rejects non-ascending cells", () => {
        expect(() => parseResidenceTile({ ...validTile(), cells: [CELL_B, CELL_A] })).toThrow();
    });

    it("rejects duplicate cells", () => {
        expect(() => parseResidenceTile({ ...validTile(), cells: [CELL_A, CELL_A] })).toThrow();
    });

    it("rejects a cell that is not a res7 index", () => {
        expect(() => parseResidenceTile({ ...validTile(), cells: [PARENT_H3_INDEX] })).toThrow();
    });

    it("rejects a parent that is not a res4 index", () => {
        expect(() => parseResidenceTile({ ...validTile(), parent_h3_index: CELL_A })).toThrow();
    });

    it("enforces expected version when provided", () => {
        expect(() => parseResidenceTile(validTile(), { allowlistVersion: 2 })).toThrow();
    });

    it("enforces expected geo_resolution when provided", () => {
        expect(() => parseResidenceTile(validTile(), { geoResolution: 9 })).toThrow();
    });

    it("enforces expected merkle_root when provided", () => {
        expect(() =>
            parseResidenceTile(validTile(), { merkleRoot: `0x${"00".repeat(32)}` }),
        ).toThrow();
    });

    it("accepts matching expected metadata", () => {
        const tile = parseResidenceTile(validTile(), {
            allowlistVersion: 1,
            geoResolution: 7,
            merkleRoot: MERKLE_ROOT,
        });
        expect(tile.cells.length).toBe(3);
    });
});

describe("parseResidenceTileManifest", () => {
    it("parses a well-formed manifest", () => {
        const manifest = parseResidenceTileManifest(validManifest());
        expect(manifest.tile_count).toBe(1);
        expect(manifest.total_cell_count).toBe(3);
        expect(manifest.tiles).toHaveLength(1);
        expect(manifest.tiles[0]?.parent_h3_index).toBe(PARENT_H3_INDEX);
    });

    it("rejects a wrong schema", () => {
        expect(() => parseResidenceTileManifest({ ...validManifest(), schema: "wrong" })).toThrow();
    });

    it("rejects when tile_count disagrees with the inventory length", () => {
        expect(() => parseResidenceTileManifest({ ...validManifest(), tile_count: 2 })).toThrow();
    });

    it("rejects when total_cell_count disagrees with the inventory sum", () => {
        expect(() =>
            parseResidenceTileManifest({ ...validManifest(), total_cell_count: 4 }),
        ).toThrow();
    });

    it("rejects a malformed inventory sha256", () => {
        const manifest = validManifest();
        const [firstEntry] = manifest.tiles as Record<string, unknown>[];
        if (firstEntry === undefined) {
            throw new Error("fixture must contain at least one tile");
        }
        firstEntry.sha256 = "0xabc";
        expect(() => parseResidenceTileManifest(manifest)).toThrow();
    });

    it("rejects unexpected fields", () => {
        expect(() => parseResidenceTileManifest({ ...validManifest(), extra: true })).toThrow();
    });

    it("enforces expected metadata when provided", () => {
        expect(() =>
            parseResidenceTileManifest(validManifest(), { allowlistVersion: 2 }),
        ).toThrow();
    });
});
