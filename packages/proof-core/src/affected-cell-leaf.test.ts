import { describe, expect, it } from "vitest";
import {
    type AffectedCellLeaf,
    affectedCellLeafHash,
    CellMetric,
    CellsGenerationMethod,
    IntensityScale,
    serializeAffectedCellLeaf,
} from "./affected-cell-leaf.js";

// Golden test data from schemas/examples/affected_cells.json
const COMMON_FIELDS = {
    event_uid: "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd" as const,
    event_revision: 1,
    geo_resolution: 7,
    cell_metric: CellMetric.USGS_MMI,
    intensity_scale: IntensityScale.MMI_X100,
    cells_generation_method: CellsGenerationMethod.shakemap_gridxml_h3_grid_point_p90_v1,
    oracle_version: 1n,
} as const;

const CELL_1: AffectedCellLeaf = {
    ...COMMON_FIELDS,
    h3_index: 608819013513904127n,
    intensity_value: 831,
    cell_band: 3,
};

const CELL_2: AffectedCellLeaf = {
    ...COMMON_FIELDS,
    h3_index: 608819013597790207n,
    intensity_value: 723,
    cell_band: 1,
};

describe("serializeAffectedCellLeaf", () => {
    it("produces exactly 59 bytes for cell 1", () => {
        const bytes = serializeAffectedCellLeaf(CELL_1);
        expect(bytes.length).toBe(59);
    });

    it("produces exactly 59 bytes for cell 2", () => {
        const bytes = serializeAffectedCellLeaf(CELL_2);
        expect(bytes.length).toBe(59);
    });

    it("encodes event_uid as raw 32 bytes (no length prefix)", () => {
        const bytes = serializeAffectedCellLeaf(CELL_1);
        // First 32 bytes = event_uid raw bytes
        // If length prefix were accidentally added, total would be > 59 bytes
        // Also check first bytes directly match hex_bytes("0xab131dd4...")
        expect(bytes[0]).toBe(0xab);
        expect(bytes[1]).toBe(0x13);
        expect(bytes[2]).toBe(0x1d);
        expect(bytes[3]).toBe(0xd4);
    });

    it("encodes event_revision as u32 LE after event_uid (bytes 32-35)", () => {
        const bytes = serializeAffectedCellLeaf(CELL_1);
        // event_revision=1 as u32 LE = [01, 00, 00, 00]
        expect(bytes[32]).toBe(0x01);
        expect(bytes[33]).toBe(0x00);
        expect(bytes[34]).toBe(0x00);
        expect(bytes[35]).toBe(0x00);
    });

    it("encodes intensity_value as u16 LE", () => {
        // CELL_1: intensity_value=831 = 0x033f => LE = [0x3f, 0x03]
        const bytes = serializeAffectedCellLeaf(CELL_1);
        // offset: 32(event_uid) + 4(event_revision) + 8(h3_index) + 1(geo_resolution) + 1(cell_metric) = 46
        expect(bytes[46]).toBe(0x3f);
        expect(bytes[47]).toBe(0x03);
    });

    it("encodes cell_band as u8", () => {
        // offset: 32+4+8+1+1+2+1 = 49
        const bytes1 = serializeAffectedCellLeaf(CELL_1);
        expect(bytes1[49]).toBe(3);
        const bytes2 = serializeAffectedCellLeaf(CELL_2);
        expect(bytes2[49]).toBe(1);
    });

    it("pins cells_generation_method numeric values", () => {
        const oldBytes = serializeAffectedCellLeaf(CELL_1);
        const weightedBytes = serializeAffectedCellLeaf({
            ...CELL_1,
            cells_generation_method: CellsGenerationMethod.shakemap_hdf_h3_area_weighted_p90_v1,
        });
        const bilinearBytes = serializeAffectedCellLeaf({
            ...CELL_1,
            cells_generation_method: CellsGenerationMethod.shakemap_gridxml_h3_center_bilinear_v1,
        });

        expect(oldBytes[50]).toBe(1);
        expect(weightedBytes[50]).toBe(2);
        expect(bilinearBytes[50]).toBe(3);
    });

    it("two distinct cells produce different byte sequences", () => {
        const bytes1 = serializeAffectedCellLeaf(CELL_1);
        const bytes2 = serializeAffectedCellLeaf(CELL_2);
        expect(bytes1).not.toEqual(bytes2);
    });
});

describe("affectedCellLeafHash", () => {
    it("matches golden hash for cell 1", () => {
        const hash = affectedCellLeafHash(CELL_1);
        expect(hash).toBe("0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f");
    });

    it("matches golden hash for cell 2", () => {
        const hash = affectedCellLeafHash(CELL_2);
        expect(hash).toBe("0xbc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f");
    });
});

describe("fail-closed validation", () => {
    it("throws for unknown cell_metric string", () => {
        const invalidLeaf = {
            ...CELL_1,
            cell_metric: "INVALID_METRIC",
        } as unknown as AffectedCellLeaf;
        expect(() => serializeAffectedCellLeaf(invalidLeaf)).toThrow();
    });

    it("throws for unknown cells_generation_method string", () => {
        const invalidLeaf = {
            ...CELL_1,
            cells_generation_method: "UNKNOWN_METHOD",
        } as unknown as AffectedCellLeaf;
        expect(() => serializeAffectedCellLeaf(invalidLeaf)).toThrow();
    });

    it("throws for unknown intensity_scale string", () => {
        const invalidLeaf = {
            ...CELL_1,
            intensity_scale: "INVALID_SCALE",
        } as unknown as AffectedCellLeaf;
        expect(() => serializeAffectedCellLeaf(invalidLeaf)).toThrow();
    });

    it("throws for event_revision outside u32 range", () => {
        expect(() =>
            serializeAffectedCellLeaf({
                ...CELL_1,
                event_revision: 4294967296, // 2^32, out of range
            }),
        ).toThrow();
    });

    it("throws for negative event_revision", () => {
        expect(() =>
            serializeAffectedCellLeaf({
                ...CELL_1,
                event_revision: -1,
            }),
        ).toThrow();
    });

    it("throws for invalid event_uid (too short hex)", () => {
        const invalidLeaf = { ...CELL_1, event_uid: "0xdeadbeef" } as unknown as AffectedCellLeaf;
        expect(() => serializeAffectedCellLeaf(invalidLeaf)).toThrow();
    });
});

describe("bytes.ts u8/u16/u32 encoders", () => {
    // These are tested indirectly through leaf serialization,
    // but also test them directly via re-exported functions
    it("u16LittleEndianBytes(0x0102) => [0x02, 0x01]", async () => {
        const { u16LittleEndianBytes } = await import("./bytes.js");
        expect(Array.from(u16LittleEndianBytes(0x0102))).toEqual([0x02, 0x01]);
    });

    it("u16LittleEndianBytes throws for value > 65535", async () => {
        const { u16LittleEndianBytes } = await import("./bytes.js");
        expect(() => u16LittleEndianBytes(65536)).toThrow();
    });

    it("u16LittleEndianBytes throws for negative value", async () => {
        const { u16LittleEndianBytes } = await import("./bytes.js");
        expect(() => u16LittleEndianBytes(-1)).toThrow();
    });

    it("u32LittleEndianBytes(0x01020304) => [0x04, 0x03, 0x02, 0x01]", async () => {
        const { u32LittleEndianBytes } = await import("./bytes.js");
        expect(Array.from(u32LittleEndianBytes(0x01020304))).toEqual([0x04, 0x03, 0x02, 0x01]);
    });

    it("u32LittleEndianBytes throws for value > 4294967295", async () => {
        const { u32LittleEndianBytes } = await import("./bytes.js");
        expect(() => u32LittleEndianBytes(4294967296)).toThrow();
    });

    it("u8Byte(255) => [255]", async () => {
        const { u8Byte } = await import("./bytes.js");
        expect(Array.from(u8Byte(255))).toEqual([255]);
    });

    it("u8Byte throws for value > 255", async () => {
        const { u8Byte } = await import("./bytes.js");
        expect(() => u8Byte(256)).toThrow();
    });

    it("u8Byte throws for negative value", async () => {
        const { u8Byte } = await import("./bytes.js");
        expect(() => u8Byte(-1)).toThrow();
    });
});
