import type { PrefixedHex32 } from "./bytes.js";
import { parseH3Index } from "./h3.js";
import {
    assertMatches,
    expectArray,
    expectKeys,
    expectLiteral,
    expectNonNegativeSafeInteger,
    expectPositiveSafeInteger,
    expectPrefixedHex32,
    expectRecord,
    expectString,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Schema identifiers
// ---------------------------------------------------------------------------

export const RESIDENCE_TILE_SCHEMA = "sonari.residence.tile.v1";
export const RESIDENCE_TILE_MANIFEST_SCHEMA = "sonari.residence.tile_manifest.v1";
export const RESIDENCE_TILE_SCHEMA_VERSION = 1;
export const RESIDENCE_TILE_MANIFEST_SCHEMA_VERSION = 1;

/** Map tiles always group residence (res7) cells by their res4 parent. */
export const RESIDENCE_TILE_PARENT_RESOLUTION = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResidenceTile {
    schema: typeof RESIDENCE_TILE_SCHEMA;
    schema_version: number;
    allowlist_version: number;
    geo_resolution: number;
    tile_parent_resolution: number;
    merkle_root: PrefixedHex32;
    parent_h3_index: string;
    cells: string[];
}

export interface ResidenceTileInventoryEntry {
    parent_h3_index: string;
    object_key: string;
    cell_count: number;
    sha256: PrefixedHex32;
    byte_size: number;
}

export interface ResidenceTileManifest {
    schema: typeof RESIDENCE_TILE_MANIFEST_SCHEMA;
    schema_version: number;
    allowlist_version: number;
    geo_resolution: number;
    tile_parent_resolution: number;
    merkle_root: PrefixedHex32;
    object_key_rule: string;
    tile_count: number;
    total_cell_count: number;
    tiles: ResidenceTileInventoryEntry[];
}

/**
 * Optional expected metadata. When provided, the parser fails closed if the
 * parsed value disagrees. Callers serving from a versioned URL pass the worker
 * configuration so that a stale/mismatched tile is rejected rather than shown.
 */
export interface ResidenceTileExpectation {
    allowlistVersion?: number;
    geoResolution?: number;
    merkleRoot?: string;
}

// ---------------------------------------------------------------------------
// Tile parser
// ---------------------------------------------------------------------------

const TILE_FIELDS = [
    "schema",
    "schema_version",
    "allowlist_version",
    "geo_resolution",
    "tile_parent_resolution",
    "merkle_root",
    "parent_h3_index",
    "cells",
] as const;

export function parseResidenceTile(
    value: unknown,
    expected: ResidenceTileExpectation = {},
): ResidenceTile {
    const record = expectRecord("residence tile", value);
    expectKeys("residence tile", record, TILE_FIELDS);

    expectLiteral("residence tile schema", record.schema, RESIDENCE_TILE_SCHEMA);
    expectLiteral(
        "residence tile schema_version",
        record.schema_version,
        RESIDENCE_TILE_SCHEMA_VERSION,
    );

    const allowlistVersion = expectPositiveSafeInteger(
        "residence tile allowlist_version",
        record.allowlist_version,
    );
    const geoResolution = expectPositiveSafeInteger(
        "residence tile geo_resolution",
        record.geo_resolution,
    );
    expectLiteral(
        "residence tile tile_parent_resolution",
        record.tile_parent_resolution,
        RESIDENCE_TILE_PARENT_RESOLUTION,
    );
    const merkleRoot = expectPrefixedHex32("residence tile merkle_root", record.merkle_root);

    const parentH3Index = expectString("residence tile parent_h3_index", record.parent_h3_index);
    parseH3Index(parentH3Index, RESIDENCE_TILE_PARENT_RESOLUTION);

    const rawCells = expectArray("residence tile cells", record.cells);
    const cells: string[] = [];
    let previous: bigint | null = null;
    for (const [index, rawCell] of rawCells.entries()) {
        const cell = expectString(`residence tile cells[${index}]`, rawCell);
        const parsed = parseH3Index(cell, geoResolution);
        if (previous !== null && parsed.value <= previous) {
            throw new Error(`residence tile cells must be strictly ascending and unique: ${cell}`);
        }
        previous = parsed.value;
        cells.push(cell);
    }

    applyExpectation("residence tile", expected, {
        allowlistVersion,
        geoResolution,
        merkleRoot,
    });

    return {
        schema: RESIDENCE_TILE_SCHEMA,
        schema_version: RESIDENCE_TILE_SCHEMA_VERSION,
        allowlist_version: allowlistVersion,
        geo_resolution: geoResolution,
        tile_parent_resolution: RESIDENCE_TILE_PARENT_RESOLUTION,
        merkle_root: merkleRoot,
        parent_h3_index: parentH3Index,
        cells,
    };
}

// ---------------------------------------------------------------------------
// Manifest parser
// ---------------------------------------------------------------------------

const MANIFEST_FIELDS = [
    "schema",
    "schema_version",
    "allowlist_version",
    "geo_resolution",
    "tile_parent_resolution",
    "merkle_root",
    "object_key_rule",
    "tile_count",
    "total_cell_count",
    "tiles",
] as const;

const INVENTORY_FIELDS = [
    "parent_h3_index",
    "object_key",
    "cell_count",
    "sha256",
    "byte_size",
] as const;

export function parseResidenceTileManifest(
    value: unknown,
    expected: ResidenceTileExpectation = {},
): ResidenceTileManifest {
    const record = expectRecord("residence tile manifest", value);
    expectKeys("residence tile manifest", record, MANIFEST_FIELDS);

    expectLiteral("residence tile manifest schema", record.schema, RESIDENCE_TILE_MANIFEST_SCHEMA);
    expectLiteral(
        "residence tile manifest schema_version",
        record.schema_version,
        RESIDENCE_TILE_MANIFEST_SCHEMA_VERSION,
    );

    const allowlistVersion = expectPositiveSafeInteger(
        "residence tile manifest allowlist_version",
        record.allowlist_version,
    );
    const geoResolution = expectPositiveSafeInteger(
        "residence tile manifest geo_resolution",
        record.geo_resolution,
    );
    expectLiteral(
        "residence tile manifest tile_parent_resolution",
        record.tile_parent_resolution,
        RESIDENCE_TILE_PARENT_RESOLUTION,
    );
    const merkleRoot = expectPrefixedHex32(
        "residence tile manifest merkle_root",
        record.merkle_root,
    );
    const objectKeyRule = expectString(
        "residence tile manifest object_key_rule",
        record.object_key_rule,
    );
    const tileCount = expectNonNegativeSafeInteger(
        "residence tile manifest tile_count",
        record.tile_count,
    );
    const totalCellCount = expectNonNegativeSafeInteger(
        "residence tile manifest total_cell_count",
        record.total_cell_count,
    );

    const rawTiles = expectArray("residence tile manifest tiles", record.tiles);
    const tiles: ResidenceTileInventoryEntry[] = [];
    let cellSum = 0;
    let previousParent: bigint | null = null;
    for (const [index, rawEntry] of rawTiles.entries()) {
        const name = `residence tile manifest tiles[${index}]`;
        const entryRecord = expectRecord(name, rawEntry);
        expectKeys(name, entryRecord, INVENTORY_FIELDS);

        const parentH3Index = expectString(`${name}.parent_h3_index`, entryRecord.parent_h3_index);
        const parsedParent = parseH3Index(parentH3Index, RESIDENCE_TILE_PARENT_RESOLUTION);
        if (previousParent !== null && parsedParent.value <= previousParent) {
            throw new Error(`${name}.parent_h3_index must be strictly ascending and unique`);
        }
        previousParent = parsedParent.value;

        const objectKey = expectString(`${name}.object_key`, entryRecord.object_key);
        const cellCount = expectPositiveSafeInteger(`${name}.cell_count`, entryRecord.cell_count);
        const sha256 = expectPrefixedHex32(`${name}.sha256`, entryRecord.sha256);
        const byteSize = expectPositiveSafeInteger(`${name}.byte_size`, entryRecord.byte_size);

        cellSum += cellCount;
        tiles.push({
            parent_h3_index: parentH3Index,
            object_key: objectKey,
            cell_count: cellCount,
            sha256,
            byte_size: byteSize,
        });
    }

    assertMatches("residence tile manifest tile_count", tileCount, tiles.length);
    assertMatches("residence tile manifest total_cell_count", totalCellCount, cellSum);

    applyExpectation("residence tile manifest", expected, {
        allowlistVersion,
        geoResolution,
        merkleRoot,
    });

    return {
        schema: RESIDENCE_TILE_MANIFEST_SCHEMA,
        schema_version: RESIDENCE_TILE_MANIFEST_SCHEMA_VERSION,
        allowlist_version: allowlistVersion,
        geo_resolution: geoResolution,
        tile_parent_resolution: RESIDENCE_TILE_PARENT_RESOLUTION,
        merkle_root: merkleRoot,
        object_key_rule: objectKeyRule,
        tile_count: tileCount,
        total_cell_count: totalCellCount,
        tiles,
    };
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function applyExpectation(
    name: string,
    expected: ResidenceTileExpectation,
    actual: { allowlistVersion: number; geoResolution: number; merkleRoot: string },
): void {
    if (expected.allowlistVersion !== undefined) {
        assertMatches(
            `${name} allowlist_version`,
            actual.allowlistVersion,
            expected.allowlistVersion,
        );
    }
    if (expected.geoResolution !== undefined) {
        assertMatches(`${name} geo_resolution`, actual.geoResolution, expected.geoResolution);
    }
    if (expected.merkleRoot !== undefined) {
        assertMatches(`${name} merkle_root`, actual.merkleRoot, expected.merkleRoot);
    }
}
