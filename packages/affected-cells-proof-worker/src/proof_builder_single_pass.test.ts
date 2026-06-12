/**
 * proof_builder_single_pass.test.ts
 *
 * 単一パス化の機械検証。
 *
 * 目的: `buildAndSaveProofArtifacts` 1 回の実行で
 * - Merkle ツリー構築（merkleLevelsFromLeafHashes）が **ちょうど 1 回**
 * - shard 直列化（serializeShardEntries）が **ちょうど 1 回**
 * であることを spy で確認する。
 *
 * 修正前はツリー 2 回（affectedCellsRoot + buildProofShardGroups 内）・
 * 直列化 2 回（manifest hash 用 + R2 保存用）だったため、このテストは
 * 単一パス化前の実装では失敗する（= 単一パス化の機械的な証拠）。
 */

import { describe, expect, it, vi } from "vitest";
import type { AffectedProofR2Bucket, AffectedProofR2Object } from "./r2.js";

// ---------------------------------------------------------------------------
// spy 用の mock
// proof-core の merkleLevelsFromLeafHashes と r2.js の serializeShardEntries を
// importOriginal で本物にラップしつつ呼び出し回数をカウントする。
// ---------------------------------------------------------------------------

const merkleSpy = vi.fn();
const serializeSpy = vi.fn();

vi.mock("@sonari/proof-core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@sonari/proof-core")>();
    return {
        ...actual,
        merkleLevelsFromLeafHashes: (leafHashes: Parameters<typeof actual.merkleLevelsFromLeafHashes>[0]) => {
            merkleSpy();
            return actual.merkleLevelsFromLeafHashes(leafHashes);
        },
    };
});

vi.mock("./r2.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./r2.js")>();
    return {
        ...actual,
        serializeShardEntries: (entries: Parameters<typeof actual.serializeShardEntries>[0]) => {
            serializeSpy();
            return actual.serializeShardEntries(entries);
        },
    };
});

// mock 設定後に import する（巻き上げ後の本体を使う）
const { buildAndSaveProofArtifacts } = await import("./proof_builder.js");

// ---------------------------------------------------------------------------
// Golden 入力（characterization テストと同一の 2 セル入力）
// ---------------------------------------------------------------------------

const GOLDEN_AFFECTED_CELLS_JSON = JSON.stringify({
    event_uid: "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
    event_revision: 1,
    oracle_version: 1,
    geo_resolution: 7,
    cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
    cell_metric: "USGS_MMI",
    cell_aggregation: "GRID_POINT_P90",
    intensity_scale: "MMI_X100",
    affected_cells: [
        { h3_index: "608819013513904127", intensity_value: 831, cell_band: 3 },
        { h3_index: "608819013597790207", intensity_value: 723, cell_band: 1 },
    ],
});

const GOLDEN_HASH =
    "0xc3bb6d3a0ba176465f91024bf73aa89c1ba45aaa4f739a93288f2cbcafdb30bc";
const GOLDEN_ROOT =
    "0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f";
const GOLDEN_EVENT_UID =
    "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";

// ---------------------------------------------------------------------------
// Fake R2 Bucket
// ---------------------------------------------------------------------------

class FakeR2Object implements AffectedProofR2Object {
    constructor(private readonly bytes: Uint8Array) {}

    async arrayBuffer(): Promise<ArrayBuffer> {
        const buffer = new ArrayBuffer(this.bytes.byteLength);
        new Uint8Array(buffer).set(this.bytes);
        return buffer;
    }
}

class FakeR2Bucket implements AffectedProofR2Bucket {
    private readonly objects = new Map<string, Uint8Array>();

    async get(key: string): Promise<FakeR2Object | null> {
        const value = this.objects.get(key);
        return value === undefined ? null : new FakeR2Object(value);
    }

    async put(key: string, value: string): Promise<void> {
        this.objects.set(key, new TextEncoder().encode(value));
    }
}

async function runBuild(): Promise<void> {
    const bucket = new FakeR2Bucket();
    await buildAndSaveProofArtifacts({
        bytes: new TextEncoder().encode(GOLDEN_AFFECTED_CELLS_JSON),
        eventUid: GOLDEN_EVENT_UID,
        eventRevision: 1,
        affectedCellsUri: "walrus://blob/test-blob-id-001",
        affectedCellsHash: GOLDEN_HASH,
        affectedCellsRoot: GOLDEN_ROOT,
        affectedCellCount: 2,
        geoResolution: 7,
        bucket,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildAndSaveProofArtifacts single-pass", () => {
    it("Merkle ツリー構築（merkleLevelsFromLeafHashes）が 1 回だけ呼ばれる", async () => {
        merkleSpy.mockClear();
        serializeSpy.mockClear();
        await runBuild();
        expect(merkleSpy).toHaveBeenCalledTimes(1);
    });

    it("shard 直列化（serializeShardEntries）が 1 回だけ呼ばれる", async () => {
        merkleSpy.mockClear();
        serializeSpy.mockClear();
        await runBuild();
        expect(serializeSpy).toHaveBeenCalledTimes(1);
    });
});
