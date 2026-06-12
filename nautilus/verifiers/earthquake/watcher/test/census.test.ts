import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
    computeFloorCensusCounts,
    encodeFloorCensusResultBcs,
    signFloorCensusResult,
    type HomeCellRegisteredEvent,
} from "../src/census.js";
import type { RelayerSigner } from "@sonari/earthquake-relayer";

const eventUid = `0x${"aa".repeat(32)}`;
const affectedCellsRoot = `0x${"bb".repeat(32)}`;

const affectedCells = {
    event_uid: eventUid,
    event_revision: 7,
    oracle_version: 1,
    geo_resolution: 7,
    cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
    cell_metric: "USGS_MMI",
    cell_aggregation: "GRID_POINT_P90",
    intensity_scale: "MMI_X100",
    affected_cells: [
        { h3_index: "10", intensity_value: 500, cell_band: 1 },
        { h3_index: "20", intensity_value: 600, cell_band: 2 },
        { h3_index: "30", intensity_value: 700, cell_band: 3 },
    ],
};

describe("floor census core", () => {
    it("uses the last pre-cutoff home cell, filters active lineages, and counts by band", () => {
        const expectedAffectedCellsRoot = expectedRoot();
        const events: HomeCellRegisteredEvent[] = [
            { lineage: "0xlineage1", homeCell: "10", registeredAtMs: 900 },
            { lineage: "0xlineage1", homeCell: "20", registeredAtMs: 999 },
            { lineage: "0xlineage1", homeCell: "30", registeredAtMs: 1_000 },
            { lineage: "0xlineage2", homeCell: "30", registeredAtMs: 800 },
            { lineage: "0xlineage3", homeCell: "20", registeredAtMs: 700 },
            { lineage: "0xlineage4", homeCell: "40", registeredAtMs: 700 },
        ];

        expect(
            computeFloorCensusCounts({
                affectedCells,
                homeCellEvents: events,
                activeLineages: new Set(["0xlineage1", "0xlineage2", "0xlineage4"]),
                cutoffMs: 1_000,
                expectedAffectedCellsRoot,
                eventUid,
                eventRevision: 7,
            }),
        ).toEqual([0n, 1n, 1n]);
    });

    it("fails closed when affected cell leaves do not match the signed root", () => {
        expect(() =>
            computeFloorCensusCounts({
                affectedCells,
                homeCellEvents: [],
                activeLineages: new Set(),
                cutoffMs: 1_000,
                expectedAffectedCellsRoot: affectedCellsRoot,
                eventUid,
                eventRevision: 7,
            }),
        ).toThrow(/Merkle root/);
    });

    it("encodes census_result BCS in schema order without vector prefixes for bytes32 fields", () => {
        const encoded = encodeFloorCensusResultBcs({
            eventUid,
            eventRevision: 7,
            affectedCellsRoot,
            registeredMembersByBand: [1n, 2n, 3n],
            issuedAtMs: 1_234,
        });

        expect(Buffer.from(encoded).toString("hex")).toBe(
            [
                "16534f4e4152495f464c4f4f525f43454e5355535f5631",
                "0663656e737573",
                "0100000000000000",
                "aa".repeat(32),
                "07000000",
                "bb".repeat(32),
                "03",
                "0100000000000000",
                "0200000000000000",
                "0300000000000000",
                "d204000000000000",
            ].join(""),
        );
    });

    it("signs raw census BCS bytes with the relayer key interface", async () => {
        const recorder = new RecordingSigner();
        const signed = await signFloorCensusResult(recorder.asSigner(), {
            eventUid,
            eventRevision: 7,
            affectedCellsRoot,
            registeredMembersByBand: [1n, 2n, 3n],
            issuedAtMs: 1_234,
        });

        expect(recorder.signedBytes).toEqual(signed.censusBcs);
        expect(signed.signature).toHaveLength(64);
        expect(signed.publicKey).toHaveLength(32);
        expect(signed.signatureHex).toBe(`0x${"11".repeat(64)}`);
        expect(signed.publicKeyHex).toBe(`0x${"22".repeat(32)}`);
    });
});

function expectedRoot(): string {
    const root = computeAffectedCellsRootForTest(affectedCells);
    if (root === null) {
        throw new Error("fixture should produce root");
    }
    return root;
}

function computeAffectedCellsRootForTest(input: typeof affectedCells): string | null {
    // Keep this fixture root independent from computeFloorCensusCounts; the production
    // implementation uses @sonari/earthquake-shared.
    const hashes = input.affected_cells.map((cell) => {
        const bytes = [
            Uint8Array.of(0),
            Buffer.from(input.event_uid.slice(2), "hex"),
            u32(input.event_revision),
            u64(BigInt(cell.h3_index)),
            Uint8Array.of(input.geo_resolution),
            Uint8Array.of(1),
            u16(cell.intensity_value),
            Uint8Array.of(1),
            Uint8Array.of(cell.cell_band),
            Uint8Array.of(1),
            u64(BigInt(input.oracle_version)),
        ];
        return createHashSync(concat(bytes));
    });
    if (hashes.length === 0) {
        return null;
    }
    let level = hashes;
    while (level.length > 1) {
        const next: Uint8Array[] = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = level[i + 1];
            if (left === undefined) {
                return null;
            }
            if (right === undefined) {
                next.push(left);
            } else {
                next.push(createHashSync(concat([Uint8Array.of(1), left, right])));
            }
        }
        level = next;
    }
    const root = level[0];
    return root === undefined ? null : `0x${Buffer.from(root).toString("hex")}`;
}

function createHashSync(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

function u16(value: number): Uint8Array {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return bytes;
}

function u32(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
}

function u64(value: bigint): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}

class RecordingSigner {
    signedBytes: Uint8Array | undefined;

    async sign(bytes: Uint8Array): Promise<Uint8Array> {
        this.signedBytes = bytes;
        return Uint8Array.from({ length: 64 }, () => 0x11);
    }

    asSigner(): RelayerSigner {
        return this as unknown as RelayerSigner;
    }

    getPublicKey() {
        return {
            toRawBytes: () => Uint8Array.from({ length: 32 }, () => 0x22),
        };
    }

    toSuiAddress(): string {
        return "0xsender";
    }
}
