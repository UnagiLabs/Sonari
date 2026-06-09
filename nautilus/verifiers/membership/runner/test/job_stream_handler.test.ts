import { describe, expect, it } from "vitest";
import {
    createJobStreamHandler,
    DEFAULT_RETRY_BACKOFF_MS,
    type DynamoDbStreamEvent,
    type DynamoDbStreamRecord,
    InMemoryVerificationJobRepository,
    type JobStreamHandlerOptions,
    type WorkflowStarter,
} from "../src/index.js";
import { validRequest } from "./fixtures.js";

const baseNowMs = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class RecordingWorkflowStarter implements WorkflowStarter {
    readonly starts: Array<{ jobId: string; executionName: string; attempt: number }> = [];

    async start(input: { jobId: string; executionName: string; attempt: number }): Promise<void> {
        this.starts.push(input);
    }
}

class FailingWorkflowStarter implements WorkflowStarter {
    constructor(private readonly errorName?: string) {}

    async start(): Promise<void> {
        const err = new Error("workflow start failed");
        if (this.errorName !== undefined) {
            err.name = this.errorName;
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Helpers to build DynamoDB Streams records
// ---------------------------------------------------------------------------

function makeInsertRecord(jobId: string): DynamoDbStreamRecord {
    return {
        eventName: "INSERT",
        dynamodb: {
            NewImage: {
                job_id: { S: jobId },
            },
        },
    };
}

function makeModifyRecord(jobId: string): DynamoDbStreamRecord {
    return {
        eventName: "MODIFY",
        dynamodb: {
            NewImage: {
                job_id: { S: jobId },
            },
        },
    };
}

function makeRemoveRecord(jobId: string): DynamoDbStreamRecord {
    return {
        eventName: "REMOVE",
        dynamodb: {
            Keys: {
                job_id: { S: jobId },
            },
        },
    };
}

function makeStreamEvent(records: DynamoDbStreamRecord[]): DynamoDbStreamEvent {
    return { Records: records };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createJobStreamHandler", () => {
    // (a) queued 行の INSERT レコード 1 件で workflow.start が 1 回呼ばれ、
    //     戻り値 workflow_started===1。job は processing。
    it("(a) queued job INSERT: starts workflow once and returns workflow_started=1", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new RecordingWorkflowStarter();
        const { row } = await repository.upsertRequest(validRequest(), baseNowMs);

        const options: JobStreamHandlerOptions = {
            repository,
            workflow,
            now: () => baseNowMs + 1,
        };
        const handler = createJobStreamHandler(options);

        const event = makeStreamEvent([makeInsertRecord(row.job_id)]);
        const result = await handler(event);

        expect(result.workflow_started).toBe(1);
        expect(workflow.starts).toHaveLength(1);
        expect(workflow.starts[0]).toEqual({
            jobId: row.job_id,
            executionName: `membership-${row.job_id}-1`,
            attempt: 1,
        });

        const after = await repository.get(row.job_id);
        expect(after?.status).toBe("processing");
    });

    // (b) 同じ job_id を 2 レコード含む event で start は 1 回だけ（claim 冪等）
    it("(b) duplicate records for same job_id: starts workflow only once (claim idempotency)", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new RecordingWorkflowStarter();
        const { row } = await repository.upsertRequest(validRequest(), baseNowMs);

        const options: JobStreamHandlerOptions = {
            repository,
            workflow,
            now: () => baseNowMs + 1,
        };
        const handler = createJobStreamHandler(options);

        // 同じ job_id を 2 回含むイベント
        const event = makeStreamEvent([makeInsertRecord(row.job_id), makeModifyRecord(row.job_id)]);
        const result = await handler(event);

        expect(result.workflow_started).toBe(1);
        expect(workflow.starts).toHaveLength(1);
    });

    // (c) 未来 retry の job（upsert 後 markRetry で未来時刻）を指す MODIFY レコードでは
    //     start されない（workflow_started===0、status は retry）
    it("(c) future retry job: does not start workflow (workflow_started=0)", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new RecordingWorkflowStarter();
        const { row } = await repository.upsertRequest(validRequest(), baseNowMs);
        // 未来時刻の next_retry_at_ms でリトライ設定
        await repository.markRetry(row.job_id, baseNowMs + 1, baseNowMs + 100_000, "try later");

        const options: JobStreamHandlerOptions = {
            repository,
            workflow,
            now: () => baseNowMs + 2, // next_retry_at_ms (baseNowMs+100_000) より前
        };
        const handler = createJobStreamHandler(options);

        const event = makeStreamEvent([makeModifyRecord(row.job_id)]);
        const result = await handler(event);

        expect(result.workflow_started).toBe(0);
        expect(workflow.starts).toHaveLength(0);

        const after = await repository.get(row.job_id);
        expect(after?.status).toBe("retry");
    });

    // (d) start が ExecutionAlreadyExists を投げても、markRetry されず
    //     （status は processing・retry_count 不変）、workflow_started===1
    it("(d) ExecutionAlreadyExists: treated as success, no markRetry, workflow_started=1", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new FailingWorkflowStarter("ExecutionAlreadyExists");
        const { row } = await repository.upsertRequest(validRequest(), baseNowMs);

        const options: JobStreamHandlerOptions = {
            repository,
            workflow,
            now: () => baseNowMs + 1,
        };
        const handler = createJobStreamHandler(options);

        const event = makeStreamEvent([makeInsertRecord(row.job_id)]);
        const result = await handler(event);

        expect(result.workflow_started).toBe(1);

        // markRetry が呼ばれていないこと（status は processing のまま・retry_count は変化なし）
        const after = await repository.get(row.job_id);
        expect(after?.status).toBe("processing");
        expect(after?.retry_count).toBe(0);
    });

    // (e) start が他の例外を投げると markRetry され
    //     （status retry, retry_count 増, next_retry_at_ms===nowMs+DEFAULT_RETRY_BACKOFF_MS）、
    //     workflow_started===0
    it("(e) other exception from start: markRetry called, workflow_started=0", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new FailingWorkflowStarter(); // errorName undefined → 汎用エラー
        const { row } = await repository.upsertRequest(validRequest(), baseNowMs);

        const nowMs = baseNowMs + 1;
        const options: JobStreamHandlerOptions = {
            repository,
            workflow,
            now: () => nowMs,
        };
        const handler = createJobStreamHandler(options);

        const event = makeStreamEvent([makeInsertRecord(row.job_id)]);
        const result = await handler(event);

        expect(result.workflow_started).toBe(0);

        const after = await repository.get(row.job_id);
        expect(after?.status).toBe("retry");
        expect(after?.retry_count).toBe(1);
        expect(after?.next_retry_at_ms).toBe(nowMs + DEFAULT_RETRY_BACKOFF_MS);
    });

    // (f) job_id 抽出不能な不正レコード（NewImage 無し / job_id 無し / Keys のみ等）と
    //     REMOVE レコードを含んでも throw せず skip し、有効レコードは処理される
    it("(f) invalid and REMOVE records are skipped without throwing; valid records are processed", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new RecordingWorkflowStarter();
        const { row } = await repository.upsertRequest(validRequest(), baseNowMs);

        const options: JobStreamHandlerOptions = {
            repository,
            workflow,
            now: () => baseNowMs + 1,
        };
        const handler = createJobStreamHandler(options);

        const event = makeStreamEvent([
            // NewImage なし
            { eventName: "INSERT", dynamodb: {} },
            // NewImage に job_id なし
            { eventName: "INSERT", dynamodb: { NewImage: {} } },
            // job_id.S が空文字
            { eventName: "INSERT", dynamodb: { NewImage: { job_id: { S: "" } } } },
            // REMOVE レコード（NewImage なし、Keys のみ）
            makeRemoveRecord(row.job_id),
            // dynamodb フィールド自体なし
            { eventName: "INSERT" },
            // 有効な INSERT レコード
            makeInsertRecord(row.job_id),
        ]);

        await expect(handler(event)).resolves.not.toThrow();
        const result = await handler(makeStreamEvent([])); // reset check: empty event returns 0
        expect(result.workflow_started).toBe(0);

        // 有効レコードが処理されていることを独立して確認
        const repository2 = new InMemoryVerificationJobRepository();
        const workflow2 = new RecordingWorkflowStarter();
        const { row: row2 } = await repository2.upsertRequest(validRequest(), baseNowMs);
        const handler2 = createJobStreamHandler({
            repository: repository2,
            workflow: workflow2,
            now: () => baseNowMs + 1,
        });
        const result2 = await handler2(
            makeStreamEvent([
                { eventName: "INSERT", dynamodb: {} }, // 不正
                makeInsertRecord(row2.job_id), // 有効
                makeRemoveRecord(row2.job_id), // REMOVE (job が processing なので claimJob は null)
            ]),
        );
        expect(result2.workflow_started).toBe(1);
        expect(workflow2.starts).toHaveLength(1);
    });

    // 追加: 空の Records でも workflow_started=0 を返す
    it("empty Records array: returns workflow_started=0", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createJobStreamHandler({
            repository,
            workflow,
            now: () => baseNowMs,
        });

        await expect(handler({})).resolves.toEqual({ workflow_started: 0 });
        await expect(handler({ Records: [] })).resolves.toEqual({ workflow_started: 0 });
    });
});
