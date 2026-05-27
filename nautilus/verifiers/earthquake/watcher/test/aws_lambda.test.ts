import { describe, expect, it } from "vitest";
import { BCS_ENUMS, type TeeCoreResult } from "@sonari/earthquake-shared";
import {
    buildEarthquakeVerifierRequest,
    createDefaultScheduledHandlerFromEnv,
    createManualHandler,
    createScheduledHandler,
    DAY_MS,
    HOUR_MS,
    DynamoDbStateRepository,
    InMemoryStateRepository,
    parseUsgsRecentFeed,
    startDueWorkflows,
    type EarthquakeEventRow,
    type WorkflowStarter,
} from "../src/index.js";
import type { UsgsEarthquakeCandidate } from "../src/usgs.js";

const baseNow = 1_800_000_000_000;
const manualAuthToken = ["manual", "test", "token"].join("-");
const passthroughSourceEventIdResolver = async ({ sourceEventId }: { sourceEventId: string }) => ({
    source_event_id: sourceEventId,
});

function candidate(
    sourceEventId: string,
    patch: Partial<UsgsEarthquakeCandidate> = {},
): UsgsEarthquakeCandidate {
    return {
        source_event_id: sourceEventId,
        occurred_at_ms: baseNow - 25 * 60 * 60 * 1000,
        source_updated_at_ms: baseNow - 60 * 60 * 1000,
        magnitude: 5.6,
        summary_mmi: null,
        alert: null,
        tsunami: false,
        ...patch,
    };
}

class RecordingWorkflowStarter implements WorkflowStarter {
    readonly starts: Array<{ sourceEventId: string; executionName: string }> = [];

    async start(input: { sourceEventId: string; executionName: string; attempt?: number }): Promise<void> {
        this.starts.push(input);
    }
}

class FailingWorkflowStarter implements WorkflowStarter {
    async start(): Promise<void> {
        throw new Error("Step Functions unavailable");
    }
}

describe("AWS Lambda watcher handlers", () => {
    it("stores recent USGS candidates and starts workflows only for eligible due events", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createScheduledHandler({
            repository,
            workflow,
            now: () => baseNow,
            resolveSourceEventId: passthroughSourceEventIdResolver,
            fetchCandidates: async () => [
                candidate("us7000eligible"),
                candidate("us7000small", { magnitude: 5.1 }),
            ],
        });

        const result = await handler();

        expect(result).toEqual({ scanned: 2, workflow_started: 1 });
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000eligible",
                executionName: "earthquake-us7000eligible-1",
                attempt: 1,
            },
        ]);
        await expect(repository.get("us7000small")).resolves.toMatchObject({
            status: "ignored_small",
            error_code: "WATCHER_BELOW_AUTO_THRESHOLD",
        });
    });

    it("skips malformed scheduled source event IDs before storing or starting workflows", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createScheduledHandler({
            repository,
            workflow,
            now: () => baseNow,
            resolveSourceEventId: passthroughSourceEventIdResolver,
            fetchCandidates: async () => [
                candidate("__sonari_runner_workflow_lock__"),
                candidate("us7000/bad"),
                candidate("us7000eligible"),
            ],
        });

        const result = await handler();

        expect(result).toEqual({ scanned: 3, workflow_started: 1 });
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000eligible",
                executionName: "earthquake-us7000eligible-1",
                attempt: 1,
            },
        ]);
        await expect(repository.get("__sonari_runner_workflow_lock__")).resolves.toBeNull();
        await expect(repository.get("us7000/bad")).resolves.toBeNull();
    });

    it("resolves scheduled candidate aliases before deduping and enqueueing", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createScheduledHandler({
            repository,
            workflow,
            now: () => baseNow,
            fetchCandidates: async () => [
                candidate("usc0001xgp"),
                candidate("official20110311054624120_30"),
            ],
            resolveSourceEventId: async ({ sourceEventId }) =>
                sourceEventId === "usc0001xgp"
                    ? {
                          source_event_id: "official20110311054624120_30",
                          requested_source_event_id: "usc0001xgp",
                      }
                    : { source_event_id: sourceEventId },
        });

        const result = await handler();

        expect(result).toEqual({ scanned: 2, workflow_started: 1 });
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "official20110311054624120_30",
                executionName: "earthquake-official20110311054624120_30-1",
                attempt: 1,
            },
        ]);
        await expect(repository.get("usc0001xgp")).resolves.toBeNull();
        await expect(repository.get("official20110311054624120_30")).resolves.toMatchObject({
            requested_source_event_id: "usc0001xgp",
        });
    });

    it("skips source ID resolution for scheduled candidates below the auto threshold", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const resolverInputs: unknown[] = [];
        const handler = createScheduledHandler({
            repository,
            workflow,
            now: () => baseNow,
            fetchCandidates: async () => [
                candidate("us7000small", { magnitude: 5.1 }),
                candidate("usc0001xgp", { magnitude: 6 }),
            ],
            resolveSourceEventId: async (input) => {
                resolverInputs.push(input);
                return input.sourceEventId === "usc0001xgp"
                    ? {
                          source_event_id: "official20110311054624120_30",
                          requested_source_event_id: "usc0001xgp",
                      }
                    : { source_event_id: input.sourceEventId };
            },
        });

        const result = await handler();

        expect(result).toEqual({ scanned: 2, workflow_started: 1 });
        expect(resolverInputs).toEqual([{ sourceEventId: "usc0001xgp" }]);
        await expect(repository.get("us7000small")).resolves.toMatchObject({
            status: "ignored_small",
            error_code: "WATCHER_BELOW_AUTO_THRESHOLD",
        });
        await expect(repository.get("official20110311054624120_30")).resolves.toMatchObject({
            requested_source_event_id: "usc0001xgp",
        });
    });

    it("does not pass feed-provided detail URLs to scheduled source ID resolution", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const resolverInputs: unknown[] = [];
        const handler = createScheduledHandler({
            repository,
            workflow,
            now: () => baseNow,
            fetchCandidates: async () =>
                parseUsgsRecentFeed({
                    features: [
                        {
                            id: "usc0001xgp",
                            properties: {
                                time: baseNow - 25 * 60 * 60 * 1000,
                                updated: baseNow - 60 * 60 * 1000,
                                type: "earthquake",
                                detail: "http://169.254.169.254/latest/meta-data",
                                mag: 6,
                                mmi: null,
                                alert: null,
                                tsunami: 0,
                            },
                        },
                    ],
                }),
            resolveSourceEventId: async (input) => {
                resolverInputs.push(input);
                return {
                    source_event_id: input.sourceEventId,
                };
            },
        });

        await handler();

        expect(resolverInputs).toEqual([{ sourceEventId: "usc0001xgp" }]);
    });

    it("does not store or enqueue scheduled candidates when source ID resolution is unavailable", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createScheduledHandler({
            repository,
            workflow,
            now: () => baseNow,
            fetchCandidates: async () => [candidate("usc0001xgp", { magnitude: 6 })],
            resolveSourceEventId: async ({ sourceEventId }) => ({
                unavailable: true,
                source_event_id: sourceEventId,
                error_code: "USGS_DETAIL_UNAVAILABLE",
            }),
        });

        const result = await handler();

        expect(result).toEqual({ scanned: 1, workflow_started: 0 });
        expect(workflow.starts).toEqual([]);
        await expect(repository.get("usc0001xgp")).resolves.toBeNull();
    });

    it("defers scheduled candidates that are less than 24 hours old", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const occurredAtMs = baseNow - 23 * HOUR_MS;
        const handler = createScheduledHandler({
            repository,
            workflow,
            now: () => baseNow,
            resolveSourceEventId: passthroughSourceEventIdResolver,
            fetchCandidates: async () => [
                candidate("us7000fresh", {
                    occurred_at_ms: occurredAtMs,
                    source_updated_at_ms: baseNow,
                }),
            ],
        });

        const result = await handler();

        expect(result).toEqual({ scanned: 1, workflow_started: 0 });
        expect(workflow.starts).toEqual([]);
        await expect(repository.get("us7000fresh")).resolves.toMatchObject({
            status: "new",
            next_retry_at_ms: occurredAtMs + DAY_MS,
        });
    });

    it("default scheduled handler starts Step Functions executions for due events", async () => {
        const repository = new InMemoryStateRepository();
        const commands: unknown[] = [];
        const handler = createDefaultScheduledHandlerFromEnv(
            {
                EVENTS_TABLE_NAME: "events",
                RUNNER_STATE_MACHINE_ARN: "arn:aws:states:runner",
            },
            {
                repository,
                fetchCandidates: async () => [candidate("us7000default")],
                now: () => baseNow,
                resolveSourceEventId: passthroughSourceEventIdResolver,
                sfnClient: {
                    async send(command: unknown): Promise<void> {
                        commands.push(command);
                    },
                },
            },
        );

        const result = await handler();

        expect(result).toEqual({ scanned: 1, workflow_started: 1 });
        expect(commands).toHaveLength(1);
        expect(readCommandInput(commands[0])).toMatchObject({
            stateMachineArn: "arn:aws:states:runner",
            name: "earthquake-us7000default-1",
        });
        expect(JSON.parse(String(readCommandInput(commands[0]).input))).toEqual({
            source_event_id: "us7000default",
            attempt: 1,
        });
    });

    it("rejects manual submissions without the configured bearer token", async () => {
        const handler = createManualHandler({
            repository: new InMemoryStateRepository(),
            workflow: new RecordingWorkflowStarter(),
            now: () => baseNow,
            token: manualAuthToken,
        });

        const response = await handler({
            headers: { authorization: "Bearer wrong" },
            body: JSON.stringify({ source_event_id: "us7000manual" }),
        });

        expect(response.statusCode).toBe(401);
    });

    it("accepts manual submissions and starts a workflow immediately", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createManualHandler({
            repository,
            workflow,
            now: () => baseNow,
            token: manualAuthToken,
            resolveSourceEventId: passthroughSourceEventIdResolver,
        });

        const response = await handler({
            headers: { authorization: `Bearer ${manualAuthToken}` },
            body: JSON.stringify({ source_event_id: "us7000manual" }),
        });

        expect(response.statusCode).toBe(200);
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000manual",
                executionName: "earthquake-us7000manual-1",
                attempt: 1,
            },
        ]);
        await expect(repository.get("us7000manual")).resolves.toMatchObject({ status: "processing" });
    });

    it("resolves manual USGS aliases to canonical source event IDs before starting work", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createManualHandler({
            repository,
            workflow,
            now: () => baseNow,
            token: manualAuthToken,
            resolveSourceEventId: async ({ sourceEventId }) => ({
                source_event_id: "official20110311054624120_30",
                requested_source_event_id: sourceEventId,
            }),
        });

        const response = await handler({
            headers: { authorization: `Bearer ${manualAuthToken}` },
            body: JSON.stringify({ source_event_id: "usc0001xgp" }),
        });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({
            ok: true,
            workflow_started: 1,
            source_event_id: "official20110311054624120_30",
            requested_source_event_id: "usc0001xgp",
        });
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "official20110311054624120_30",
                executionName: "earthquake-official20110311054624120_30-1",
                attempt: 1,
            },
        ]);
        await expect(repository.get("usc0001xgp")).resolves.toBeNull();
        await expect(repository.get("official20110311054624120_30")).resolves.toMatchObject({
            status: "processing",
            requested_source_event_id: "usc0001xgp",
        });
    });

    it("rejects manual submissions when USGS detail resolution is unavailable", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createManualHandler({
            repository,
            workflow,
            now: () => baseNow,
            token: manualAuthToken,
            resolveSourceEventId: async ({ sourceEventId }) => ({
                unavailable: true,
                source_event_id: sourceEventId,
                error_code: "USGS_DETAIL_UNAVAILABLE",
            }),
        });

        const response = await handler({
            headers: { authorization: `Bearer ${manualAuthToken}` },
            body: JSON.stringify({ source_event_id: "usc0001xgp" }),
        });

        expect(response.statusCode).toBe(503);
        expect(JSON.parse(response.body)).toEqual({
            ok: false,
            message: "USGS detail unavailable; retry later",
        });
        expect(workflow.starts).toEqual([]);
        await expect(repository.get("usc0001xgp")).resolves.toBeNull();
    });

    it("manual submissions clear retry backoff and rerun existing failed or pending events", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createManualHandler({
            repository,
            workflow,
            now: () => baseNow + 4_000,
            token: manualAuthToken,
            resolveSourceEventId: passthroughSourceEventIdResolver,
        });

        await repository.upsertManualEvent("us7000failed", baseNow);
        await repository.markWorkflowStarted(
            "us7000failed",
            "earthquake-us7000failed-1",
            baseNow + 1_000,
        );
        await repository.markFailed(
            "us7000failed",
            "AWS_RUNNER_TIMEOUT",
            baseNow + 2_000,
            baseNow + HOUR_MS,
            "timed out",
            1,
        );

        const failedResponse = await handler({
            headers: { authorization: `Bearer ${manualAuthToken}` },
            body: JSON.stringify({ source_event_id: "us7000failed" }),
        });

        expect(failedResponse.statusCode).toBe(200);
        expect(JSON.parse(failedResponse.body)).toMatchObject({ workflow_started: 1 });
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000failed",
                executionName: "earthquake-us7000failed-2",
                attempt: 2,
            },
        ]);

        const pendingRepository = new InMemoryStateRepository();
        const pendingWorkflow = new RecordingWorkflowStarter();
        const pendingHandler = createManualHandler({
            repository: pendingRepository,
            workflow: pendingWorkflow,
            now: () => baseNow + 4_000,
            token: manualAuthToken,
            resolveSourceEventId: passthroughSourceEventIdResolver,
        });

        await pendingRepository.upsertManualEvent("us7000pending", baseNow);
        await pendingRepository.markWorkflowStarted(
            "us7000pending",
            "earthquake-us7000pending-1",
            baseNow + 1_000,
        );
        await pendingRepository.applyRunnerResult(
            "us7000pending",
            pendingSourceResult("us7000pending"),
            baseNow + 2_000,
            baseNow + HOUR_MS,
            1,
        );
        await pendingRepository.markWorkflowStopped("us7000pending", 1, baseNow + 3_000);

        const pendingResponse = await pendingHandler({
            headers: { authorization: `Bearer ${manualAuthToken}` },
            body: JSON.stringify({ source_event_id: "us7000pending" }),
        });

        expect(pendingResponse.statusCode).toBe(200);
        expect(JSON.parse(pendingResponse.body)).toMatchObject({ workflow_started: 1 });
        expect(pendingWorkflow.starts).toEqual([
            {
                sourceEventId: "us7000pending",
                executionName: "earthquake-us7000pending-2",
                attempt: 2,
            },
        ]);
    });

    it("rejects malformed manual source event IDs before enqueueing runner work", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createManualHandler({
            repository,
            workflow,
            now: () => baseNow,
            token: manualAuthToken,
        });

        for (const sourceEventId of ["", "us7000$(touch bad)", "us7000/bad"]) {
            const response = await handler({
                headers: { authorization: `Bearer ${manualAuthToken}` },
                body: JSON.stringify({ source_event_id: sourceEventId }),
            });

            expect(response.statusCode).toBe(400);
        }
        expect(workflow.starts).toEqual([]);
    });

    it("builds the minimal TEE request without trusting summary fields", () => {
        expect(buildEarthquakeVerifierRequest("us7000sonari")).toEqual({
            source_event_id: "us7000sonari",
            hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
            primary_source: BCS_ENUMS.primarySource.USGS,
            geo_resolution: 7,
        });
    });
});

describe("DynamoDB-compatible repository behavior", () => {
    it("updates existing events idempotently and preserves terminal finalized rows", async () => {
        const repository = new InMemoryStateRepository();

        await repository.upsertCandidate(candidate("us7000sonari"), baseNow);
        await repository.applyRunnerResult("us7000sonari", finalizedResult(), baseNow + 1_000);
        await repository.upsertCandidate(
            candidate("us7000sonari", { source_updated_at_ms: baseNow + 2_000 }),
            baseNow + 2_000,
        );

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "finalized",
            source_updated_at_ms: baseNow,
            payload_bcs_hex: "0x01",
        });
    });

    it("preserves accepted new rows when a later summary drops below screening threshold", async () => {
        const memoryRepository = new InMemoryStateRepository();
        await memoryRepository.upsertCandidate(candidate("us7000accepted"), baseNow);
        await memoryRepository.upsertCandidate(
            candidate("us7000accepted", {
                magnitude: 5.1,
                source_updated_at_ms: baseNow + 1_000,
            }),
            baseNow + 1_000,
        );

        await expect(memoryRepository.get("us7000accepted")).resolves.toMatchObject({
            status: "new",
            error_code: null,
            source_updated_at_ms: baseNow + 1_000,
        });

        const acceptedRow = await eventRow("us7000accepted", {
            status: "new",
            error_code: null,
        });
        const client = new StaleReadRaceClient(acceptedRow, acceptedRow);
        const dynamoRepository = new DynamoDbStateRepository("events", client);

        await dynamoRepository.upsertCandidate(
            candidate("us7000accepted", {
                magnitude: 5.1,
                source_updated_at_ms: baseNow + 2_000,
            }),
            baseNow + 2_000,
        );

        expect(client.currentRow).toMatchObject({
            status: "new",
            error_code: null,
            source_updated_at_ms: baseNow + 2_000,
        });
    });

    it("clears the ignored-small error when in-memory rows are promoted to new", async () => {
        const promotedBySummary = new InMemoryStateRepository();
        await promotedBySummary.upsertCandidate(
            candidate("us7000promoted", { magnitude: 5.1 }),
            baseNow,
        );
        await promotedBySummary.upsertCandidate(
            candidate("us7000promoted", {
                magnitude: 5.6,
                source_updated_at_ms: baseNow + 1_000,
            }),
            baseNow + 1_000,
        );

        await expect(promotedBySummary.get("us7000promoted")).resolves.toMatchObject({
            status: "new",
            error_code: null,
        });

        const promotedByManualBypass = new InMemoryStateRepository();
        await promotedByManualBypass.upsertCandidate(
            candidate("us7000manual", { magnitude: 5.1 }),
            baseNow,
        );
        await promotedByManualBypass.upsertManualEvent("us7000manual", baseNow + 1_000);

        await expect(promotedByManualBypass.get("us7000manual")).resolves.toMatchObject({
            status: "new",
            error_code: null,
        });
    });

    it("clears DynamoDB retry backoff for manual reruns of failed and pending events", async () => {
        for (const row of [
            await eventRow("us7000failed", {
                status: "failed",
                retry_count: 1,
                next_retry_at_ms: baseNow + HOUR_MS,
                error_code: "AWS_RUNNER_TIMEOUT",
            }),
            await eventRow("us7000pending", {
                status: "pending_source",
                retry_count: 1,
                next_retry_at_ms: baseNow + HOUR_MS,
                error_code: "USGS_DETAIL_UNAVAILABLE",
            }),
        ]) {
            const client = new StaleReadRaceClient(row, row);
            const repository = new DynamoDbStateRepository("events", client);

            await repository.upsertManualEvent(row.source_event_id, baseNow + 4_000);

            expect(client.currentRow).toMatchObject({
                status: row.status,
                retry_count: 1,
                next_retry_at_ms: null,
                last_seen_at_ms: baseNow + 4_000,
                source_updated_at_ms: baseNow + 4_000,
            });
        }
    });

    it("paginates DynamoDB scans before filtering and applying the due limit", async () => {
        const firstPageRows = [
            await eventRow("us7000done", {
                status: "finalized",
                updated_at_ms: baseNow - 30_000,
            }),
            await eventRow("us7000later", {
                status: "failed",
                next_retry_at_ms: baseNow + 60_000,
                updated_at_ms: baseNow - 20_000,
            }),
        ];
        const secondPageRows = [
            await eventRow("us7000due2", { updated_at_ms: baseNow - 10_000 }),
            await eventRow("us7000due1", { updated_at_ms: baseNow - 40_000 }),
        ];
        const client = new PaginatedScanClient([firstPageRows, secondPageRows]);
        const repository = new DynamoDbStateRepository("events", client);

        const due = await repository.listDue(baseNow, 1);

        expect(due.map((row) => row.source_event_id)).toEqual(["us7000due1"]);
        expect(client.scanInputs).toHaveLength(2);
        expect(client.scanInputs[0]).not.toHaveProperty("Limit");
        expect(client.scanInputs[1]).toMatchObject({ ExclusiveStartKey: { source_event_id: "page-1" } });
    });

    it("preserves finalized DynamoDB result fields when watcher upsert races a stale read", async () => {
        const staleProcessingRow = await eventRow("us7000race", {
            status: "processing",
            runner_job_id: "earthquake-us7000race-1",
            runner_attempt: 1,
            runner_phase: "applying_result",
        });
        const finalizedRow = {
            ...staleProcessingRow,
            status: "finalized" as const,
            tee_result_json: JSON.stringify(finalizedResult()),
            payload_bcs_hex: "0x01",
            signature: "0xsig",
            public_key: "0xpub",
            finalized_at_ms: baseNow + 1_000,
            updated_at_ms: baseNow + 1_000,
        };
        const client = new StaleReadRaceClient(staleProcessingRow, finalizedRow);
        const repository = new DynamoDbStateRepository("events", client);

        await repository.upsertCandidate(
            candidate("us7000race", { source_updated_at_ms: baseNow + 2_000 }),
            baseNow + 2_000,
        );

        expect(client.currentRow).toMatchObject({
            status: "finalized",
            source_updated_at_ms: baseNow,
            last_seen_at_ms: baseNow + 2_000,
            payload_bcs_hex: "0x01",
            signature: "0xsig",
            public_key: "0xpub",
            finalized_at_ms: baseNow + 1_000,
        });
    });

    it("does not refresh terminal rows that are still waiting for StopInstance", async () => {
        const staleProcessingRow = await eventRow("us7000stop", {
            status: "processing",
            runner_job_id: "earthquake-us7000stop-1",
            runner_attempt: 1,
            runner_phase: "applying_result",
        });
        const stopPendingTerminalRow = {
            ...staleProcessingRow,
            status: "finalized" as const,
            runner_phase: "complete" as const,
            runner_stopped_at_ms: null,
            tee_result_json: JSON.stringify(finalizedResult()),
            payload_bcs_hex: "0x01",
            signature: "0xsig",
            public_key: "0xpub",
            finalized_at_ms: baseNow + 1_000,
            source_updated_at_ms: baseNow,
            updated_at_ms: baseNow + 1_000,
        };
        const client = new StaleReadRaceClient(staleProcessingRow, stopPendingTerminalRow);
        const repository = new DynamoDbStateRepository("events", client);

        await repository.upsertCandidate(
            candidate("us7000stop", { source_updated_at_ms: baseNow + 2_000 }),
            baseNow + 2_000,
        );

        expect(client.currentRow).toMatchObject({
            status: "finalized",
            runner_phase: "complete",
            runner_stopped_at_ms: null,
            source_updated_at_ms: baseNow,
            updated_at_ms: baseNow + 1_000,
        });
    });

    it("marks a due row failed when Step Functions start fails", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000manual", baseNow);

        const started = await startDueWorkflows(
            repository,
            new FailingWorkflowStarter(),
            baseNow + 1_000,
            1,
        );

        expect(started).toBe(0);
        await expect(repository.get("us7000manual")).resolves.toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_START_FAILED",
            next_retry_at_ms: baseNow + 1_000 + 10 * 60 * 1_000,
            runner_error_message: "Step Functions unavailable",
        });
    });

    it("starts at most one workflow for each scheduler invocation", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertManualEvent("us7000first", baseNow);
        await repository.upsertManualEvent("us7000second", baseNow + 1);

        const started = await startDueWorkflows(repository, workflow, baseNow + 2_000, 25);

        expect(started).toBe(1);
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000first",
                executionName: "earthquake-us7000first-1",
                attempt: 1,
            },
        ]);
        await expect(repository.get("us7000second")).resolves.toMatchObject({ status: "new" });
    });

    it("does not try a second due row when an exclusive workflow claim is already held", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertManualEvent("us7000first", baseNow);
        await repository.upsertManualEvent("us7000second", baseNow + 1);
        await repository.tryStartRunnerWorkflowExclusively(
            "us7000first",
            "earthquake-us7000first-1",
            baseNow + 1_000,
            0,
        );

        const started = await startDueWorkflows(repository, workflow, baseNow + 2_000, 25);

        expect(started).toBe(0);
        expect(workflow.starts).toEqual([]);
        await expect(repository.get("us7000second")).resolves.toMatchObject({ status: "new" });
    });

    it("releases an exclusive workflow claim when StopInstance records shutdown", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertManualEvent("us7000first", baseNow);
        await repository.upsertManualEvent("us7000second", baseNow + 1);

        await startDueWorkflows(repository, workflow, baseNow + 2_000, 25);
        await repository.applyRunnerResult(
            "us7000first",
            pendingSourceResult("us7000first"),
            baseNow + 2_500,
            baseNow + 3_000,
            1,
        );
        await repository.markWorkflowStopped("us7000first", 1, baseNow + 3_000);
        const started = await startDueWorkflows(repository, workflow, baseNow + 4_000, 25);

        expect(started).toBe(1);
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000first",
                executionName: "earthquake-us7000first-1",
                attempt: 1,
            },
            {
                sourceEventId: "us7000second",
                executionName: "earthquake-us7000second-1",
                attempt: 1,
            },
        ]);
    });

    it("marks a workflow-start failure failed and releases the exclusive claim", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertManualEvent("us7000first", baseNow);
        await repository.upsertManualEvent("us7000second", baseNow + 1);

        const failedStart = await startDueWorkflows(
            repository,
            new FailingWorkflowStarter(),
            baseNow + 2_000,
            25,
        );
        const nextStart = await startDueWorkflows(repository, workflow, baseNow + 3_000, 25);

        expect(failedStart).toBe(0);
        expect(nextStart).toBe(1);
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000second",
                executionName: "earthquake-us7000second-1",
                attempt: 1,
            },
        ]);
        await expect(repository.get("us7000first")).resolves.toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_START_FAILED",
            runner_phase: "complete",
            runner_stopped_at_ms: baseNow + 2_000,
        });
    });

    it("does not start new workflow while a fresh runner workflow is active", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertManualEvent("us7000active", baseNow);
        await startDueWorkflows(repository, workflow, baseNow + 1_000, 1);
        await repository.upsertManualEvent("us7000next", baseNow + 2_000);

        const started = await startDueWorkflows(repository, workflow, baseNow + 3_000, 1);

        expect(started).toBe(0);
        expect(workflow.starts).toHaveLength(1);
        await expect(repository.get("us7000next")).resolves.toMatchObject({ status: "new" });
    });

    it("does not recover stale processing rows while another workflow is actively heartbeating", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertManualEvent("us7000stale", baseNow);
        await repository.markWorkflowStarted("us7000stale", "earthquake-us7000stale-1", baseNow);
        await repository.upsertManualEvent("us7000active", baseNow + 1_000);
        await repository.markWorkflowStarted(
            "us7000active",
            "earthquake-us7000active-1",
            baseNow + 20 * 60 * 1_000,
        );
        await repository.upsertManualEvent("us7000next", baseNow + 20 * 60 * 1_000 + 1);

        const started = await startDueWorkflows(
            repository,
            workflow,
            baseNow + 20 * 60 * 1_000 + 2,
            1,
        );

        expect(started).toBe(0);
        expect(workflow.starts).toEqual([]);
        await expect(repository.get("us7000stale")).resolves.toMatchObject({
            status: "processing",
            retry_count: 0,
            runner_attempt: 1,
        });
        await expect(repository.get("us7000next")).resolves.toMatchObject({ status: "new" });
    });

    it("recovers stale processing rows only when no active workflow is heartbeating", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertManualEvent("us7000stale", baseNow);
        await repository.markWorkflowStarted("us7000stale", "earthquake-us7000stale-1", baseNow);

        const started = await startDueWorkflows(repository, workflow, baseNow + 20 * 60 * 1_000, 1);

        expect(started).toBe(0);
        expect(workflow.starts).toEqual([]);
        await expect(repository.get("us7000stale")).resolves.toMatchObject({
            status: "failed",
            retry_count: 1,
            error_code: "AWS_RUNNER_TIMEOUT",
        });
    });

    it("does not recover a DynamoDB processing row that heartbeats during stale recovery", async () => {
        const staleRow = await eventRow("us7000race", {
            status: "processing",
            runner_job_id: "earthquake-us7000race-1",
            runner_attempt: 1,
            runner_phase: "polling_command",
            updated_at_ms: baseNow,
        });
        const freshRow = {
            ...staleRow,
            runner_last_poll_at_ms: baseNow + 20 * 60 * 1_000,
            updated_at_ms: baseNow + 20 * 60 * 1_000,
        };
        const client = new StaleRecoveryHeartbeatRaceClient(staleRow, freshRow);
        const repository = new DynamoDbStateRepository("events", client);

        const recovered = await repository.recoverStaleProcessing(
            baseNow + 15 * 60 * 1_000,
            baseNow + 20 * 60 * 1_000,
            baseNow + 30 * 60 * 1_000,
        );

        expect(recovered).toBe(0);
        expect(client.currentRow).toMatchObject({
            status: "processing",
            retry_count: 0,
            runner_attempt: 1,
            updated_at_ms: baseNow + 20 * 60 * 1_000,
        });
    });

    it("does not let watcher metadata updates refresh a row that becomes processing during the write", async () => {
        const newRow = await eventRow("us7000race", {
            status: "new",
            updated_at_ms: baseNow,
        });
        const processingRow = {
            ...newRow,
            status: "processing" as const,
            runner_job_id: "earthquake-us7000race-1",
            runner_attempt: 1,
            runner_phase: "starting_instance" as const,
            updated_at_ms: baseNow + 1_000,
        };
        const client = new WatcherMetadataProcessingRaceClient(newRow, processingRow);
        const repository = new DynamoDbStateRepository("events", client);

        await repository.upsertCandidate(candidate("us7000race"), baseNow + 20 * 60 * 1_000);

        expect(client.currentRow).toMatchObject({
            status: "processing",
            runner_attempt: 1,
            last_seen_at_ms: baseNow + 20 * 60 * 1_000,
            updated_at_ms: baseNow + 1_000,
        });
    });

    it("does not overwrite a DynamoDB row that becomes processing during deferUntil", async () => {
        const newRow = await eventRow("us7000fresh", {
            status: "new",
            next_retry_at_ms: null,
            updated_at_ms: baseNow,
        });
        const processingRow = {
            ...newRow,
            status: "processing" as const,
            runner_job_id: "earthquake-us7000fresh-1",
            runner_attempt: 1,
            runner_phase: "starting_instance" as const,
            runner_started_at_ms: baseNow + 1_000,
            runner_stopped_at_ms: null,
            updated_at_ms: baseNow + 1_000,
        };
        const client = new StaleReadRaceClient(newRow, processingRow);
        const repository = new DynamoDbStateRepository("events", client);

        await repository.deferUntil("us7000fresh", baseNow + DAY_MS, baseNow + 2_000);

        expect(client.currentRow).toMatchObject({
            status: "processing",
            runner_job_id: "earthquake-us7000fresh-1",
            runner_attempt: 1,
            runner_phase: "starting_instance",
            next_retry_at_ms: null,
            updated_at_ms: baseNow + 1_000,
        });
    });

    it("reports guarded DynamoDB result writes as stale when the conditional write loses a race", async () => {
        const staleRow = await eventRow("us7000race", {
            status: "processing",
            runner_job_id: "earthquake-us7000race-1",
            runner_attempt: 1,
            runner_phase: "applying_result",
        });
        const supersedingRow = {
            ...staleRow,
            runner_job_id: "earthquake-us7000race-2",
            runner_attempt: 2,
            updated_at_ms: baseNow + 1_000,
        };
        const client = new ConditionalPutRaceClient(staleRow, supersedingRow);
        const repository = new DynamoDbStateRepository("events", client);

        const applied = await repository.applyRunnerResult(
            "us7000race",
            pendingSourceResult("us7000race"),
            baseNow + 2_000,
            baseNow + HOUR_MS,
            1,
        );
        const failed = await repository.markFailed(
            "us7000race",
            "AWS_RUNNER_PROCESS_FAILED",
            baseNow + 3_000,
            baseNow + HOUR_MS,
            "stale failure",
            1,
        );

        expect(applied).toBe(false);
        expect(failed).toBe(false);
        expect(client.currentRow).toMatchObject({
            status: "processing",
            runner_attempt: 2,
            tee_result_json: null,
            error_code: null,
        });
    });

    it("keeps long-running workflows active when progress heartbeats are fresh", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertManualEvent("us7000active", baseNow);
        await startDueWorkflows(repository, workflow, baseNow + 1_000, 1);
        await repository.updateRunnerWorkflowProgress({
            sourceEventId: "us7000active",
            attempt: 1,
            phase: "polling_command",
            nowMs: baseNow + 20 * 60 * 1_000,
            instanceId: "i-active",
            commandId: "cmd-active",
            resultS3Key: "results/us7000active/1.json",
            lastPollAtMs: baseNow + 20 * 60 * 1_000,
        });
        await repository.upsertManualEvent("us7000next", baseNow + 20 * 60 * 1_000 + 1);

        const started = await startDueWorkflows(
            repository,
            workflow,
            baseNow + 20 * 60 * 1_000 + 2,
            1,
        );

        expect(started).toBe(0);
        expect(workflow.starts).toHaveLength(1);
        await expect(repository.get("us7000active")).resolves.toMatchObject({
            status: "processing",
            runner_phase: "polling_command",
            runner_instance_id: "i-active",
            runner_command_id: "cmd-active",
            runner_last_poll_at_ms: baseNow + 20 * 60 * 1_000,
        });
    });

    it("omits unused status names from DynamoDB non-processing progress updates", async () => {
        const row = await eventRow("us7000complete", {
            status: "pending_source",
            runner_attempt: 1,
            runner_phase: "complete",
        });
        const client = new StaleReadRaceClient(row, row);
        const repository = new DynamoDbStateRepository("events", client);

        await expect(
            repository.updateRunnerWorkflowProgress({
                sourceEventId: "us7000complete",
                attempt: 1,
                phase: "complete",
                nowMs: baseNow + 1_000,
                allowNonProcessing: true,
            }),
        ).resolves.toBe(true);

        expect(client.currentRow).toMatchObject({
            runner_phase: "complete",
            updated_at_ms: baseNow + 1_000,
        });
    });

    it("does not treat watcher feed refreshes as runner workflow heartbeats", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertCandidate(candidate("us7000dead"), baseNow);
        await startDueWorkflows(repository, workflow, baseNow + 1_000, 1);
        await repository.upsertCandidate(candidate("us7000dead"), baseNow + 20 * 60 * 1_000);

        const started = await startDueWorkflows(
            repository,
            workflow,
            baseNow + 20 * 60 * 1_000 + 1,
            1,
        );

        expect(started).toBe(0);
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000dead",
                executionName: "earthquake-us7000dead-1",
                attempt: 1,
            },
        ]);
        await expect(repository.get("us7000dead")).resolves.toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_TIMEOUT",
            retry_count: 1,
            last_seen_at_ms: baseNow + 20 * 60 * 1_000,
            updated_at_ms: baseNow + 20 * 60 * 1_000 + 1,
        });
    });

    it("does not treat watcher feed refreshes as StopInstance-pending heartbeats", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertCandidate(candidate("us7000pending"), baseNow);
        await startDueWorkflows(repository, workflow, baseNow + 1_000, 1);
        await repository.applyRunnerResult(
            "us7000pending",
            pendingSourceResult("us7000pending"),
            baseNow + 2_000,
            baseNow + 3_000,
        );
        await repository.upsertCandidate(candidate("us7000pending"), baseNow + 20 * 60 * 1_000);

        const started = await startDueWorkflows(
            repository,
            workflow,
            baseNow + 20 * 60 * 1_000 + 1,
            1,
        );

        expect(started).toBe(1);
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000pending",
                executionName: "earthquake-us7000pending-1",
                attempt: 1,
            },
            {
                sourceEventId: "us7000pending",
                executionName: "earthquake-us7000pending-2",
                attempt: 2,
            },
        ]);
        await expect(repository.get("us7000pending")).resolves.toMatchObject({
            status: "processing",
            runner_attempt: 2,
        });
    });

    it("keeps a completed attempt active until StopInstance records shutdown", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertManualEvent("us7000pending", baseNow);
        await startDueWorkflows(repository, workflow, baseNow + 1_000, 1);
        await repository.applyRunnerResult(
            "us7000pending",
            pendingSourceResult("us7000pending"),
            baseNow + 2_000,
            baseNow + 3_000,
        );

        const started = await startDueWorkflows(repository, workflow, baseNow + 3_001, 1);

        expect(started).toBe(0);
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000pending",
                executionName: "earthquake-us7000pending-1",
                attempt: 1,
            },
        ]);
        await expect(repository.get("us7000pending")).resolves.toMatchObject({
            status: "pending_source",
            retry_count: 1,
            runner_attempt: 1,
            runner_stopped_at_ms: null,
        });
    });

    it("starts the next due workflow after StopInstance records shutdown", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        await repository.upsertManualEvent("us7000pending", baseNow);
        await startDueWorkflows(repository, workflow, baseNow + 1_000, 1);
        await repository.applyRunnerResult(
            "us7000pending",
            pendingSourceResult("us7000pending"),
            baseNow + 2_000,
            baseNow + 3_000,
        );
        await repository.markWorkflowStopped("us7000pending", 1, baseNow + 3_000);

        const started = await startDueWorkflows(repository, workflow, baseNow + 3_001, 1);

        expect(started).toBe(1);
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000pending",
                executionName: "earthquake-us7000pending-1",
                attempt: 1,
            },
            {
                sourceEventId: "us7000pending",
                executionName: "earthquake-us7000pending-2",
                attempt: 2,
            },
        ]);
        await expect(repository.get("us7000pending")).resolves.toMatchObject({
            status: "processing",
            retry_count: 1,
            runner_attempt: 2,
            runner_stopped_at_ms: null,
        });
    });

    it("returns null when a DynamoDB workflow start loses the conditional race", async () => {
        const dueRow = await eventRow("us7000race", {
            status: "new",
            retry_count: 0,
            updated_at_ms: baseNow,
        });
        const alreadyStartedRow = {
            ...dueRow,
            status: "processing" as const,
            runner_job_id: "earthquake-us7000race-1",
            runner_attempt: 1,
            runner_phase: "starting_instance" as const,
            runner_started_at_ms: baseNow + 1_000,
            runner_stopped_at_ms: null,
            updated_at_ms: baseNow + 1_000,
        };
        const client = new WorkflowStartRaceClient(alreadyStartedRow);
        const repository = new DynamoDbStateRepository("events", client);

        const started = await repository.markWorkflowStarted(
            "us7000race",
            "earthquake-us7000race-1",
            baseNow + 2_000,
            0,
        );

        expect(started).toBeNull();
        expect(client.currentRow).toMatchObject({
            status: "processing",
            runner_attempt: 1,
            error_code: null,
        });
        expect(client.putCount).toBe(0);
    });

    it("returns null when a DynamoDB exclusive workflow start loses the lock race", async () => {
        const dueRow = await eventRow("us7000race", {
            status: "new",
            retry_count: 0,
            updated_at_ms: baseNow,
        });
        const client = new WorkflowStartTransactionConflictClient(dueRow);
        const repository = new DynamoDbStateRepository("events", client);

        const started = await repository.tryStartRunnerWorkflowExclusively(
            "us7000race",
            "earthquake-us7000race-1",
            baseNow + 2_000,
            0,
        );

        expect(started).toBeNull();
        expect(client.transactInputs).toHaveLength(1);
        expect(client.currentRow).toMatchObject({ status: "new", runner_attempt: null });
    });

    it("writes and releases a DynamoDB exclusive workflow lock", async () => {
        const dueRow = await eventRow("us7000race", {
            status: "new",
            retry_count: 0,
            updated_at_ms: baseNow,
        });
        const client = new WorkflowStartTransactionClient(dueRow);
        const repository = new DynamoDbStateRepository("events", client);

        const started = await repository.tryStartRunnerWorkflowExclusively(
            "us7000race",
            "earthquake-us7000race-1",
            baseNow + 2_000,
            0,
        );
        const stopped = await repository.markWorkflowStopped("us7000race", 1, baseNow + 3_000);

        expect(started).toEqual({
            sourceEventId: "us7000race",
            executionName: "earthquake-us7000race-1",
            attempt: 1,
        });
        expect(stopped).toBe(true);
        expect(client.currentRow).toMatchObject({
            status: "processing",
            runner_attempt: 1,
            runner_phase: "complete",
            runner_stopped_at_ms: baseNow + 3_000,
        });
        expect(client.lockRow).toBeUndefined();
        expect(client.scanInputs.every((input) => input.ConsistentRead === true)).toBe(true);
    });

    it("preserves finalized TEE payload metadata on the event row", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", baseNow);

        await repository.applyRunnerResult("us7000sonari", finalizedResult(), baseNow + 1_000);

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "finalized",
            event_uid: "us7000sonari",
            latest_revision: 1,
            source_updated_at_ms: baseNow,
        });
    });

    it("rejects malformed finalized TEE payload metadata before mutating the event row", async () => {
        for (const payloadPatch of [
            { event_uid: "" },
            { event_revision: 1.5 },
            { event_revision: 0x1_0000_0000 },
            { source_updated_at_ms: baseNow + 0.5 },
            { source_updated_at_ms: Number.MAX_SAFE_INTEGER + 1 },
        ]) {
            const repository = new InMemoryStateRepository();
            await repository.upsertManualEvent("us7000sonari", baseNow);
            const before = await repository.get("us7000sonari");
            if (before === null) {
                throw new Error("failed to create test row");
            }
            const result = finalizedResult();
            if (result.status !== "finalized") {
                throw new Error("test finalized result helper returned a non-finalized result");
            }

            await expect(
                repository.applyRunnerResult(
                    "us7000sonari",
                    {
                        ...result,
                        payload: { ...result.payload, ...payloadPatch },
                    } as TeeCoreResult,
                    baseNow + 1_000,
                ),
            ).rejects.toThrow(/invalid finalized TEE result metadata/);

            await expect(repository.get("us7000sonari")).resolves.toEqual(before);
        }
    });
});

async function eventRow(
    sourceEventId: string,
    patch: Partial<EarthquakeEventRow> = {},
): Promise<EarthquakeEventRow> {
    const repository = new InMemoryStateRepository();
    await repository.upsertManualEvent(sourceEventId, baseNow);
    const row = await repository.get(sourceEventId);
    if (row === null) {
        throw new Error(`failed to create test row ${sourceEventId}`);
    }
    return { ...row, ...patch };
}

class PaginatedScanClient {
    readonly scanInputs: Array<Record<string, unknown>> = [];

    constructor(private readonly pages: EarthquakeEventRow[][]) {}

    async send(command: unknown): Promise<unknown> {
        const input = readCommandInput(command);
        if ("Item" in input) {
            return {};
        }
        if ("Key" in input) {
            return {};
        }
        this.scanInputs.push(input);
        const pageIndex = input.ExclusiveStartKey === undefined ? 0 : 1;
        return {
            Items: this.pages[pageIndex] ?? [],
            ...(pageIndex + 1 < this.pages.length
                ? { LastEvaluatedKey: { source_event_id: `page-${pageIndex + 1}` } }
                : {}),
        };
    }
}

class StaleReadRaceClient {
    currentRow: EarthquakeEventRow;
    private returnedStaleRead = false;

    constructor(
        private readonly staleRow: EarthquakeEventRow,
        finalizedRow: EarthquakeEventRow,
    ) {
        this.currentRow = structuredClone(finalizedRow);
    }

    async send(command: unknown): Promise<unknown> {
        const input = readCommandInput(command);
        if ("Key" in input && !("UpdateExpression" in input)) {
            if (!this.returnedStaleRead) {
                this.returnedStaleRead = true;
                return { Item: structuredClone(this.staleRow) };
            }
            return { Item: structuredClone(this.currentRow) };
        }
        if ("Item" in input) {
            this.currentRow = structuredClone(input.Item as EarthquakeEventRow);
            return {};
        }
        if ("UpdateExpression" in input) {
            this.applyUpdate(input);
            return {};
        }
        throw new Error("unexpected stale read race client command");
    }

    private applyUpdate(input: Record<string, unknown>): void {
        const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
        const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
        if (names === undefined || values === undefined) {
            throw new Error("test update command must use expression names and values");
        }
        const updateExpression = input.UpdateExpression;
        if (typeof updateExpression !== "string" || !updateExpression.startsWith("SET ")) {
            throw new Error("test client only supports SET update expressions");
        }
        for (const nameToken of Object.keys(names)) {
            if (!expressionReferencesName(input, nameToken)) {
                throw new Error(`unused expression attribute name ${nameToken}`);
            }
        }
        for (const valueToken of Object.keys(values)) {
            if (!expressionReferencesValue(input, valueToken)) {
                throw new Error(`unused expression attribute value ${valueToken}`);
            }
        }
        const condition = input.ConditionExpression;
        if (typeof condition === "string" && !this.matchesCondition(condition, names, values)) {
            throw Object.assign(new Error("conditional request failed"), {
                name: "ConditionalCheckFailedException",
            });
        }
        for (const assignment of updateExpression.slice("SET ".length).split(", ")) {
            const [nameToken, valueToken] = assignment.split(" = ");
            if (nameToken === undefined || valueToken === undefined) {
                throw new Error(`unexpected update assignment ${assignment}`);
            }
            const field = names[nameToken];
            if (field === undefined || !(valueToken in values)) {
                throw new Error(`unexpected update assignment ${assignment}`);
            }
            this.currentRow = {
                ...this.currentRow,
                [field]: values[valueToken],
            };
        }
    }

    private matchesCondition(
        condition: string,
        names: Record<string, string>,
        values: Record<string, unknown>,
    ): boolean {
        if (condition === "attribute_not_exists(#source_event_id)") {
            return this.currentRow === undefined;
        }
        if (condition === "attribute_exists(#source_event_id)") {
            return this.currentRow !== undefined;
        }
        if (condition.includes("#status <> :processing_status")) {
            const statusField = names["#status"];
            return (
                statusField !== undefined &&
                this.currentRow[statusField as keyof EarthquakeEventRow] !==
                    values[":processing_status"]
            );
        }
        if (condition === "#runner_attempt = :expected_attempt") {
            const attemptField = names["#runner_attempt"];
            return (
                attemptField !== undefined &&
                this.currentRow[attemptField as keyof EarthquakeEventRow] ===
                    values[":expected_attempt"]
            );
        }
        const statusField = names["#status"];
        if (statusField === undefined) {
            throw new Error(`unexpected condition ${condition}`);
        }
        const status = this.currentRow[statusField as keyof EarthquakeEventRow];
        if (condition.includes("AND NOT (#runner_phase IN") && this.isStopPending()) {
            return false;
        }
        if (condition.includes("NOT (#status IN")) {
            return ![
                values[":processing_status"],
                values[":finalized_status"],
                values[":submitted_status"],
                values[":rejected_status"],
            ].includes(status);
        }
        if (
            condition.includes(
                "#status IN (:finalized_status, :submitted_status, :rejected_status)",
            )
        ) {
            return [values[":finalized_status"], values[":submitted_status"], values[":rejected_status"]].includes(
                status,
            );
        }
        if (condition.includes("#status = :processing_status")) {
            return status === values[":processing_status"];
        }
        const allowedStatuses = Object.entries(values)
            .filter(([key]) => condition.includes(key))
            .map(([, value]) => value);
        return allowedStatuses.includes(status);
    }

    private isStopPending(): boolean {
        return (
            (this.currentRow.runner_phase === "complete" ||
                this.currentRow.runner_phase === "stopping_instance") &&
            this.currentRow.runner_stopped_at_ms === null
        );
    }
}

class StaleRecoveryHeartbeatRaceClient {
    currentRow: EarthquakeEventRow;
    private scanned = false;

    constructor(
        private readonly staleRow: EarthquakeEventRow,
        freshRow: EarthquakeEventRow,
    ) {
        this.currentRow = structuredClone(freshRow);
    }

    async send(command: unknown): Promise<unknown> {
        const input = readCommandInput(command);
        if ("Key" in input && !("UpdateExpression" in input)) {
            return { Item: structuredClone(this.currentRow) };
        }
        if ("Item" in input) {
            this.currentRow = structuredClone(input.Item as EarthquakeEventRow);
            return {};
        }
        if ("UpdateExpression" in input) {
            this.applyUpdate(input);
            return {};
        }
        if (!this.scanned) {
            this.scanned = true;
            return { Items: [structuredClone(this.staleRow)] };
        }
        return { Items: [] };
    }

    private applyUpdate(input: Record<string, unknown>): void {
        const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
        const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
        if (names === undefined || values === undefined) {
            throw new Error("test update command must use expression names and values");
        }
        const condition = input.ConditionExpression;
        if (typeof condition === "string" && !this.matchesCondition(condition, names, values)) {
            throw Object.assign(new Error("conditional request failed"), {
                name: "ConditionalCheckFailedException",
            });
        }
        const updateExpression = input.UpdateExpression;
        if (typeof updateExpression !== "string" || !updateExpression.startsWith("SET ")) {
            throw new Error("test client only supports SET update expressions");
        }
        for (const assignment of updateExpression.slice("SET ".length).split(", ")) {
            const [nameToken, valueToken] = assignment.split(" = ");
            if (nameToken === undefined || valueToken === undefined) {
                throw new Error(`unexpected update assignment ${assignment}`);
            }
            const field = names[nameToken];
            if (field === undefined || !(valueToken in values)) {
                throw new Error(`unexpected update assignment ${assignment}`);
            }
            this.currentRow = {
                ...this.currentRow,
                [field]: values[valueToken],
            };
        }
    }

    private matchesCondition(
        condition: string,
        names: Record<string, string>,
        values: Record<string, unknown>,
    ): boolean {
        const statusField = names["#status"];
        const updatedAtField = names["#updated_at_ms"];
        if (statusField === undefined || updatedAtField === undefined) {
            return false;
        }
        const updatedAt = this.currentRow[updatedAtField as keyof EarthquakeEventRow];
        const staleBeforeMs = values[":stale_before_ms"];
        return (
            condition.includes("#updated_at_ms <= :stale_before_ms") &&
            this.currentRow[statusField as keyof EarthquakeEventRow] === values[":processing_status"] &&
            typeof updatedAt === "number" &&
            typeof staleBeforeMs === "number" &&
            updatedAt <= staleBeforeMs
        );
    }
}

class ConditionalPutRaceClient {
    currentRow: EarthquakeEventRow;

    constructor(
        private readonly staleRow: EarthquakeEventRow,
        currentRow: EarthquakeEventRow,
    ) {
        this.currentRow = structuredClone(currentRow);
    }

    async send(command: unknown): Promise<unknown> {
        const input = readCommandInput(command);
        if ("Key" in input && !("UpdateExpression" in input)) {
            return { Item: structuredClone(this.staleRow) };
        }
        if ("Item" in input) {
            if (!this.matchesPutCondition(input)) {
                throw Object.assign(new Error("conditional request failed"), {
                    name: "ConditionalCheckFailedException",
                });
            }
            this.currentRow = structuredClone(input.Item as EarthquakeEventRow);
            return {};
        }
        throw new Error("unexpected conditional put race client command");
    }

    private matchesPutCondition(input: Record<string, unknown>): boolean {
        const condition = input.ConditionExpression;
        if (condition === undefined) {
            return true;
        }
        if (typeof condition !== "string") {
            return false;
        }
        const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
        const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
        if (names === undefined || values === undefined) {
            return false;
        }
        const statusField = names["#status"];
        const attemptField = names["#runner_attempt"];
        return (
            statusField !== undefined &&
            attemptField !== undefined &&
            condition.includes("#status = :processing_status") &&
            condition.includes("#runner_attempt = :expected_attempt") &&
            this.currentRow[statusField as keyof EarthquakeEventRow] === values[":processing_status"] &&
            this.currentRow[attemptField as keyof EarthquakeEventRow] === values[":expected_attempt"]
        );
    }
}

class WorkflowStartRaceClient {
    putCount = 0;

    constructor(readonly currentRow: EarthquakeEventRow) {}

    async send(command: unknown): Promise<unknown> {
        const input = readCommandInput(command);
        if ("Item" in input) {
            this.putCount += 1;
            return {};
        }
        if ("UpdateExpression" in input) {
            throw Object.assign(new Error("conditional request failed"), {
                name: "ConditionalCheckFailedException",
            });
        }
        if ("Key" in input) {
            return { Item: structuredClone(this.currentRow) };
        }
        throw new Error("unexpected workflow start race client command");
    }
}

class WorkflowStartTransactionConflictClient {
    readonly transactInputs: Array<Record<string, unknown>> = [];
    currentRow: EarthquakeEventRow;

    constructor(currentRow: EarthquakeEventRow) {
        this.currentRow = structuredClone(currentRow);
    }

    async send(command: unknown): Promise<unknown> {
        const input = readCommandInput(command);
        if ("TransactItems" in input) {
            this.transactInputs.push(input);
            throw Object.assign(new Error("transaction canceled"), {
                name: "TransactionCanceledException",
            });
        }
        if ("Key" in input) {
            return { Item: structuredClone(this.currentRow) };
        }
        throw new Error("unexpected workflow start transaction conflict client command");
    }
}

class WorkflowStartTransactionClient {
    readonly scanInputs: Array<Record<string, unknown>> = [];
    currentRow: EarthquakeEventRow;
    lockRow: Record<string, unknown> | undefined;

    constructor(currentRow: EarthquakeEventRow) {
        this.currentRow = structuredClone(currentRow);
    }

    async send(command: unknown): Promise<unknown> {
        const input = readCommandInput(command);
        if ("TransactItems" in input) {
            this.applyTransaction(input);
            return {};
        }
        if ("UpdateExpression" in input) {
            this.applyUpdate(input);
            return {};
        }
        if ("Key" in input && "ConditionExpression" in input) {
            this.lockRow = undefined;
            return {};
        }
        if ("Key" in input) {
            return { Item: structuredClone(this.currentRow) };
        }
        this.scanInputs.push(input);
        return { Items: [structuredClone(this.currentRow)] };
    }

    private applyTransaction(input: Record<string, unknown>): void {
        const transactItems = input.TransactItems;
        if (!Array.isArray(transactItems)) {
            throw new Error("transaction test input must include TransactItems");
        }
        for (const item of transactItems) {
            if (!isPlainRecord(item)) {
                throw new Error("transaction item must be an object");
            }
            if (isPlainRecord(item.Update)) {
                this.applyUpdate(item.Update);
            }
            if (isPlainRecord(item.Put)) {
                this.lockRow = structuredClone(item.Put.Item as Record<string, unknown>);
            }
        }
    }

    private applyUpdate(input: Record<string, unknown>): void {
        const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
        const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
        if (names === undefined || values === undefined) {
            throw new Error("test update command must use expression names and values");
        }
        const updateExpression = input.UpdateExpression;
        if (typeof updateExpression !== "string" || !updateExpression.startsWith("SET ")) {
            throw new Error("test client only supports SET update expressions");
        }
        for (const assignment of updateExpression.slice("SET ".length).split(", ")) {
            const [nameToken, valueToken] = assignment.split(" = ");
            if (nameToken === undefined || valueToken === undefined) {
                throw new Error(`unexpected update assignment ${assignment}`);
            }
            const field = names[nameToken];
            if (field === undefined || !(valueToken in values)) {
                throw new Error(`unexpected update assignment ${assignment}`);
            }
            this.currentRow = {
                ...this.currentRow,
                [field]: values[valueToken],
            };
        }
    }
}

class WatcherMetadataProcessingRaceClient {
    currentRow: EarthquakeEventRow;
    private returnedStaleRead = false;

    constructor(
        private readonly staleRow: EarthquakeEventRow,
        processingRow: EarthquakeEventRow,
    ) {
        this.currentRow = structuredClone(processingRow);
    }

    async send(command: unknown): Promise<unknown> {
        const input = readCommandInput(command);
        if ("Key" in input && !("UpdateExpression" in input)) {
            if (!this.returnedStaleRead) {
                this.returnedStaleRead = true;
                return { Item: structuredClone(this.staleRow) };
            }
            return { Item: structuredClone(this.currentRow) };
        }
        if ("UpdateExpression" in input) {
            this.applyUpdate(input);
            return {};
        }
        throw new Error("unexpected watcher metadata race client command");
    }

    private applyUpdate(input: Record<string, unknown>): void {
        const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
        const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
        if (names === undefined || values === undefined) {
            throw new Error("test update command must use expression names and values");
        }
        const condition = input.ConditionExpression;
        if (typeof condition === "string" && !this.matchesCondition(condition, names, values)) {
            throw Object.assign(new Error("conditional request failed"), {
                name: "ConditionalCheckFailedException",
            });
        }
        const updateExpression = input.UpdateExpression;
        if (typeof updateExpression !== "string" || !updateExpression.startsWith("SET ")) {
            throw new Error("test client only supports SET update expressions");
        }
        for (const assignment of updateExpression.slice("SET ".length).split(", ")) {
            const [nameToken, valueToken] = assignment.split(" = ");
            if (nameToken === undefined || valueToken === undefined) {
                throw new Error(`unexpected update assignment ${assignment}`);
            }
            const field = names[nameToken];
            if (field === undefined || !(valueToken in values)) {
                throw new Error(`unexpected update assignment ${assignment}`);
            }
            this.currentRow = {
                ...this.currentRow,
                [field]: values[valueToken],
            };
        }
    }

    private matchesCondition(
        condition: string,
        names: Record<string, string>,
        values: Record<string, unknown>,
    ): boolean {
        if (!condition.includes("attribute_exists(#source_event_id)")) {
            return false;
        }
        const statusField = names["#status"];
        if (statusField === undefined) {
            return false;
        }
        const status = this.currentRow[statusField as keyof EarthquakeEventRow];
        if (condition.includes("AND NOT (#runner_phase IN") && this.isStopPending()) {
            return false;
        }
        if (condition.includes("NOT (#status IN")) {
            return ![
                values[":processing_status"],
                values[":finalized_status"],
                values[":submitted_status"],
                values[":rejected_status"],
            ].includes(status);
        }
        if (
            condition.includes(
                "#status IN (:finalized_status, :submitted_status, :rejected_status)",
            )
        ) {
            return [values[":finalized_status"], values[":submitted_status"], values[":rejected_status"]].includes(
                status,
            );
        }
        if (condition.includes("#status = :processing_status")) {
            return status === values[":processing_status"];
        }
        return true;
    }

    private isStopPending(): boolean {
        return (
            (this.currentRow.runner_phase === "complete" ||
                this.currentRow.runner_phase === "stopping_instance") &&
            this.currentRow.runner_stopped_at_ms === null
        );
    }
}

function readCommandInput(command: unknown): Record<string, unknown> {
    if (
        typeof command === "object" &&
        command !== null &&
        "input" in command &&
        typeof command.input === "object" &&
        command.input !== null
    ) {
        return command.input as Record<string, unknown>;
    }
    throw new Error("unexpected AWS command shape");
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function expressionReferencesName(input: Record<string, unknown>, nameToken: string): boolean {
    const expressions = [input.ConditionExpression, input.UpdateExpression]
        .filter((expression): expression is string => typeof expression === "string")
        .join(" ");
    return new RegExp(`${escapeRegExp(nameToken)}(?![A-Za-z0-9_])`).test(expressions);
}

function expressionReferencesValue(input: Record<string, unknown>, valueToken: string): boolean {
    const expressions = [input.ConditionExpression, input.UpdateExpression]
        .filter((expression): expression is string => typeof expression === "string")
        .join(" ");
    return new RegExp(`${escapeRegExp(valueToken)}(?![A-Za-z0-9_])`).test(expressions);
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function finalizedResult(): TeeCoreResult {
    return {
        status: "finalized",
        payload: {
            intent: BCS_ENUMS.intent.SONARI_EARTHQUAKE_ORACLE,
            oracle_version: 1,
            event_uid: "us7000sonari",
            hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
            status: BCS_ENUMS.onchainStatus.FINALIZED,
            event_revision: 1,
            occurred_at_ms: baseNow,
            observed_at_ms: baseNow,
            source_updated_at_ms: baseNow,
            primary_source: BCS_ENUMS.primarySource.USGS,
            severity_band: 2,
            source_set_hash: `0x${"11".repeat(32)}`,
            raw_data_hash: `0x${"22".repeat(32)}`,
            raw_data_uri: "walrus://raw",
            affected_cells_root: `0x${"33".repeat(32)}`,
            affected_cells_uri: "walrus://cells",
            affected_cells_data_hash: `0x${"44".repeat(32)}`,
            geo_resolution: 7,
            cells_generation_method:
                BCS_ENUMS.cellsGenerationMethod.SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
            cell_metric: BCS_ENUMS.cellMetric.USGS_MMI,
            cell_aggregation: BCS_ENUMS.cellAggregation.GRID_POINT_P90,
            intensity_scale: BCS_ENUMS.intensityScale.MMI_X100,
            max_cell_band: 2,
            affected_cell_count: 1,
            min_claim_band: 1,
            freshness_deadline_ms: baseNow + 60_000,
        },
        payload_bcs_hex: "0x01",
        signature: "0xsig",
        public_key: "0xpub",
    };
}

function pendingSourceResult(sourceEventId: string): TeeCoreResult {
    return {
        status: "pending_source",
        source_event_id: sourceEventId,
        error_code: "SHAKEMAP_PRODUCT_MISSING",
    };
}
