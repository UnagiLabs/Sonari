import {
    hexToBytes,
    type PrefixedHex32,
    u8Byte,
    u16LittleEndianBytes,
    u32LittleEndianBytes,
    u64LittleEndianBytes,
} from "./bytes.js";
import { hashLeafBytes } from "./leaf-hash.js";
import { expectPrefixedHex32 } from "./schema.js";

// ---------- enum types ----------

export type CellMetric = (typeof CellMetric)[keyof typeof CellMetric];
export const CellMetric = {
    USGS_MMI: "USGS_MMI",
} as const;

export type IntensityScale = (typeof IntensityScale)[keyof typeof IntensityScale];
export const IntensityScale = {
    MMI_X100: "MMI_X100",
} as const;

export type CellsGenerationMethod =
    (typeof CellsGenerationMethod)[keyof typeof CellsGenerationMethod];
export const CellsGenerationMethod = {
    shakemap_gridxml_h3_grid_point_p90_v1: "shakemap_gridxml_h3_grid_point_p90_v1",
} as const;

// ---------- enum -> integer maps (must match Python verify_golden_vectors.py) ----------

const CELL_METRIC_INT: Record<string, number> = {
    USGS_MMI: 1,
};

const INTENSITY_SCALE_INT: Record<string, number> = {
    MMI_X100: 1,
};

const CELLS_GENERATION_METHOD_INT: Record<string, number> = {
    shakemap_gridxml_h3_grid_point_p90_v1: 1,
};

// ---------- leaf type ----------

export interface AffectedCellLeaf {
    /** 0x-prefixed lowercase 32-byte hex */
    event_uid: PrefixedHex32;
    /** u32 */
    event_revision: number;
    /** u64 */
    h3_index: bigint;
    /** u8 */
    geo_resolution: number;
    cell_metric: CellMetric;
    /** u16 */
    intensity_value: number;
    intensity_scale: IntensityScale;
    /** u8 */
    cell_band: number;
    cells_generation_method: CellsGenerationMethod;
    /** u64 */
    oracle_version: bigint;
}

// ---------- serialization ----------

/**
 * Serialize an AffectedCellLeaf to BCS bytes (canonical 10-field order, 59 bytes).
 *
 * Field order:
 *   1. event_uid         [u8; 32]   raw 32 bytes (no length prefix)
 *   2. event_revision    u32        LE 4 bytes
 *   3. h3_index          u64        LE 8 bytes
 *   4. geo_resolution    u8         1 byte
 *   5. cell_metric       u8         1 byte (enum -> int)
 *   6. intensity_value   u16        LE 2 bytes
 *   7. intensity_scale   u8         1 byte (enum -> int)
 *   8. cell_band         u8         1 byte
 *   9. cells_generation_method u8   1 byte (enum -> int)
 *  10. oracle_version    u64        LE 8 bytes
 *
 * Total: 32+4+8+1+1+2+1+1+1+8 = 59 bytes
 */
export function serializeAffectedCellLeaf(leaf: AffectedCellLeaf): Uint8Array {
    // Validate event_uid
    expectPrefixedHex32("event_uid", leaf.event_uid);

    // Resolve enum -> integer (fail-closed on unknown values)
    const cellMetricInt = CELL_METRIC_INT[leaf.cell_metric];
    if (cellMetricInt === undefined) {
        throw new Error(`Unknown cell_metric: ${leaf.cell_metric}`);
    }
    const intensityScaleInt = INTENSITY_SCALE_INT[leaf.intensity_scale];
    if (intensityScaleInt === undefined) {
        throw new Error(`Unknown intensity_scale: ${leaf.intensity_scale}`);
    }
    const cellsGenerationMethodInt = CELLS_GENERATION_METHOD_INT[leaf.cells_generation_method];
    if (cellsGenerationMethodInt === undefined) {
        throw new Error(`Unknown cells_generation_method: ${leaf.cells_generation_method}`);
    }

    // Encode each field
    const eventUidBytes = hexToBytes(leaf.event_uid); // 32 bytes, raw (no length prefix)
    const eventRevisionBytes = u32LittleEndianBytes(leaf.event_revision); // 4 bytes
    const h3IndexBytes = u64LittleEndianBytes(leaf.h3_index); // 8 bytes
    const geoResolutionBytes = u8Byte(leaf.geo_resolution); // 1 byte
    const cellMetricBytes = u8Byte(cellMetricInt); // 1 byte
    const intensityValueBytes = u16LittleEndianBytes(leaf.intensity_value); // 2 bytes
    const intensityScaleBytes = u8Byte(intensityScaleInt); // 1 byte
    const cellBandBytes = u8Byte(leaf.cell_band); // 1 byte
    const cellsGenerationMethodBytes = u8Byte(cellsGenerationMethodInt); // 1 byte
    const oracleVersionBytes = u64LittleEndianBytes(leaf.oracle_version); // 8 bytes

    // Concatenate in canonical order
    const parts = [
        eventUidBytes,
        eventRevisionBytes,
        h3IndexBytes,
        geoResolutionBytes,
        cellMetricBytes,
        intensityValueBytes,
        intensityScaleBytes,
        cellBandBytes,
        cellsGenerationMethodBytes,
        oracleVersionBytes,
    ];

    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

/**
 * Compute the leaf hash for an AffectedCellLeaf.
 * leaf hash = SHA-256(0x00 || BCS)
 */
export function affectedCellLeafHash(leaf: AffectedCellLeaf): PrefixedHex32 {
    return hashLeafBytes(serializeAffectedCellLeaf(leaf));
}
