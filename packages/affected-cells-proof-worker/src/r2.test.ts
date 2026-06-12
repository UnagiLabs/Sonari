/**
 * r2.test.ts
 *
 * saveProofArtifacts の単体テスト。
 *
 * 目的:
 * - serializedShards（直列化済み文字列）を受け取り、そのまま R2 に put することを検証する。
 * - 再直列化が発生しないこと（渡した文字列がバイト単位でそのまま保存される）を確認する。
 * - manifest が正しく保存され、loadProofManifest でキャッシュ経由で読める。
 *
 * TDD サイクル:
 * - RED: 旧 signature (shardEntriesMap) でテストを書き、型エラー/失敗を確認
 * - GREEN: 新 signature (serializedShards) に変更後に通ることを確認
 */

import { describe, expect, it } from "vitest";
import type { AffectedCellsProofManifest } from "./proof_artifacts.js";
import type { AffectedProofR2Bucket, AffectedProofR2Object } from "./r2.js";
import {
    loadProofManifest,
    manifestR2Key,
    saveProofArtifacts,
    serializeShardEntries,
    shardR2Key,
} from "./r2.js";

// ---------------------------------------------------------------------------
// Fake R2 Bucket（テスト用）
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

    getStored(key: string): string | undefined {
        const bytes = this.objects.get(key);
        return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
    }
}

// ---------------------------------------------------------------------------
// テスト用 manifest fixture
// ---------------------------------------------------------------------------

const TEST_EVENT_UID =
    "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd" as const;
const TEST_EVENT_REVISION = 1;
const TEST_SHARD_KEY = "0";

const TEST_MANIFEST: AffectedCellsProofManifest = {
    schema_version: 1,
    event_uid: TEST_EVENT_UID,
    event_revision: TEST_EVENT_REVISION,
    affected_cells_uri: "walrus://blob/test-blob-id-001",
    affected_cells_hash:
        "0xc3bb6d3a0ba176465f91024bf73aa89c1ba45aaa4f739a93288f2cbcafdb30bc",
    affected_cells_root:
        "0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f",
    affected_cell_count: 2,
    geo_resolution: 7,
    shards: [
        {
            shard_key: TEST_SHARD_KEY,
            r2_key: shardR2Key(TEST_EVENT_UID, TEST_EVENT_REVISION, TEST_SHARD_KEY),
            hash: "0x7e27c22634b42fdb3e5d85bb6b23d40ac42acea22bc0f4abf9644f31c8ba16d9",
            cell_count: 2,
        },
    ],
};

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("saveProofArtifacts", () => {
    it("渡した shard の文字列がバイト単位でそのまま R2 に put される（再直列化されない）", async () => {
        const bucket = new FakeR2Bucket();

        // 既知の文字列（何らかの shard JSON）を用意する
        const knownShardString = '{"entries":[{"custom_field":"this_should_be_preserved_as_is"}]}';
        const serializedShards = new Map<string, string>([[TEST_SHARD_KEY, knownShardString]]);

        await saveProofArtifacts({ bucket, manifest: TEST_MANIFEST, serializedShards });

        const expectedKey = shardR2Key(TEST_EVENT_UID, TEST_EVENT_REVISION, TEST_SHARD_KEY);
        const stored = bucket.getStored(expectedKey);

        // 渡した文字列がそのまま保存されている（再直列化による改変なし）
        expect(stored).toBe(knownShardString);
    });

    it("manifest が manifestR2Key に JSON.stringify(manifest) で put される", async () => {
        const bucket = new FakeR2Bucket();
        const serializedShards = new Map<string, string>([
            [TEST_SHARD_KEY, '{"entries":[]}'],
        ]);

        await saveProofArtifacts({ bucket, manifest: TEST_MANIFEST, serializedShards });

        const mKey = manifestR2Key(TEST_EVENT_UID, TEST_EVENT_REVISION);
        const stored = bucket.getStored(mKey);
        expect(stored).toBe(JSON.stringify(TEST_MANIFEST));
    });

    it("保存後 loadProofManifest が同 bucket インスタンスで cache 経由 manifest を返す", async () => {
        const bucket = new FakeR2Bucket();
        const serializedShards = new Map<string, string>([
            [TEST_SHARD_KEY, '{"entries":[]}'],
        ]);

        await saveProofArtifacts({ bucket, manifest: TEST_MANIFEST, serializedShards });

        // cache 経由で manifest が読める
        const loaded = await loadProofManifest(bucket, TEST_EVENT_UID, TEST_EVENT_REVISION);
        expect(loaded).toEqual(TEST_MANIFEST);
    });

    it("serializedShards が複数ある場合、すべてのシャードが正しいキーで put される", async () => {
        const bucket = new FakeR2Bucket();

        const shard0String = '{"entries":["shard0"]}';
        const shard1String = '{"entries":["shard1"]}';
        const serializedShards = new Map<string, string>([
            ["0", shard0String],
            ["1", shard1String],
        ]);

        const manifest: AffectedCellsProofManifest = {
            ...TEST_MANIFEST,
            shards: [
                {
                    shard_key: "0",
                    r2_key: shardR2Key(TEST_EVENT_UID, TEST_EVENT_REVISION, "0"),
                    hash: "0x7e27c22634b42fdb3e5d85bb6b23d40ac42acea22bc0f4abf9644f31c8ba16d9",
                    cell_count: 1,
                },
                {
                    shard_key: "1",
                    r2_key: shardR2Key(TEST_EVENT_UID, TEST_EVENT_REVISION, "1"),
                    hash: "0x7e27c22634b42fdb3e5d85bb6b23d40ac42acea22bc0f4abf9644f31c8ba16d9",
                    cell_count: 1,
                },
            ],
        };

        await saveProofArtifacts({ bucket, manifest, serializedShards });

        const key0 = shardR2Key(TEST_EVENT_UID, TEST_EVENT_REVISION, "0");
        const key1 = shardR2Key(TEST_EVENT_UID, TEST_EVENT_REVISION, "1");

        expect(bucket.getStored(key0)).toBe(shard0String);
        expect(bucket.getStored(key1)).toBe(shard1String);
    });
});

// ---------------------------------------------------------------------------
// serializeShardEntries は引き続き export されていることを確認する（STEP 2 との互換性）
// ---------------------------------------------------------------------------

describe("serializeShardEntries export compatibility", () => {
    it("serializeShardEntries が引き続き export されている", () => {
        // この関数が存在して呼び出し可能であることを型として確認する
        expect(typeof serializeShardEntries).toBe("function");
    });
});
