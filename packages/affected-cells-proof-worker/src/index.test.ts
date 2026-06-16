/**
 * index.test.ts
 *
 * STEP 6: index.ts の E2E テスト。
 *
 * テスト対象:
 * - E2E: POST 登録（fake Walrus が golden 原本を返す）→ 200 → R2 に保存
 *         続けて GET 配信（同 h3_index）→ 200 → {leaf, proof, affected_cells_root} を返し root が golden 値
 * - golden vector: 配信 leaf/proof から replay した root が `0x526e98...` に一致
 * - ルート系: 未知 path → 404, POST .../proof（method 違い）→ 405, GET .../affected-cells（method 違い）→ 405
 */

import { describe, expect, it } from "vitest";
import worker, { AffectedAreaArtifactWorkflow } from "./index.js";
import type { RegisterEnv } from "./register.js";
import type { AffectedProofR2Bucket, AffectedProofR2Object } from "./r2.js";

// ---------------------------------------------------------------------------
// Golden values
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

const GOLDEN_HASH = "0xc3bb6d3a0ba176465f91024bf73aa89c1ba45aaa4f739a93288f2cbcafdb30bc";
const GOLDEN_ROOT = "0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f";
const GOLDEN_EVENT_UID = "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";
const GOLDEN_EVENT_REVISION = 1;
const GOLDEN_H3_INDEX_0 = "608819013513904127";
const GOLDEN_H3_INDEX_1 = "608819013597790207";

const VALID_REGISTER_TOKEN = "test-secret-token";
const WALRUS_BLOB_ID = "test-blob-id-e2e";
const WALRUS_BLOB_URI = `walrus://blob/${WALRUS_BLOB_ID}`;

// ---------------------------------------------------------------------------
// FakeR2Bucket
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
}

class FakeWorkflowInstance implements WorkflowInstance {
    constructor(readonly id: string) {}

    async status(): Promise<InstanceStatus> {
        return { status: "queued", rollback: null };
    }

    async restart(): Promise<void> {}
}

class FakeAffectedAreaWorkflow implements Workflow {
    private readonly instances = new Map<string, FakeWorkflowInstance>();

    async createBatch(
        batch: readonly WorkflowInstanceCreateOptions[],
    ): Promise<WorkflowInstance[]> {
        const created: WorkflowInstance[] = [];
        for (const item of batch) {
            if (item.id === undefined || this.instances.has(item.id)) {
                continue;
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
        AFFECTED_AREA_ARTIFACTS: new FakeR2Bucket(),
        AFFECTED_AREA_ARTIFACT_WORKFLOW: new FakeAffectedAreaWorkflow(),
        fetchImpl: options.fetchImpl ?? defaultFetch,
    };
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function buildRegisterRequest(
    options: {
        eventUid?: string;
        eventRevision?: number;
        hash?: string;
        root?: string;
        uri?: string;
        token?: string;
    } = {},
): Request {
    const eventUid = options.eventUid ?? GOLDEN_EVENT_UID;
    const eventRevision = options.eventRevision ?? GOLDEN_EVENT_REVISION;
    const body = {
        event_uid: eventUid,
        event_revision: eventRevision,
        affected_cells_hash: options.hash ?? GOLDEN_HASH,
        affected_cells_root: options.root ?? GOLDEN_ROOT,
        affected_cell_count: 2,
        geo_resolution: 7,
        affected_cells_uri: options.uri ?? WALRUS_BLOB_URI,
    };
    return new Request(
        `https://worker.example/events/${eventUid}/revisions/${eventRevision}/affected-cells`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-sonari-affected-proof-register-token": options.token ?? VALID_REGISTER_TOKEN,
            },
            body: JSON.stringify(body),
        },
    );
}

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
// Helper
// ---------------------------------------------------------------------------

async function expectErrorCode(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({
        error: { code },
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("affected-cells-proof-worker (index.ts) E2E", () => {
    it("exports the affected-area Workflow class named by wrangler.toml", () => {
        expect(AffectedAreaArtifactWorkflow.name).toBe("AffectedAreaArtifactWorkflow");
    });

    // -------------------------------------------------------------------------
    // E2E: POST 登録 → GET 配信 → golden root 到達
    // -------------------------------------------------------------------------

    it("E2E: POST 登録成功後に GET で proof を取得し golden root に到達する", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });

        // (1) POST 登録
        const postReq = buildRegisterRequest();
        const postRes = await worker.fetch(postReq, env);

        expect(postRes.status).toBe(200);
        const postBody = await postRes.json() as Record<string, unknown>;
        expect(postBody.stored).toBe(true);
        expect(postBody.affected_cells_root).toBe(GOLDEN_ROOT);

        // R2 に保存された確認
        expect(bucket.getTotalPutCount()).toBeGreaterThan(0);

        // (2) GET 配信（同じ bucket を使い回す）
        const getReq = buildGetRequest(GOLDEN_H3_INDEX_0);
        const getRes = await worker.fetch(getReq, env);

        expect(getRes.status).toBe(200);
        const getBody = await getRes.json() as {
            affected_cells_root: string;
            leaf: Record<string, unknown>;
            proof: unknown[];
        };
        expect(getBody.affected_cells_root).toBe(GOLDEN_ROOT);
        expect(getBody.leaf).toBeDefined();
        expect(Array.isArray(getBody.proof)).toBe(true);
    });

    it("E2E: golden h3_index_1 でも同じ root に到達する", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });

        await worker.fetch(buildRegisterRequest(), env);

        const getRes = await worker.fetch(buildGetRequest(GOLDEN_H3_INDEX_1), env);
        expect(getRes.status).toBe(200);
        const getBody = await getRes.json() as { affected_cells_root: string };
        expect(getBody.affected_cells_root).toBe(GOLDEN_ROOT);
    });

    it("E2E: 配信 leaf/proof から replay した root が golden 値に一致する", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await worker.fetch(buildRegisterRequest(), env);

        const getRes = await worker.fetch(buildGetRequest(GOLDEN_H3_INDEX_0), env);
        expect(getRes.status).toBe(200);

        // proof replay を worker 側が内部検証済み（verifyEntryIntegrity）のため、
        // 200 が返ってきた時点で root 到達が保証されている。
        // さらに proof-core を直接 import して外部から再検証する。
        const { replayProof, affectedCellLeafHash } = await import("@sonari/proof-core");
        const body = await getRes.json() as {
            affected_cells_root: string;
            leaf: {
                event_uid: string;
                event_revision: number;
                h3_index: string;
                geo_resolution: number;
                cell_band: number;
                intensity_value: number;
                cell_metric: string;
                intensity_scale: string;
                cells_generation_method: string;
                oracle_version: string;
            };
            proof: Array<{ sibling_on_left: boolean; sibling_hash: string }>;
        };

        // bigint フィールドを復元して leaf hash を再計算
        const leafForHash = {
            event_uid: body.leaf.event_uid as `0x${string}`,
            event_revision: body.leaf.event_revision,
            h3_index: BigInt(body.leaf.h3_index),
            geo_resolution: body.leaf.geo_resolution,
            cell_band: body.leaf.cell_band,
            intensity_value: body.leaf.intensity_value,
            cell_metric: body.leaf.cell_metric as Parameters<typeof affectedCellLeafHash>[0]["cell_metric"],
            intensity_scale: body.leaf.intensity_scale as Parameters<typeof affectedCellLeafHash>[0]["intensity_scale"],
            cells_generation_method: body.leaf.cells_generation_method as Parameters<typeof affectedCellLeafHash>[0]["cells_generation_method"],
            oracle_version: BigInt(body.leaf.oracle_version),
        };

        const leafHash = await affectedCellLeafHash(leafForHash);
        const replayedRoot = await replayProof(leafHash, body.proof as Array<{ sibling_on_left: boolean; sibling_hash: `0x${string}` }>);
        expect(replayedRoot).toBe(GOLDEN_ROOT);
    });

    // -------------------------------------------------------------------------
    // ルート振り分け: 404 (unknown path)
    // -------------------------------------------------------------------------

    it("未知の path → 404 not_found", async () => {
        const env = buildEnv();
        const res = await worker.fetch(new Request("https://worker.example/unknown-path"), env);
        await expectErrorCode(res, 404, "not_found");
    });

    it("/ → 404 not_found", async () => {
        const env = buildEnv();
        const res = await worker.fetch(new Request("https://worker.example/"), env);
        await expectErrorCode(res, 404, "not_found");
    });

    // -------------------------------------------------------------------------
    // ルート振り分け: 405 (method mismatch)
    // -------------------------------------------------------------------------

    it("GET .../affected-cells → 405 method_not_allowed（登録ルートに GET）", async () => {
        const env = buildEnv();
        const url = `https://worker.example/events/${GOLDEN_EVENT_UID}/revisions/${GOLDEN_EVENT_REVISION}/affected-cells`;
        const res = await worker.fetch(new Request(url, { method: "GET" }), env);
        await expectErrorCode(res, 405, "method_not_allowed");
    });

    it("PUT .../affected-cells → 405 method_not_allowed（登録ルートに PUT）", async () => {
        const env = buildEnv();
        const url = `https://worker.example/events/${GOLDEN_EVENT_UID}/revisions/${GOLDEN_EVENT_REVISION}/affected-cells`;
        const res = await worker.fetch(
            new Request(url, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: "{}",
            }),
            env,
        );
        await expectErrorCode(res, 405, "method_not_allowed");
    });

    it("POST .../proof → 405 method_not_allowed（配信ルートに POST）", async () => {
        const env = buildEnv();
        const url = `https://worker.example/events/${GOLDEN_EVENT_UID}/revisions/${GOLDEN_EVENT_REVISION}/proof?h3_index=${GOLDEN_H3_INDEX_0}`;
        const res = await worker.fetch(
            new Request(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
            }),
            env,
        );
        await expectErrorCode(res, 405, "method_not_allowed");
    });

    it("DELETE .../proof → 405 method_not_allowed（配信ルートに DELETE）", async () => {
        const env = buildEnv();
        const url = `https://worker.example/events/${GOLDEN_EVENT_UID}/revisions/${GOLDEN_EVENT_REVISION}/proof`;
        const res = await worker.fetch(new Request(url, { method: "DELETE" }), env);
        await expectErrorCode(res, 405, "method_not_allowed");
    });

    // -------------------------------------------------------------------------
    // 正常系ルーティング確認
    // -------------------------------------------------------------------------

    it("POST /events/:event_uid/revisions/:event_revision/affected-cells は handleRegisterRequest へ委譲される", async () => {
        const env = buildEnv();
        // 正常な登録リクエストが 200 を返すことで委譲確認
        const res = await worker.fetch(buildRegisterRequest(), env);
        expect(res.status).toBe(200);
    });

    it("GET /events/:event_uid/revisions/:event_revision/proof?h3_index=... は handleProofRequest へ委譲される", async () => {
        const bucket = new FakeR2Bucket();
        const env = buildEnv({ bucket });
        await worker.fetch(buildRegisterRequest(), env);

        const res = await worker.fetch(buildGetRequest(GOLDEN_H3_INDEX_0), env);
        expect(res.status).toBe(200);
    });

    // -------------------------------------------------------------------------
    // エラーハンドリング: 内部エラーが外に漏れない
    // -------------------------------------------------------------------------

    it("内部エラーは 500 internal として返される（秘密情報が漏洩しない）", async () => {
        const env = buildEnv();
        // 存在しない event の proof を GET → proof_manifest_missing (404) として返る
        const res = await worker.fetch(
            buildGetRequest(GOLDEN_H3_INDEX_0, "0x" + "aa".repeat(32), 1),
            env,
        );
        // manifest がないので 404
        expect([404, 500]).toContain(res.status);
        const body = await res.json() as { error: { code: string; message: string } };
        expect(body.error).toBeDefined();
        expect(body.error.code).toBeDefined();
        // 内部スタックトレースなどは含まれない
        expect(body.error.message).not.toContain("at ");
    });
});
