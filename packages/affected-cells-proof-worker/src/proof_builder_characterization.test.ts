/**
 * proof_builder_characterization.test.ts
 *
 * Characterization tests for buildAndSaveProofArtifacts.
 *
 * 目的: `buildAndSaveProofArtifacts` のリファクタリング（STEP 4: O(n²) 解消）の前後で
 * 保存されるバイト列と manifest の sha256 が不変であることを固定値で担保する。
 *
 * TDD サイクル:
 * - RED→安全網: 書き換え前のコードで通ることを確認
 * - GREEN: 書き換え後も同じ固定値でテストが通ることを確認
 */

import { describe, expect, it } from "vitest";
import { buildAndSaveProofArtifacts } from "./proof_builder.js";
import type { AffectedProofR2Bucket, AffectedProofR2Object } from "./r2.js";
import { serializeShardEntries } from "./r2.js";

// ---------------------------------------------------------------------------
// Golden values（register.test.ts / http.test.ts と共通）
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
const GOLDEN_EVENT_REVISION = 1;

// ---------------------------------------------------------------------------
// 固定値（書き換え前のコードで実行して得た実値）
//
// SHARD_KEY=0 の serializeShardEntries(entries) 出力:
// - entry[0]: h3_index=608819013513904127, leaf_hash=0x83bc299c...
// - entry[1]: h3_index=608819013597790207, leaf_hash=0xbc6630b4...
// manifest の shards[0].hash:
// - sha256Hex(TextEncoder.encode(serializeShardEntries(entries))) の値
// ---------------------------------------------------------------------------

const EXPECTED_SHARD_0_BYTES =
    '{"entries":[' +
    '{"event_uid":"0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",' +
    '"event_revision":1,' +
    '"geo_resolution":7,' +
    '"h3_index":"608819013513904127",' +
    '"cell_band":3,' +
    '"intensity_value":831,' +
    '"cell_metric":"USGS_MMI",' +
    '"intensity_scale":"MMI_X100",' +
    '"cells_generation_method":"shakemap_gridxml_h3_grid_point_p90_v1",' +
    '"oracle_version":"1",' +
    '"leaf_hash":"0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",' +
    '"proof":[{"sibling_on_left":false,"sibling_hash":"0xbc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f"}]},' +
    '{"event_uid":"0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",' +
    '"event_revision":1,' +
    '"geo_resolution":7,' +
    '"h3_index":"608819013597790207",' +
    '"cell_band":1,' +
    '"intensity_value":723,' +
    '"cell_metric":"USGS_MMI",' +
    '"intensity_scale":"MMI_X100",' +
    '"cells_generation_method":"shakemap_gridxml_h3_grid_point_p90_v1",' +
    '"oracle_version":"1",' +
    '"leaf_hash":"0xbc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f",' +
    '"proof":[{"sibling_on_left":true,"sibling_hash":"0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f"}]}' +
    ']}';

const EXPECTED_MANIFEST_SHARD_0_HASH =
    "0x7e27c22634b42fdb3e5d85bb6b23d40ac42acea22bc0f4abf9644f31c8ba16d9";

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

    getStoredKeys(): string[] {
        return [...this.objects.keys()];
    }
}

// ---------------------------------------------------------------------------
// Characterization Tests
// ---------------------------------------------------------------------------

describe("buildAndSaveProofArtifacts characterization (byte-stable)", () => {
    it("shard key=0 の serializeShardEntries 出力が固定値と一致する", async () => {
        const bucket = new FakeR2Bucket();
        const goldenBytes = new TextEncoder().encode(GOLDEN_AFFECTED_CELLS_JSON);

        const result = await buildAndSaveProofArtifacts({
            bytes: goldenBytes,
            eventUid: GOLDEN_EVENT_UID,
            eventRevision: GOLDEN_EVENT_REVISION,
            affectedCellsUri: "walrus://blob/test-blob-id-001",
            affectedCellsHash: GOLDEN_HASH,
            affectedCellsRoot: GOLDEN_ROOT,
            affectedCellCount: 2,
            geoResolution: 7,
            bucket,
        });

        // shard key=0 の entries が shardEntriesMap に存在する
        const entries = result.shardEntriesMap.get("0");
        expect(entries).toBeDefined();

        // serializeShardEntries(entries) のバイト列が固定値と一致する（出力バイト不変）
        const serialized = serializeShardEntries(entries!);
        expect(serialized).toBe(EXPECTED_SHARD_0_BYTES);
    });

    it("manifest の shards[0].hash が固定値と一致する", async () => {
        const bucket = new FakeR2Bucket();
        const goldenBytes = new TextEncoder().encode(GOLDEN_AFFECTED_CELLS_JSON);

        const result = await buildAndSaveProofArtifacts({
            bytes: goldenBytes,
            eventUid: GOLDEN_EVENT_UID,
            eventRevision: GOLDEN_EVENT_REVISION,
            affectedCellsUri: "walrus://blob/test-blob-id-001",
            affectedCellsHash: GOLDEN_HASH,
            affectedCellsRoot: GOLDEN_ROOT,
            affectedCellCount: 2,
            geoResolution: 7,
            bucket,
        });

        // manifest.shards[0].hash が固定値と一致する
        const shard0 = result.manifest.shards[0];
        expect(shard0).toBeDefined();
        expect(shard0!.hash).toBe(EXPECTED_MANIFEST_SHARD_0_HASH);
    });

    it("R2 に保存された shard の本体バイト列が固定値と一致する", async () => {
        const bucket = new FakeR2Bucket();
        const goldenBytes = new TextEncoder().encode(GOLDEN_AFFECTED_CELLS_JSON);

        const result = await buildAndSaveProofArtifacts({
            bytes: goldenBytes,
            eventUid: GOLDEN_EVENT_UID,
            eventRevision: GOLDEN_EVENT_REVISION,
            affectedCellsUri: "walrus://blob/test-blob-id-001",
            affectedCellsHash: GOLDEN_HASH,
            affectedCellsRoot: GOLDEN_ROOT,
            affectedCellCount: 2,
            geoResolution: 7,
            bucket,
        });

        // R2 に保存された shard キーを取得
        const shardKeys = bucket.getStoredKeys().filter((k) => k.includes("/shards/"));
        expect(shardKeys.length).toBe(1);

        const shardKey = shardKeys[0]!;
        const shardObj = await bucket.get(shardKey);
        expect(shardObj).not.toBeNull();

        // R2 に put されたバイト列が固定値と一致する
        const storedText = new TextDecoder().decode(await shardObj!.arrayBuffer());
        expect(storedText).toBe(EXPECTED_SHARD_0_BYTES);

        // manifest の shard hash との一致も確認（loadProofShard と同じ経路）
        const { sha256Hex } = await import("@sonari/proof-core");
        const digest = sha256Hex(new TextEncoder().encode(storedText));
        expect(digest).toBe(EXPECTED_MANIFEST_SHARD_0_HASH);
        expect(digest).toBe(result.manifest.shards[0]!.hash);
    });
});
