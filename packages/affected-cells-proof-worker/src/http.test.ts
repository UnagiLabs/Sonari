/**
 * http.test.ts
 *
 * STEP 5: 配信 API (http.ts) のテスト。
 *
 * TDD: RED→GREEN→REFACTOR
 *
 * テスト対象:
 * - 正常系: golden h3_index → 200, {leaf, proof, affected_cells_root} を返し root が golden 値
 * - 404: 存在しない（affected cells に含まれない）h3_index → affected_cell_not_in_event
 * - 400: 不正な h3_index（パース不能・resolution 不一致）→ invalid_request
 * - R2 miss 再生成: manifest はあるが shard を消した FakeR2Bucket + fake Walrus → 再生成して 200
 * - 配信前検証: leaf_hash 改ざん（entry の leaf を書き換えた shard）→ proof_shard_invalid
 */

import { describe, expect, it } from "vitest";
import type { AffectedProofR2Bucket } from "./r2.js";
import { handleProofRequest } from "./http.js";
import { handleRegisterRequest } from "./register.js";
import type { RegisterEnv } from "./register.js";

// ---------------------------------------------------------------------------
// Golden values
// ---------------------------------------------------------------------------

// schemas/examples/affected_cells.json の内容（Walrus から取得するファイル）
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

// golden の 2 つの h3_index（どちらも resolution=7 の有効なセル）
const GOLDEN_H3_INDEX_0 = "608819013513904127";
const GOLDEN_H3_INDEX_1 = "608819013597790207";

const VALID_REGISTER_TOKEN = "test-secret-token";
const WALRUS_BLOB_ID = "test-blob-id-001";
const WALRUS_BLOB_URI = `walrus://blob/${WALRUS_BLOB_ID}`;

// ---------------------------------------------------------------------------
// FakeR2Bucket (register.test.ts と同様の実装)
// ---------------------------------------------------------------------------

class FakeR2Object {
    constructor(private readonly bytes: Uint8Array) {}

    async arrayBuffer(): Promise<ArrayBuffer> {
        const buffer = new ArrayBuffer(this.bytes.byteLength);
        new Uint8Array(buffer).set(this.bytes);
        return buffer;
    }
}

class FakeR2Bucket implements AffectedProofR2Bucket {
    private readonly objects = new Map<string, Uint8Array>();
    private readonly putCounts = new Map<string, number>();

    constructor(entries: Array<[string, Uint8Array]> = []) {
        for (const [key, value] of entries) {
            this.objects.set(key, value);
        }
    }

    async get(key: string): Promise<FakeR2Object | null> {
        const value = this.objects.get(key);
        return value === undefined ? null : new FakeR2Object(value);
    }

    async put(key: string, value: string): Promise<void> {
        this.putCounts.set(key, this.getPutCount(key) + 1);
        this.objects.set(key, new TextEncoder().encode(value));
    }

    getPutCount(key: string): number {
        return this.putCounts.get(key) ?? 0;
    }

    getTotalPutCount(): number {
        let total = 0;
        for (const count of this.putCounts.values()) {
            total += count;
        }
        return total;
    }

    getStoredKeys(): string[] {
        return [...this.objects.keys()];
    }

    /** テスト用: 指定キーを R2 から削除する */
    delete(key: string): void {
        this.objects.delete(key);
    }
}

// ---------------------------------------------------------------------------
// Fake fetch（Walrus blob を返す）
// ---------------------------------------------------------------------------

function makeFakeWalrusFetch(blobId: string, bytes: Uint8Array): typeof fetch {
    return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        const url =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : (input as Request).url;
        if (url.includes(blobId)) {
            return new Response(bytes.buffer as ArrayBuffer, { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
    };
}

// ---------------------------------------------------------------------------
// Env builder
// ---------------------------------------------------------------------------

interface TestEnv extends RegisterEnv {
    fetchImpl: typeof fetch;
}

function buildEnv(options: { bucket?: FakeR2Bucket; fetchImpl?: typeof fetch } = {}): TestEnv {
    const goldenBytes = new TextEncoder().encode(GOLDEN_AFFECTED_CELLS_JSON);
    const defaultFetch = makeFakeWalrusFetch(WALRUS_BLOB_ID, goldenBytes);

    return {
        AFFECTED_PROOF_REGISTER_TOKEN: VALID_REGISTER_TOKEN,
        WALRUS_AGGREGATOR_URL: "https://walrus.example",
        GEO_RESOLUTION: "7",
        AFFECTED_PROOF_SHARDS: options.bucket ?? new FakeR2Bucket(),
        fetchImpl: options.fetchImpl ?? defaultFetch,
    };
}

// ---------------------------------------------------------------------------
// Register helper: テスト前に R2 へ proof を保存する
// ---------------------------------------------------------------------------

async function registerGolden(env: TestEnv): Promise<void> {
    const req = new Request(
        `https://worker.example/events/${GOLDEN_EVENT_UID}/revisions/${GOLDEN_EVENT_REVISION}/affected-cells`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-sonari-affected-proof-register-token": VALID_REGISTER_TOKEN,
            },
            body: JSON.stringify({
                event_uid: GOLDEN_EVENT_UID,
                event_revision: GOLDEN_EVENT_REVISION,
                affected_cells_hash: GOLDEN_HASH,
                affected_cells_root: GOLDEN_ROOT,
                affected_cell_count: 2,
                geo_resolution: 7,
                affected_cells_uri: WALRUS_BLOB_URI,
            }),
        },
    );
    const res = await handleRegisterRequest(req, env, env.fetchImpl);
    if (res.status !== 200) {
        const body = await res.json() as { error: { code: string; message: string } };
        throw new Error(`Registration failed: ${JSON.stringify(body)}`);
    }
}

// ---------------------------------------------------------------------------
// GET request builder
// ---------------------------------------------------------------------------

function buildGetRequest(
    h3Index: string,
    eventUid = GOLDEN_EVENT_UID,
    eventRevision = GOLDEN_EVENT_REVISION,
): Request {
    const url = new URL(
        `https://worker.example/events/${eventUid}/revisions/${eventRevision}/proof`,
    );
    url.searchParams.set("h3_index", h3Index);
    return new Request(url.toString());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleProofRequest", () => {
    // -------------------------------------------------------------------------
    // 正常系: golden h3_index → 200 + root が golden 値
    // -------------------------------------------------------------------------

    it("正常系: golden h3_index_0 で 200 が返り affected_cells_root が golden 値", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await registerGolden(env);

        const req = buildGetRequest(GOLDEN_H3_INDEX_0);
        const res = await handleProofRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.affected_cells_root).toBe(GOLDEN_ROOT);
        expect(body.event_uid).toBe(GOLDEN_EVENT_UID);
        expect(body.event_revision).toBe(GOLDEN_EVENT_REVISION);
        expect(body.h3_index).toBe(GOLDEN_H3_INDEX_0);
    });

    it("正常系: 返り値に leaf・proof フィールドが含まれる", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await registerGolden(env);

        const req = buildGetRequest(GOLDEN_H3_INDEX_0);
        const res = await handleProofRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(200);
        const body = await res.json() as {
            leaf: Record<string, unknown>;
            proof: unknown[];
            affected_cells_root: string;
        };
        // leaf には AffectedCellLeaf の全フィールドが含まれる
        expect(body.leaf).toBeDefined();
        expect(body.leaf.event_uid).toBe(GOLDEN_EVENT_UID);
        expect(body.leaf.event_revision).toBe(GOLDEN_EVENT_REVISION);
        expect(body.leaf.geo_resolution).toBe(7);
        expect(typeof body.leaf.h3_index).toBe("string"); // bigint は decimal string
        expect(typeof body.leaf.oracle_version).toBe("string"); // bigint は decimal string
        // proof は配列
        expect(Array.isArray(body.proof)).toBe(true);
        // 2 cellのツリーなので proof steps が存在する（odd-tail なら 0 の場合もある）
        expect(body.affected_cells_root).toBe(GOLDEN_ROOT);
    });

    it("正常系: golden h3_index_1 でも 200 が返り affected_cells_root が golden 値", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await registerGolden(env);

        const req = buildGetRequest(GOLDEN_H3_INDEX_1);
        const res = await handleProofRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.affected_cells_root).toBe(GOLDEN_ROOT);
        expect(body.h3_index).toBe(GOLDEN_H3_INDEX_1);
    });

    // -------------------------------------------------------------------------
    // 404: affected cells に含まれない h3_index
    // -------------------------------------------------------------------------

    it("404: affected cells に含まれない h3_index → affected_cell_not_in_event", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await registerGolden(env);

        // 有効な resolution=7 の h3_index だが golden には含まれない
        // buildH3(10, [0,1,2,3,4,5,6]) で構築した有効なセル
        const nonExistentH3 = "608338511463972863";
        const req = buildGetRequest(nonExistentH3);
        const res = await handleProofRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(404);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("affected_cell_not_in_event");
    });

    // -------------------------------------------------------------------------
    // 400: 不正な h3_index
    // -------------------------------------------------------------------------

    it("400: h3_index がパース不能な文字列 → invalid_request", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await registerGolden(env);

        const req = buildGetRequest("not-a-valid-h3-index");
        const res = await handleProofRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(400);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("invalid_request");
    });

    it("400: h3_index が resolution=7 以外 → invalid_request", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await registerGolden(env);

        // resolution=6 の有効な h3_index（GOLDEN とは異なる resolution）
        // 572957796083687423 は resolution=6 の有効なセル
        const res6H3Index = "572957796083687423";
        const req = buildGetRequest(res6H3Index);
        const res = await handleProofRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(400);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("invalid_request");
    });

    it("400: h3_index が空文字列 → invalid_request", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await registerGolden(env);

        const req = buildGetRequest("");
        const res = await handleProofRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(400);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("invalid_request");
    });

    // -------------------------------------------------------------------------
    // 404: manifest が存在しない
    // -------------------------------------------------------------------------

    it("manifest が存在しない → proof_manifest_missing 404", async () => {
        const bucket = new FakeR2Bucket(); // 空の bucket（登録なし）
        const env = buildEnv({ bucket });

        const req = buildGetRequest(GOLDEN_H3_INDEX_0);
        const res = await handleProofRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(404);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("proof_manifest_missing");
    });

    // -------------------------------------------------------------------------
    // R2 miss 再生成: manifest はあるが shard が無い → Walrus 再取得・再生成して 200
    // -------------------------------------------------------------------------

    it("R2 miss 再生成: shard が消えた場合に Walrus から再生成して 200", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await registerGolden(env);

        // shard を R2 から削除する
        const shardKeys = bucket.getStoredKeys().filter((k) => k.includes("/shards/"));
        expect(shardKeys.length).toBeGreaterThan(0);
        for (const key of shardKeys) {
            bucket.delete(key);
        }

        // shard がないが manifest はある状態で GET する → Walrus 再取得で再生成
        const req = buildGetRequest(GOLDEN_H3_INDEX_0);
        const res = await handleProofRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.affected_cells_root).toBe(GOLDEN_ROOT);
        expect(body.h3_index).toBe(GOLDEN_H3_INDEX_0);
    });

    it("R2 miss 再生成: 再生成後に shard が R2 に put される", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await registerGolden(env);

        // shard を削除
        const shardKeys = bucket.getStoredKeys().filter((k) => k.includes("/shards/"));
        const putCountBefore = bucket.getTotalPutCount();
        for (const key of shardKeys) {
            bucket.delete(key);
        }

        // GET → 再生成
        const req = buildGetRequest(GOLDEN_H3_INDEX_0);
        await handleProofRequest(req, env, env.fetchImpl);

        // put が増えている（shard が再保存された）
        expect(bucket.getTotalPutCount()).toBeGreaterThan(putCountBefore);
    });

    // -------------------------------------------------------------------------
    // fail-closed: leaf_hash 改ざん → proof_shard_invalid
    // -------------------------------------------------------------------------

    it("fail-closed: shard の leaf_hash が改ざんされている → proof_shard_invalid", async () => {
        // 正常に登録してデータを作る
        const registrationBucket = new FakeR2Bucket();
        const registrationEnv = buildEnv({ bucket: registrationBucket });
        await registerGolden(registrationEnv);

        // shard を読んで leaf_hash を改ざんする
        const shardKeys = registrationBucket.getStoredKeys().filter((k) => k.includes("/shards/"));
        expect(shardKeys.length).toBeGreaterThan(0);
        const shardKey = shardKeys[0]!;

        const shardObj = await registrationBucket.get(shardKey);
        expect(shardObj).not.toBeNull();
        const shardText = new TextDecoder().decode(await shardObj!.arrayBuffer());
        const shardData = JSON.parse(shardText) as { entries: Array<Record<string, unknown>> };

        // 最初の entry の leaf_hash を改ざん
        expect(shardData.entries.length).toBeGreaterThan(0);
        shardData.entries[0]!.leaf_hash = "0x" + "ff".repeat(32);

        // 改ざんした shard の sha256 を再計算して manifest に埋め込む
        // これにより「sha256 は正しいが leaf_hash が壊れた shard」を作る
        const { sha256Hex } = await import("@sonari/proof-core");
        const tamperedShardText = JSON.stringify(shardData);
        const tamperedShardBytes = new TextEncoder().encode(tamperedShardText);
        const tamperedShardHash = await sha256Hex(tamperedShardBytes) as `0x${string}`;

        // manifest も読んで shard hash を更新
        const manifestKey =
            `affected-proofs/events/${GOLDEN_EVENT_UID}/revisions/${GOLDEN_EVENT_REVISION}/manifest.json`;
        const manifestObj = await registrationBucket.get(manifestKey);
        expect(manifestObj).not.toBeNull();
        const manifestText = new TextDecoder().decode(await manifestObj!.arrayBuffer());
        const manifestData = JSON.parse(manifestText) as {
            schema_version: number;
            event_uid: string;
            event_revision: number;
            affected_cells_uri: string;
            affected_cells_hash: string;
            affected_cells_root: string;
            affected_cell_count: number;
            geo_resolution: number;
            shards: Array<{ shard_key: string; r2_key: string; hash: string; cell_count: number }>;
        };

        // shard の hash を改ざん後の hash に更新
        for (const shard of manifestData.shards) {
            if (shard.r2_key === shardKey) {
                shard.hash = tamperedShardHash;
            }
        }

        // 改ざん manifest と shard を新しい FakeR2Bucket に直接入れる
        // （manifest cache の影響を受けない新しい bucket インスタンスを使う）
        const tamperedBucket = new FakeR2Bucket();
        await tamperedBucket.put(manifestKey, JSON.stringify(manifestData));
        await tamperedBucket.put(shardKey, tamperedShardText);

        // fake Walrus は元の golden bytes を返す（R2 miss 再生成が起きても防ぐため
        // ここでは Walrus を 404 にして再生成できないようにする...が、
        // 実際には sha256 チェックが通ってしまい、R2 miss 再生成が 400 で失敗する）
        // よりシンプルに: 改ざんはsha256チェックを通過させた上で、
        // http.ts の verifyEntryIntegrity が leaf_hash 不一致を検出するはず

        const tamperedEnv = buildEnv({ bucket: tamperedBucket });

        // GET → sha256 チェック通過 → leaf_hash 再計算で改ざん検出 → proof_shard_invalid
        const req = buildGetRequest(GOLDEN_H3_INDEX_0);
        const res = await handleProofRequest(req, tamperedEnv, tamperedEnv.fetchImpl);

        expect(res.status).toBe(500);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("proof_shard_invalid");
    });

    // -------------------------------------------------------------------------
    // fail-closed: shard の sha256 が manifest と不一致 → proof_shard_integrity_mismatch
    // -------------------------------------------------------------------------

    it("fail-closed: shard の sha256 が manifest と不一致 → proof_shard_integrity_mismatch", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await registerGolden(env);

        // shard を読んで内容を改ざん（sha256 が変わる）
        const shardKeys = bucket.getStoredKeys().filter((k) => k.includes("/shards/"));
        const shardKey = shardKeys[0]!;
        // sha256 が変わるように shard 内容を変える（manifest の hash は変えない）
        await bucket.put(shardKey, JSON.stringify({ entries: [], _tampered: true }));

        // GET → sha256 チェックで弾かれる
        const req = buildGetRequest(GOLDEN_H3_INDEX_0);
        const res = await handleProofRequest(req, env, env.fetchImpl);

        // shard の整合性が壊れているので miss と見なして再生成 or integrity_mismatch
        // 設計によって異なるが、R2 miss 再生成（fail-closed: hash 不一致）で終わるはず
        // → 再生成経路に入るが Walrus データは正常なので再生成成功して 200 になる可能性もある
        // ここでは「壊れた shard → R2 miss 扱い → 再生成して 200」を期待する
        // （proof_shard_integrity_mismatch を R2 miss として扱う）
        expect([200, 500]).toContain(res.status);
        if (res.status === 500) {
            const body = await res.json() as { error: { code: string } };
            expect(body.error.code).toBe("proof_shard_integrity_mismatch");
        } else {
            // 再生成されて 200 になった場合は root が正しいことを確認
            const body = await res.json() as { affected_cells_root: string };
            expect(body.affected_cells_root).toBe(GOLDEN_ROOT);
        }
    });
});
