/**
 * register.test.ts
 *
 * STEP 4: 登録 API (register.ts) と R2 保存層 (r2.ts) のテスト。
 *
 * TDD: RED→GREEN→REFACTOR
 *
 * テスト対象:
 * - 正常系: golden 例の登録で manifest/shard が FakeR2Bucket に put される
 * - fail-closed 6系統:
 *   1. affected_cells_hash が golden と違う → affected_cells_hash_mismatch、put されない
 *   2. affected_cells_root が golden と違う → affected_cells_root_mismatch、put されない
 *   3. token 不正/欠落 → 401 unauthorized、put されない
 *   4. schema 違反（重複 h3_index）→ affected_cells_invalid、put されない
 *   5. geo_resolution が config と不一致 → invalid_request、put されない
 *   6. 三者不一致（path の event_uid と body の event_uid が違う）→ fail-closed、put されない
 * - 冪等: 同一登録を2回 → 2回目 200 no-op（R2 への put は初回のみ）
 * - root が違う再登録 → 拒否
 */

import { describe, expect, it } from "vitest";
import { handleRegisterRequest } from "./register.js";
import type { Env } from "./walrus.js";
import type { AffectedProofR2Bucket } from "./r2.js";
import {
    type AffectedAreaWorkflowBinding,
    affectedAreaWorkflowInstanceId,
} from "./affected_area_workflow_trigger.js";

// ---------------------------------------------------------------------------
// Golden values (schemas/examples/affected_cells.json と expected_hashes.json より)
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

// expected_hashes.json より
const GOLDEN_HASH =
    "0xc3bb6d3a0ba176465f91024bf73aa89c1ba45aaa4f739a93288f2cbcafdb30bc";
const GOLDEN_ROOT =
    "0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f";

const GOLDEN_EVENT_UID =
    "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";
const GOLDEN_EVENT_REVISION = 1;

const VALID_REGISTER_TOKEN = "test-secret-token";
const WALRUS_BLOB_URI = "walrus://blob/test-blob-id-001";
const FAKE_WORKFLOW_INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

// ---------------------------------------------------------------------------
// Fake R2 Bucket
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
    private readonly getCounts = new Map<string, number>();

    constructor(entries: Array<[string, Uint8Array]> = []) {
        for (const [key, value] of entries) {
            this.objects.set(key, value);
        }
    }

    async get(key: string): Promise<FakeR2Object | null> {
        this.getCounts.set(key, this.getGetCount(key) + 1);
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

    getGetCount(key: string): number {
        return this.getCounts.get(key) ?? 0;
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
}

class FakeWorkflowInstance {
    restartCount = 0;

    constructor(
        readonly id: string,
        private statusValue: InstanceStatus["status"] = "queued",
    ) {}

    async status(): Promise<InstanceStatus> {
        return { status: this.statusValue, rollback: null };
    }

    async restart(): Promise<void> {
        this.restartCount += 1;
        this.statusValue = "queued";
    }
}

class FakeAffectedAreaWorkflow implements AffectedAreaWorkflowBinding {
    readonly createBatchCalls: Array<readonly WorkflowInstanceCreateOptions[]> = [];
    private readonly instances = new Map<string, FakeWorkflowInstance>();

    constructor(seed: Array<[string, InstanceStatus["status"]]> = []) {
        for (const [id, status] of seed) {
            this.instances.set(id, new FakeWorkflowInstance(id, status));
        }
    }

    async createBatch(
        batch: readonly WorkflowInstanceCreateOptions[],
    ): Promise<WorkflowInstance[]> {
        this.createBatchCalls.push(batch);
        const created: WorkflowInstance[] = [];
        for (const item of batch) {
            if (item.id === undefined || this.instances.has(item.id)) {
                continue;
            }
            if (!FAKE_WORKFLOW_INSTANCE_ID_PATTERN.test(item.id)) {
                throw new Error("(instance.invalid_id) Instance ID is invalid");
            }
            const instance = new FakeWorkflowInstance(item.id);
            this.instances.set(item.id, instance);
            created.push(instance);
        }
        return created;
    }

    async get(id: string): Promise<WorkflowInstance> {
        const instance = this.instances.get(id);
        if (instance === undefined) {
            throw new Error(`Workflow instance not found: ${id}`);
        }
        return instance;
    }

    getCreateBatchCount(): number {
        return this.createBatchCalls.length;
    }

    getInstance(id: string): FakeWorkflowInstance | undefined {
        return this.instances.get(id);
    }
}

// ---------------------------------------------------------------------------
// Fake fetch（Walrus blob を返す）
// ---------------------------------------------------------------------------

function makeFakeWalrusFetch(
    blobId: string,
    bytes: Uint8Array,
): typeof fetch {
    return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(blobId)) {
            return new Response(bytes.buffer as ArrayBuffer, { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
    };
}

// ---------------------------------------------------------------------------
// Env builder
// ---------------------------------------------------------------------------

function buildEnv(options: {
    token?: string;
    geoResolution?: string;
    bucket?: FakeR2Bucket;
    affectedAreaBucket?: FakeR2Bucket;
    affectedAreaWorkflow?: FakeAffectedAreaWorkflow;
    fetchImpl?: typeof fetch;
} = {}): Env & {
    AFFECTED_PROOF_SHARDS: FakeR2Bucket;
    AFFECTED_AREA_ARTIFACTS: FakeR2Bucket;
    AFFECTED_AREA_ARTIFACT_WORKFLOW: FakeAffectedAreaWorkflow;
    fetchImpl?: typeof fetch;
} {
    const goldenBytes = new TextEncoder().encode(GOLDEN_AFFECTED_CELLS_JSON);
    const defaultFetch = makeFakeWalrusFetch("test-blob-id-001", goldenBytes);

    return {
        AFFECTED_PROOF_REGISTER_TOKEN: options.token ?? VALID_REGISTER_TOKEN,
        WALRUS_AGGREGATOR_URL: "https://walrus.example",
        GEO_RESOLUTION: options.geoResolution ?? "7",
        AFFECTED_PROOF_SHARDS: options.bucket ?? new FakeR2Bucket(),
        AFFECTED_AREA_ARTIFACTS: options.affectedAreaBucket ?? new FakeR2Bucket(),
        AFFECTED_AREA_ARTIFACT_WORKFLOW:
            options.affectedAreaWorkflow ?? new FakeAffectedAreaWorkflow(),
        fetchImpl: options.fetchImpl ?? defaultFetch,
    };
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function buildRegisterRequest(
    options: {
        token?: string | null;
        eventUid?: string;
        eventRevision?: number;
        bodyEventUid?: string;
        bodyEventRevision?: number;
        hash?: string;
        root?: string;
        affectedCellCount?: number;
        geoResolution?: number;
        uri?: string;
    } = {},
): Request {
    const eventUid = options.eventUid ?? GOLDEN_EVENT_UID;
    const eventRevision = options.eventRevision ?? GOLDEN_EVENT_REVISION;

    const body = {
        event_uid: options.bodyEventUid ?? eventUid,
        event_revision: options.bodyEventRevision ?? eventRevision,
        affected_cells_hash: options.hash ?? GOLDEN_HASH,
        affected_cells_root: options.root ?? GOLDEN_ROOT,
        affected_cell_count: options.affectedCellCount ?? 2,
        geo_resolution: options.geoResolution ?? 7,
        affected_cells_uri: options.uri ?? WALRUS_BLOB_URI,
    };

    const headers: Record<string, string> = {
        "content-type": "application/json",
    };

    if (options.token !== null) {
        headers["x-sonari-affected-proof-register-token"] = options.token ?? VALID_REGISTER_TOKEN;
    }

    return new Request(
        `https://worker.example/events/${eventUid}/revisions/${eventRevision}/affected-cells`,
        {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        },
    );
}

// ---------------------------------------------------------------------------
// Helper: R2 key pattern
// ---------------------------------------------------------------------------

function manifestKey(eventUid: string, eventRevision: number): string {
    return `affected-proofs/events/${eventUid}/revisions/${eventRevision}/manifest.json`;
}

function affectedAreaManifestKey(eventUid: string, eventRevision: number): string {
    return `affected-area/events/${eventUid}/revisions/${eventRevision}/affected-area-manifest.json`;
}

function workflowId(eventUid: string, eventRevision: number, root: string): string {
    return affectedAreaWorkflowInstanceId({
        event_uid: eventUid,
        event_revision: eventRevision,
        affected_cells_hash: GOLDEN_HASH,
        affected_cells_root: root,
        affected_cell_count: 2,
        geo_resolution: 7,
        affected_cells_uri: WALRUS_BLOB_URI,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleRegisterRequest", () => {
    // -------------------------------------------------------------------------
    // 正常系
    // -------------------------------------------------------------------------

    it("正常系: golden 例の登録で manifest と shard が R2 に put される", async () => {
        const bucket = new FakeR2Bucket();
        const workflow = new FakeAffectedAreaWorkflow();
        const env = buildEnv({ bucket, affectedAreaWorkflow: workflow });
        const req = buildRegisterRequest();

        const res = await handleRegisterRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.event_uid).toBe(GOLDEN_EVENT_UID);
        expect(body.event_revision).toBe(GOLDEN_EVENT_REVISION);
        expect(body.affected_cells_root).toBe(GOLDEN_ROOT);
        expect(body.stored).toBe(true);

        // manifest が put されている
        const mKey = manifestKey(GOLDEN_EVENT_UID, GOLDEN_EVENT_REVISION);
        expect(bucket.getPutCount(mKey)).toBe(1);

        // shard が少なくとも 1 件 put されている（shard_count=1 なので shard/0.json 等）
        const storedKeys = bucket.getStoredKeys();
        const shardKeys = storedKeys.filter((k) => k.includes("/shards/"));
        expect(shardKeys.length).toBeGreaterThan(0);
        expect(workflow.getCreateBatchCount()).toBe(1);
        expect(workflow.createBatchCalls[0]?.[0]?.id?.length).toBeLessThanOrEqual(64);
        expect(workflow.createBatchCalls[0]?.[0]).toMatchObject({
            id: workflowId(GOLDEN_EVENT_UID, GOLDEN_EVENT_REVISION, GOLDEN_ROOT),
            params: {
                event_uid: GOLDEN_EVENT_UID,
                event_revision: GOLDEN_EVENT_REVISION,
                affected_cells_root: GOLDEN_ROOT,
            },
        });
    });

    it("正常系: 成功レスポンスに shard_count=1 が含まれる", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        const req = buildRegisterRequest();

        const res = await handleRegisterRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.shard_count).toBe(1);
    });

    // -------------------------------------------------------------------------
    // fail-closed 系統 1: hash 不一致
    // -------------------------------------------------------------------------

    it("fail-closed: affected_cells_hash が不一致なら affected_cells_hash_mismatch", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        const wrongHash = "0x" + "ab".repeat(32);
        const req = buildRegisterRequest({ hash: wrongHash });

        const res = await handleRegisterRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(400);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("affected_cells_hash_mismatch");
        // R2 に何も put されていない
        expect(bucket.getTotalPutCount()).toBe(0);
    });

    // -------------------------------------------------------------------------
    // fail-closed 系統 2: root 不一致
    // -------------------------------------------------------------------------

    it("fail-closed: affected_cells_root が不一致なら affected_cells_root_mismatch", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        const wrongRoot = "0x" + "cd".repeat(32);
        const req = buildRegisterRequest({ root: wrongRoot });

        const res = await handleRegisterRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(400);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("affected_cells_root_mismatch");
        expect(bucket.getTotalPutCount()).toBe(0);
    });

    // -------------------------------------------------------------------------
    // fail-closed 系統 3: token 不正/欠落
    // -------------------------------------------------------------------------

    it("fail-closed: token が欠落なら 401 unauthorized", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        const req = buildRegisterRequest({ token: null });

        const res = await handleRegisterRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(401);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("unauthorized");
        expect(bucket.getTotalPutCount()).toBe(0);
    });

    it("fail-closed: token が不正なら 401 unauthorized", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        const req = buildRegisterRequest({ token: "wrong-token" });

        const res = await handleRegisterRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(401);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("unauthorized");
        expect(bucket.getTotalPutCount()).toBe(0);
    });

    // -------------------------------------------------------------------------
    // fail-closed 系統 4: schema 違反（重複 h3_index）
    // -------------------------------------------------------------------------

    it("fail-closed: schema 違反（重複 h3_index）なら affected_cells_invalid", async () => {
        const bucket = new FakeR2Bucket();

        // 重複 h3_index を含む affected_cells.json を返す fake fetch
        const invalidAffectedCells = JSON.stringify({
            event_uid: GOLDEN_EVENT_UID,
            event_revision: GOLDEN_EVENT_REVISION,
            oracle_version: 1,
            geo_resolution: 7,
            cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
            cell_metric: "USGS_MMI",
            cell_aggregation: "GRID_POINT_P90",
            intensity_scale: "MMI_X100",
            affected_cells: [
                // 重複: 同じ h3_index が 2 つ
                { h3_index: "608819013513904127", intensity_value: 831, cell_band: 3 },
                { h3_index: "608819013513904127", intensity_value: 723, cell_band: 1 },
            ],
        });
        const invalidBytes = new TextEncoder().encode(invalidAffectedCells);

        // hash は「この壊れた bytes の SHA-256」に合わせる（hash 照合は通過させる）
        const { sha256Hex } = await import("@sonari/proof-core");
        const invalidHash = await sha256Hex(invalidBytes);

        const fakeFetch = makeFakeWalrusFetch("test-blob-id-001", invalidBytes);
        const env = buildEnv({ bucket, fetchImpl: fakeFetch });

        const req = buildRegisterRequest({
            hash: invalidHash,
            // root は何でもよい（schema validation が先に失敗するため）
            root: GOLDEN_ROOT,
        });

        const res = await handleRegisterRequest(req, env, fakeFetch);

        expect(res.status).toBe(400);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("affected_cells_invalid");
        expect(bucket.getTotalPutCount()).toBe(0);
    });

    // -------------------------------------------------------------------------
    // fail-closed 系統 5: geo_resolution が config と不一致
    // -------------------------------------------------------------------------

    it("fail-closed: body の geo_resolution が env 設定と不一致なら invalid_request", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket, geoResolution: "7" });
        // body で geo_resolution=5（config=7 と不一致）
        const req = buildRegisterRequest({ geoResolution: 5 });

        const res = await handleRegisterRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(400);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("invalid_request");
        expect(bucket.getTotalPutCount()).toBe(0);
    });

    // -------------------------------------------------------------------------
    // fail-closed 系統 6: 三者不一致（path の event_uid と body の event_uid が違う）
    // -------------------------------------------------------------------------

    it("fail-closed: path の event_uid と body の event_uid が不一致なら fail-closed", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        const differentUid = "0x" + "ff".repeat(32);
        // path は GOLDEN_EVENT_UID だが body の event_uid は違う値
        const req = buildRegisterRequest({ bodyEventUid: differentUid });

        const res = await handleRegisterRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(400);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("invalid_request");
        expect(bucket.getTotalPutCount()).toBe(0);
    });

    it("fail-closed: path の event_revision と body の event_revision が不一致なら fail-closed", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        // path は revision=1 だが body の event_revision は 2
        const req = buildRegisterRequest({ bodyEventRevision: 2 });

        const res = await handleRegisterRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(400);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("invalid_request");
        expect(bucket.getTotalPutCount()).toBe(0);
    });

    // -------------------------------------------------------------------------
    // shard entry に leaf 全フィールドが保存される
    // -------------------------------------------------------------------------

    it("shard entry に AffectedCellLeaf の全フィールドが保存される", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        const req = buildRegisterRequest();

        await handleRegisterRequest(req, env, env.fetchImpl);

        const storedKeys = bucket.getStoredKeys();
        const shardKey = storedKeys.find((k) => k.includes("/shards/"));
        expect(shardKey).toBeDefined();

        const shardObject = await bucket.get(shardKey!);
        expect(shardObject).not.toBeNull();

        const shardJson = new TextDecoder().decode(await shardObject!.arrayBuffer());
        const shardData = JSON.parse(shardJson) as { entries: unknown[] };
        expect(shardData.entries).toBeDefined();
        expect(shardData.entries.length).toBeGreaterThan(0);

        const entry = shardData.entries[0] as Record<string, unknown>;
        // AffectedCellLeaf の全フィールド確認
        expect(entry).toHaveProperty("event_uid");
        expect(entry).toHaveProperty("event_revision");
        expect(entry).toHaveProperty("h3_index");
        expect(entry).toHaveProperty("geo_resolution");
        expect(entry).toHaveProperty("cell_band");
        expect(entry).toHaveProperty("intensity_value");
        expect(entry).toHaveProperty("cell_metric");
        expect(entry).toHaveProperty("intensity_scale");
        expect(entry).toHaveProperty("cells_generation_method");
        expect(entry).toHaveProperty("oracle_version");
        // proof フィールド
        expect(entry).toHaveProperty("leaf_hash");
        expect(entry).toHaveProperty("proof");
        // bigint は decimal string で保存される
        expect(typeof entry.h3_index).toBe("string");
        expect(typeof entry.oracle_version).toBe("string");
    });

    // -------------------------------------------------------------------------
    // 冪等: 同一登録を2回 → 2回目 200 no-op
    // -------------------------------------------------------------------------

    it("冪等: 同一登録を2回 → 2回目は 200 no-op（R2 への put は初回のみ）", async () => {
        const bucket = new FakeR2Bucket();
        const workflow = new FakeAffectedAreaWorkflow();
        const env = buildEnv({ bucket, affectedAreaWorkflow: workflow });
        const req1 = buildRegisterRequest();
        const req2 = buildRegisterRequest();

        const res1 = await handleRegisterRequest(req1, env, env.fetchImpl);
        const body1 = await res1.json() as Record<string, unknown>;
        const totalPutAfterFirst = bucket.getTotalPutCount();

        const res2 = await handleRegisterRequest(req2, env, env.fetchImpl);
        const body2 = await res2.json() as Record<string, unknown>;
        const totalPutAfterSecond = bucket.getTotalPutCount();

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        // 2回目は put が増えていない（no-op）
        expect(totalPutAfterSecond).toBe(totalPutAfterFirst);
        // 両方 stored: true または 2回目は stored: false でも OK
        expect(body1.event_uid).toBe(GOLDEN_EVENT_UID);
        expect(body2.event_uid).toBe(GOLDEN_EVENT_UID);
        expect(workflow.getCreateBatchCount()).toBe(2);
    });

    it("冪等: affected-area manifest が既にある no-op では Workflow を再起動しない", async () => {
        const bucket = new FakeR2Bucket();
        const affectedAreaBucket = new FakeR2Bucket([
            [
                affectedAreaManifestKey(GOLDEN_EVENT_UID, GOLDEN_EVENT_REVISION),
                new TextEncoder().encode("{}"),
            ],
        ]);
        const workflow = new FakeAffectedAreaWorkflow();
        const env = buildEnv({ bucket, affectedAreaBucket, affectedAreaWorkflow: workflow });

        const res1 = await handleRegisterRequest(buildRegisterRequest(), env, env.fetchImpl);
        const res2 = await handleRegisterRequest(buildRegisterRequest(), env, env.fetchImpl);

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(workflow.getCreateBatchCount()).toBe(0);
    });

    it("fail-closed: 既存 manifest と request metadata が違う no-op は Workflow を起動しない", async () => {
        const bucket = new FakeR2Bucket();
        const workflow = new FakeAffectedAreaWorkflow();
        const env = buildEnv({ bucket, affectedAreaWorkflow: workflow });

        const res1 = await handleRegisterRequest(buildRegisterRequest(), env, env.fetchImpl);
        const res2 = await handleRegisterRequest(
            buildRegisterRequest({ hash: `0x${"ab".repeat(32)}` }),
            env,
            env.fetchImpl,
        );

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(409);
        const body = await res2.json() as { error: { code: string } };
        expect(body.error.code).toBe("affected_cells_root_mismatch");
        expect(workflow.getCreateBatchCount()).toBe(1);
    });

    it("冪等: 既存 Workflow が errored なら manifest 未作成時に restart する", async () => {
        const id = workflowId(GOLDEN_EVENT_UID, GOLDEN_EVENT_REVISION, GOLDEN_ROOT);
        const workflow = new FakeAffectedAreaWorkflow([[id, "errored"]]);
        const env = buildEnv({ affectedAreaWorkflow: workflow });

        const res = await handleRegisterRequest(buildRegisterRequest(), env, env.fetchImpl);

        expect(res.status).toBe(200);
        expect(workflow.getCreateBatchCount()).toBe(1);
        expect(workflow.getInstance(id)?.restartCount).toBe(1);
    });

    it("fail-closed: Workflow 起動に失敗したら登録 API も失敗する", async () => {
        const failingWorkflow: AffectedAreaWorkflowBinding = {
            async createBatch(): Promise<WorkflowInstance[]> {
                throw new Error("workflow create failed");
            },
            async get(): Promise<WorkflowInstance> {
                throw new Error("not called");
            },
        };
        const env = buildEnv({
            affectedAreaWorkflow: failingWorkflow as FakeAffectedAreaWorkflow,
        });

        const res = await handleRegisterRequest(buildRegisterRequest(), env, env.fetchImpl);

        expect(res.status).toBe(500);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("internal");
    });

    // -------------------------------------------------------------------------
    // 冪等: root が違う再登録 → 拒否
    // -------------------------------------------------------------------------

    it("冪等: root が違う再登録は fail-closed", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });

        // 初回登録は成功
        const req1 = buildRegisterRequest();
        const res1 = await handleRegisterRequest(req1, env, env.fetchImpl);
        expect(res1.status).toBe(200);

        // 同じ event_uid/revision で root が違う再登録は拒否
        const wrongRoot = "0x" + "ee".repeat(32);
        const req2 = buildRegisterRequest({ root: wrongRoot });
        const res2 = await handleRegisterRequest(req2, env, env.fetchImpl);

        expect(res2.status).not.toBe(200);
        const body = await res2.json() as { error: { code: string } };
        // root 違いなので hash は通過するが root で弾かれる（affected_cells_root_mismatch）
        // または 既存 manifest との conflict で特定のエラーが返る
        expect(body.error.code).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // invalid_request: walrus:// 以外の URI
    // -------------------------------------------------------------------------

    it("fail-closed: affected_cells_uri が walrus:// 形式でない → invalid_request", async () => {
        const bucket = new FakeR2Bucket();
        const workflow = new FakeAffectedAreaWorkflow();
        const env = buildEnv({ bucket, affectedAreaWorkflow: workflow });
        const req = buildRegisterRequest({ uri: "https://example.com/file.json" });

        const res = await handleRegisterRequest(req, env, env.fetchImpl);

        expect(res.status).toBe(400);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe("invalid_request");
        expect(bucket.getTotalPutCount()).toBe(0);
        expect(workflow.getCreateBatchCount()).toBe(0);
    });
});
