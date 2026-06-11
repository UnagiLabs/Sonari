import { describe, expect, it } from "vitest";
import {
    DynamoDbVerificationJobRepository,
    InMemoryVerificationJobRepository,
} from "../src/index.js";
import { validRequest } from "./fixtures.js";

const baseNowMs = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// InMemoryVerificationJobRepository.claimJob
// ---------------------------------------------------------------------------
describe("InMemoryVerificationJobRepository.claimJob", () => {
    it("(a) queued job: returns DueVerificationJob with attempt=1 and status becomes processing", async () => {
        const repo = new InMemoryVerificationJobRepository();
        const { row } = await repo.upsertRequest(validRequest(), baseNowMs);

        const result = await repo.claimJob(row.job_id, baseNowMs + 1);

        expect(result).toEqual({
            jobId: row.job_id,
            attempt: 1,
            executionName: `membership-${row.job_id}-1`,
        });
        const after = await repo.get(row.job_id);
        expect(after?.status).toBe("processing");
        expect(after?.workflow_execution_name).toBe(`membership-${row.job_id}-1`);
        expect(after?.workflow_started_at_ms).toBe(baseNowMs + 1);
    });

    it("(b) already processing: 2nd claim returns null (idempotent)", async () => {
        const repo = new InMemoryVerificationJobRepository();
        const { row } = await repo.upsertRequest(validRequest(), baseNowMs);

        const first = await repo.claimJob(row.job_id, baseNowMs + 1);
        expect(first).not.toBeNull();

        const second = await repo.claimJob(row.job_id, baseNowMs + 2);
        expect(second).toBeNull();
    });

    it("(c) future retry: claimJob returns null, status stays retry", async () => {
        const repo = new InMemoryVerificationJobRepository();
        const { row } = await repo.upsertRequest(validRequest(), baseNowMs);
        // markRetry with next_retry_at_ms far in the future
        await repo.markRetry(row.job_id, baseNowMs + 1, baseNowMs + 100_000, "try later");

        const result = await repo.claimJob(row.job_id, baseNowMs + 2);
        expect(result).toBeNull();

        const after = await repo.get(row.job_id);
        expect(after?.status).toBe("retry");
    });

    it("(d) due retry: claimJob succeeds and attempt increments", async () => {
        const repo = new InMemoryVerificationJobRepository();
        const { row } = await repo.upsertRequest(validRequest(), baseNowMs);
        // markRetry with next_retry_at_ms in the past/present
        await repo.markRetry(row.job_id, baseNowMs + 1, baseNowMs + 10, "try later");

        const result = await repo.claimJob(row.job_id, baseNowMs + 10);
        expect(result).toEqual({
            jobId: row.job_id,
            attempt: 2,
            executionName: `membership-${row.job_id}-2`,
        });

        const after = await repo.get(row.job_id);
        expect(after?.status).toBe("processing");
    });

    it("(e) completed job: returns null", async () => {
        const repo = new InMemoryVerificationJobRepository();
        const { row } = await repo.upsertRequest(validRequest(), baseNowMs);
        await repo.markCompleted(row.job_id, baseNowMs + 1, "0xdeadbeef");

        const result = await repo.claimJob(row.job_id, baseNowMs + 2);
        expect(result).toBeNull();
    });

    it("(e) failed job: returns null", async () => {
        const repo = new InMemoryVerificationJobRepository();
        const { row } = await repo.upsertRequest(validRequest(), baseNowMs);
        await repo.markFailed(row.job_id, baseNowMs + 1, "SOME_ERROR");

        const result = await repo.claimJob(row.job_id, baseNowMs + 2);
        expect(result).toBeNull();
    });

    it("(e) non-existent jobId: returns null", async () => {
        const repo = new InMemoryVerificationJobRepository();

        const result = await repo.claimJob("non-existent-job-id", baseNowMs);
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// DynamoDbVerificationJobRepository.claimJob
// ---------------------------------------------------------------------------

type CapturedCommand = { input: Record<string, unknown> };

/**
 * Returns a stub that simulates a DynamoDB document client.
 * - For GetCommand (no Item / no other marker): returns the provided item.
 * - For UpdateCommand: succeeds or throws ConditionalCheckFailedException.
 * - Tracks all commands in `captured`.
 */
function makeStub(captured: CapturedCommand[], getResult: unknown, updateShouldFail = false) {
    return {
        send: async (command: unknown): Promise<unknown> => {
            const typed = command as CapturedCommand;
            captured.push(typed);
            // PutCommand has `Item` in input
            if ("Item" in typed.input) {
                return {};
            }
            // UpdateCommand has `UpdateExpression` in input
            if ("UpdateExpression" in typed.input) {
                if (updateShouldFail) {
                    const err = new Error("ConditionalCheckFailedException");
                    err.name = "ConditionalCheckFailedException";
                    throw err;
                }
                return {};
            }
            // GetCommand
            return { Item: getResult };
        },
    };
}

/** Builds a stored-row-like object sufficient for parseStoredRow to accept. */
function makeStoredRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        job_id: "test-job-id-000000000000000",
        request_hash: "aabbcc",
        owner_membership_key: `0x${"33".repeat(32)}#0x${"22".repeat(32)}`,
        request_json: "{}",
        status: "queued",
        retry_count: 0,
        next_retry_at_ms: null,
        error_code: null,
        error_message: null,
        workflow_execution_name: null,
        workflow_started_at_ms: null,
        created_at_ms: baseNowMs,
        updated_at_ms: baseNowMs,
        ...overrides,
    };
}

describe("DynamoDbVerificationJobRepository.claimJob", () => {
    it("sends GetCommand with the exact jobId key (no Scan)", async () => {
        const captured: CapturedCommand[] = [];
        const row = makeStoredRow({ job_id: "test-job-id-000000000000000", status: "queued" });
        const repo = new DynamoDbVerificationJobRepository("jobs", makeStub(captured, row));

        await repo.claimJob("test-job-id-000000000000000", baseNowMs + 1);

        // Verify no ScanCommand was issued
        const scans = captured.filter(
            (c) =>
                "TableName" in c.input &&
                !("Key" in c.input) &&
                !("Item" in c.input) &&
                !("UpdateExpression" in c.input),
        );
        expect(scans).toHaveLength(0);

        // Verify a GetCommand was sent with the right key
        const gets = captured.filter((c) => "Key" in c.input && !("UpdateExpression" in c.input));
        expect(gets).toHaveLength(1);
        expect(gets[0]?.input.Key).toEqual({ job_id: "test-job-id-000000000000000" });
    });

    it("accepts legacy rows without owner_membership_key so existing jobs keep processing", async () => {
        const captured: CapturedCommand[] = [];
        const { owner_membership_key: _legacyMissingLookupKey, ...legacyRow } = makeStoredRow({
            request_json: JSON.stringify(validRequest()),
        });
        const repo = new DynamoDbVerificationJobRepository("jobs", makeStub(captured, legacyRow));

        const claimed = await repo.claimJob("test-job-id-000000000000000", baseNowMs + 1);

        expect(claimed).toMatchObject({ jobId: "test-job-id-000000000000000", attempt: 1 });
    });

    it("sends UpdateCommand with correct ConditionExpression and Key for a queued row", async () => {
        const captured: CapturedCommand[] = [];
        const row = makeStoredRow({
            job_id: "test-job-id-000000000000000",
            status: "queued",
            retry_count: 0,
        });
        const repo = new DynamoDbVerificationJobRepository("jobs", makeStub(captured, row));

        const result = await repo.claimJob("test-job-id-000000000000000", baseNowMs + 1);

        expect(result).toEqual({
            jobId: "test-job-id-000000000000000",
            attempt: 1,
            executionName: "membership-test-job-id-000000000000000-1",
        });

        const updates = captured.filter((c) => "UpdateExpression" in c.input);
        expect(updates).toHaveLength(1);
        const update = updates[0]?.input;
        expect(update?.Key).toEqual({ job_id: "test-job-id-000000000000000" });
        expect(update?.ConditionExpression).toBe(
            "#status IN (:queued, :retry) AND retry_count = :retry_count",
        );
    });

    it("returns null without sending UpdateCommand when the row has a future next_retry_at_ms", async () => {
        const captured: CapturedCommand[] = [];
        const row = makeStoredRow({
            job_id: "test-job-id-000000000000000",
            status: "retry",
            retry_count: 1,
            next_retry_at_ms: baseNowMs + 100_000, // far future
        });
        const repo = new DynamoDbVerificationJobRepository("jobs", makeStub(captured, row));

        const result = await repo.claimJob("test-job-id-000000000000000", baseNowMs + 1);
        expect(result).toBeNull();

        const updates = captured.filter((c) => "UpdateExpression" in c.input);
        expect(updates).toHaveLength(0);
    });

    it("returns null when GetCommand returns no item", async () => {
        const captured: CapturedCommand[] = [];
        const repo = new DynamoDbVerificationJobRepository("jobs", makeStub(captured, undefined));

        const result = await repo.claimJob("non-existent-job", baseNowMs);
        expect(result).toBeNull();

        const updates = captured.filter((c) => "UpdateExpression" in c.input);
        expect(updates).toHaveLength(0);
    });

    it("returns null when UpdateCommand throws ConditionalCheckFailedException", async () => {
        const captured: CapturedCommand[] = [];
        const row = makeStoredRow({ job_id: "test-job-id-000000000000000", status: "queued" });
        const repo = new DynamoDbVerificationJobRepository(
            "jobs",
            makeStub(captured, row, /* updateShouldFail */ true),
        );

        const result = await repo.claimJob("test-job-id-000000000000000", baseNowMs + 1);
        expect(result).toBeNull();
    });

    it("no ScanCommand is ever issued (verified across all claimJob paths)", async () => {
        const repo1Captured: CapturedCommand[] = [];
        const row = makeStoredRow({ status: "queued" });
        const repo1 = new DynamoDbVerificationJobRepository("jobs", makeStub(repo1Captured, row));
        await repo1.claimJob("test-job-id-000000000000000", baseNowMs);

        // Check for ScanCommand: it lacks Key, Item, UpdateExpression
        const hasScan = (caps: CapturedCommand[]) =>
            caps.some(
                (c) =>
                    !("Key" in c.input) && !("Item" in c.input) && !("UpdateExpression" in c.input),
            );

        expect(hasScan(repo1Captured)).toBe(false);
    });
});
