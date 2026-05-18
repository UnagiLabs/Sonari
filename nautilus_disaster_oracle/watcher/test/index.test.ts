import {
    BCS_ENUMS,
    DEFAULT_ORACLE_CONTRACT,
    validateWorkerToTeeRequest,
} from "@sonari/oracle-shared";
import { describe, expect, it, vi } from "vitest";
import type {
    RelayerAdapter,
    RelayerRequestPreview,
    RunnerJobQueue,
    RunnerQueueJob,
    RunnerAdapter,
    UsgsEarthquakeCandidate,
    WorkerEnv,
} from "../src/index.js";
import {
    buildWorkerToTeeRequest,
    createWorkerApp,
    DAY_MS,
    FAILED_RETRY_BACKOFF_MS,
    FINALIZATION_WINDOW_MS,
    HOUR_MS,
    InMemoryStateRepository,
    MockRunnerAdapter,
    MockRunnerLifecycleAdapter,
    PROCESSING_STALE_AFTER_MS,
    processDueEventsInlineForTests,
    scanCandidates,
} from "../src/index.js";
import type { EarthquakeEventRow, StateRepository } from "../src/state.js";

const baseNow = 1_800_000_000_000;

function candidate(
    source_event_id: string,
    patch: Partial<UsgsEarthquakeCandidate> = {},
): UsgsEarthquakeCandidate {
    return {
        source_event_id,
        occurred_at_ms: baseNow - 25 * HOUR_MS,
        source_updated_at_ms: baseNow - HOUR_MS,
        magnitude: 6,
        summary_mmi: null,
        alert: null,
        tsunami: false,
        ...patch,
    };
}

function env(repository = new InMemoryStateRepository()): WorkerEnv {
    return {
        EARTHQUAKE_EVENTS: repository,
        RUNNER_JOBS: new TestRunnerQueue(),
        MANUAL_SUBMIT_TOKEN: "secret-token",
    };
}

describe("watcher state transitions", () => {
    it("deduplicates scans by source_event_id before invoking the runner", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await scanCandidates(repository, [candidate("us7000sonari")], baseNow + 1_000);
        const summary = await processDueEventsInlineForTests(repository, runner, baseNow);

        expect(summary.processed).toBe(1);
        expect(runner.requests).toHaveLength(1);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            retry_count: 0,
        });
    });

    it("stores below-threshold candidates but excludes them from runner selection", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();

        await scanCandidates(
            repository,
            [
                candidate("us7000small", {
                    magnitude: 5.4,
                    summary_mmi: null,
                    alert: "green",
                    tsunami: false,
                }),
            ],
            baseNow,
        );
        const summary = await processDueEventsInlineForTests(repository, runner, baseNow);

        expect(summary.processed).toBe(0);
        expect(runner.requests).toHaveLength(0);
        expect(await repository.get("us7000small")).toMatchObject({
            status: "ignored_small",
            error_code: "WATCHER_BELOW_AUTO_THRESHOLD",
            next_retry_at_ms: null,
        });
    });

    it("promotes ignored_small candidates to new when later scans become eligible", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(
            repository,
            [
                candidate("us7000promoted", {
                    magnitude: 5.4,
                    summary_mmi: null,
                    alert: null,
                    tsunami: false,
                }),
            ],
            baseNow,
        );
        await scanCandidates(
            repository,
            [
                candidate("us7000promoted", {
                    magnitude: 5.5,
                    summary_mmi: null,
                    alert: null,
                    tsunami: false,
                }),
            ],
            baseNow + 1_000,
        );

        expect(await repository.get("us7000promoted")).toMatchObject({
            status: "new",
            error_code: null,
            next_retry_at_ms: null,
        });
    });

    it("defers earthquakes younger than 24 hours without calling the runner", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();
        const occurredAt = baseNow - 23 * HOUR_MS;

        await scanCandidates(
            repository,
            [candidate("us7000sonari", { occurred_at_ms: occurredAt })],
            baseNow,
        );
        const summary = await processDueEventsInlineForTests(repository, runner, baseNow);

        expect(summary.deferred).toBe(1);
        expect(runner.requests).toHaveLength(0);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "new",
            next_retry_at_ms: occurredAt + DAY_MS,
        });
    });

    it("stores pending runner results with a retry before the 72 hour deadline", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();

        await scanCandidates(repository, [candidate("us7000pending-source")], baseNow);
        await processDueEventsInlineForTests(repository, runner, baseNow);

        const row = await repository.get("us7000pending-source");
        expect(row).toMatchObject({
            status: "pending_source",
            error_code: "SHAKEMAP_PRODUCT_MISSING",
        });
        expect(row).not.toBeNull();
        expect(row?.next_retry_at_ms).toBeGreaterThan(baseNow);
        expect(row?.next_retry_at_ms).toBeLessThanOrEqual(row?.finalization_deadline_at_ms ?? 0);
    });

    it("auto-rejects pending results once the 72 hour deadline is exceeded", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();
        const occurredAt = baseNow - FINALIZATION_WINDOW_MS - 1;

        await scanCandidates(
            repository,
            [candidate("us7000pending-mmi", { occurred_at_ms: occurredAt })],
            baseNow,
        );
        await processDueEventsInlineForTests(repository, runner, baseNow);

        expect(await repository.get("us7000pending-mmi")).toMatchObject({
            status: "rejected",
            error_code: "REJECTED_AUTO_TRIGGER",
            next_retry_at_ms: null,
        });
    });

    it("persists finalized payload metadata returned by the runner", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processDueEventsInlineForTests(repository, new MockRunnerAdapter(), baseNow);

        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            next_retry_at_ms: null,
            error_code: null,
            event_uid: "us7000sonari",
            latest_revision: 3,
            source_updated_at_ms: 1_700_000_010_000,
        });
    });

    it("runs relayer preview once for finalized runner results", async () => {
        const repository = new InMemoryStateRepository();
        const relayer = new RecordingRelayerAdapter();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        const summary = await processDueEventsInlineForTests(
            repository,
            new MockRunnerAdapter(),
            baseNow,
            undefined,
            relayer,
        );

        expect(summary.processed).toBe(1);
        expect(relayer.inputs).toHaveLength(1);
        expect(relayer.inputs[0]).toMatchObject({
            status: "finalized",
            payload: { event_uid: "us7000sonari" },
        });
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            relayer_mode: "preview",
            relayer_status: "succeeded",
            relayer_request_json: JSON.stringify(relayer.preview),
            relayer_digest: null,
            relayer_error_code: null,
            relayer_error_message: null,
            relayer_updated_at_ms: baseNow,
            relayer_submitted_at_ms: null,
        });
    });

    it("marks rows submitted only when a fake submit adapter succeeds", async () => {
        const repository = new InMemoryStateRepository();
        const relayer = new RecordingRelayerAdapter({ mode: "submit", digest: "7Zsubmit" });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processDueEventsInlineForTests(
            repository,
            new MockRunnerAdapter(),
            baseNow,
            undefined,
            relayer,
        );

        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "submitted",
            relayer_mode: "submit",
            relayer_status: "succeeded",
            relayer_digest: "7Zsubmit",
            relayer_submitted_at_ms: baseNow,
        });
    });

    it.each(["us7000pending-source", "us7000pending-mmi", "us7000cancelled"] as const)(
        "does not run relayer preview for non-finalized result %s",
        async (sourceEventId) => {
            const repository = new InMemoryStateRepository();
            const relayer = new RecordingRelayerAdapter();

            await scanCandidates(repository, [candidate(sourceEventId)], baseNow);
            await processDueEventsInlineForTests(
                repository,
                new MockRunnerAdapter(),
                baseNow,
                undefined,
                relayer,
            );

            expect(relayer.inputs).toHaveLength(0);
            expect(await repository.get(sourceEventId)).toMatchObject({
                relayer_status: null,
                relayer_request_json: null,
                relayer_error_code: null,
                relayer_error_message: null,
                relayer_updated_at_ms: null,
            });
        },
    );

    it("records relayer preview failure without making finalized rows due again", async () => {
        const repository = new InMemoryStateRepository();
        const relayer = new RecordingRelayerAdapter({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "preview unavailable",
        });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processDueEventsInlineForTests(
            repository,
            new MockRunnerAdapter(),
            baseNow,
            undefined,
            relayer,
        );

        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            retry_count: 0,
            next_retry_at_ms: null,
            error_code: null,
            relayer_mode: "preview",
            relayer_status: "failed",
            relayer_request_json: null,
            relayer_digest: null,
            relayer_error_code: "RELAYER_SUBMIT_FAILED",
            relayer_error_message: "preview unavailable",
            relayer_updated_at_ms: baseNow,
            relayer_submitted_at_ms: null,
        });
        await expect(repository.listDue(baseNow + FAILED_RETRY_BACKOFF_MS, 10)).resolves.toEqual(
            [],
        );
    });

    it("does not overwrite finalized payload metadata during later scans", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processDueEventsInlineForTests(repository, new MockRunnerAdapter(), baseNow);
        await scanCandidates(
            repository,
            [
                candidate("us7000sonari", {
                    source_updated_at_ms: 1_900_000_000_000,
                }),
            ],
            baseNow + HOUR_MS,
        );

        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            event_uid: "us7000sonari",
            latest_revision: 3,
            source_updated_at_ms: 1_700_000_010_000,
            last_seen_at_ms: baseNow + HOUR_MS,
            updated_at_ms: baseNow + HOUR_MS,
        });
    });

    it("persists rejected runner errors", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(repository, [candidate("us7000cancelled")], baseNow);
        await processDueEventsInlineForTests(repository, new MockRunnerAdapter(), baseNow);

        expect(await repository.get("us7000cancelled")).toMatchObject({
            status: "rejected",
            error_code: "SHAKEMAP_CANCELLED",
            next_retry_at_ms: null,
        });
    });

    it("maps generic runner failures to process failed rows with retry backoff", async () => {
        const repository = new InMemoryStateRepository();
        const runner: RunnerAdapter = {
            run: async () => {
                throw new Error("runner timed out");
            },
        };

        await scanCandidates(repository, [candidate("us7000timeout")], baseNow);
        await processDueEventsInlineForTests(repository, runner, baseNow);

        expect(await repository.get("us7000timeout")).toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_PROCESS_FAILED",
            retry_count: 1,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
        });
    });

    it("recovers stale processing rows before picking due work", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await repository.claimForProcessing(
            "us7000sonari",
            baseNow - PROCESSING_STALE_AFTER_MS - 1,
        );
        const summary = await processDueEventsInlineForTests(repository, new MockRunnerAdapter(), baseNow);

        expect(summary.recovered).toBe(1);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_TIMEOUT",
            retry_count: 1,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
        });
    });

    it("claims due rows atomically before invoking the runner", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await expect(repository.claimForProcessing("us7000sonari", baseNow)).resolves.toBe(true);
        await expect(repository.claimForProcessing("us7000sonari", baseNow)).resolves.toBe(false);
    });

    it("skips runner execution when a due row was already claimed", async () => {
        const row: EarthquakeEventRow = {
            source_event_id: "us7000sonari",
            event_uid: null,
            status: "new",
            retry_count: 0,
            next_retry_at_ms: null,
            finalization_deadline_at_ms: baseNow + FINALIZATION_WINDOW_MS,
            latest_revision: 0,
            last_seen_at_ms: baseNow,
            source_updated_at_ms: baseNow,
            error_code: null,
            relayer_mode: null,
            relayer_status: null,
            relayer_request_json: null,
            relayer_digest: null,
            relayer_error_code: null,
            relayer_error_message: null,
            relayer_updated_at_ms: null,
            relayer_submitted_at_ms: null,
            runner_job_id: null,
            runner_queued_at_ms: null,
            runner_attempt: null,
            runner_id: null,
            runner_started_at_ms: null,
            runner_stopped_at_ms: null,
            runner_timeout_at_ms: null,
            runner_error_message: null,
            runner_stop_error: null,
            created_at_ms: baseNow,
            updated_at_ms: baseNow,
        };
        const repository: StateRepository = {
            upsertCandidate: async () => {},
            get: async () => row,
            listDue: async () => [row],
            enqueueRunnerJob: async () => null,
            claimQueuedForProcessing: async () => false,
            recordRunnerStarted: async () => {},
            recordRunnerStopped: async () => {},
            recordRunnerStopFailed: async () => {},
            deferUntil: async () => {},
            markRejected: async () => {},
            markFailed: async () => {},
            markQueueEnqueueFailed: async () => {},
            applyRunnerResult: async () => {},
            markRelayerSucceeded: async () => {},
            markRelayerFailed: async () => {},
            recoverStaleProcessing: async () => 0,
            recoverStaleQueued: async () => 0,
        };
        const runner = new MockRunnerAdapter();

        const summary = await processDueEventsInlineForTests(repository, runner, baseNow);

        expect(summary.processed).toBe(0);
        expect(runner.requests).toHaveLength(0);
    });

    it("does not pass ignored_small rows to the runner even if listed by a repository", async () => {
        const row: EarthquakeEventRow = {
            source_event_id: "us7000small",
            event_uid: null,
            status: "ignored_small",
            retry_count: 0,
            next_retry_at_ms: null,
            finalization_deadline_at_ms: baseNow + FINALIZATION_WINDOW_MS,
            latest_revision: 0,
            last_seen_at_ms: baseNow,
            source_updated_at_ms: baseNow,
            error_code: "WATCHER_BELOW_AUTO_THRESHOLD",
            relayer_mode: null,
            relayer_status: null,
            relayer_request_json: null,
            relayer_digest: null,
            relayer_error_code: null,
            relayer_error_message: null,
            relayer_updated_at_ms: null,
            relayer_submitted_at_ms: null,
            runner_job_id: null,
            runner_queued_at_ms: null,
            runner_attempt: null,
            runner_id: null,
            runner_started_at_ms: null,
            runner_stopped_at_ms: null,
            runner_timeout_at_ms: null,
            runner_error_message: null,
            runner_stop_error: null,
            created_at_ms: baseNow,
            updated_at_ms: baseNow,
        };
        const repository: StateRepository = {
            upsertCandidate: async () => {},
            get: async () => row,
            listDue: async () => [row],
            enqueueRunnerJob: async () => {
                throw new Error("ignored_small should not be claimed");
            },
            claimQueuedForProcessing: async () => false,
            recordRunnerStarted: async () => {},
            recordRunnerStopped: async () => {},
            recordRunnerStopFailed: async () => {},
            deferUntil: async () => {},
            markRejected: async () => {},
            markFailed: async () => {},
            markQueueEnqueueFailed: async () => {},
            applyRunnerResult: async () => {},
            markRelayerSucceeded: async () => {},
            markRelayerFailed: async () => {},
            recoverStaleProcessing: async () => 0,
            recoverStaleQueued: async () => 0,
        };
        const runner = new MockRunnerAdapter();

        const summary = await processDueEventsInlineForTests(repository, runner, baseNow);

        expect(summary.processed).toBe(0);
        expect(runner.requests).toHaveLength(0);
    });

    it("clamps pending runner retries to the finalization deadline", async () => {
        const repository = new InMemoryStateRepository();
        const runner: RunnerAdapter = {
            run: async () => ({
                status: "pending_source",
                source_event_id: "us7000pending-source",
                error_code: "SHAKEMAP_PRODUCT_MISSING",
            }),
        };
        const occurredAt = baseNow - FINALIZATION_WINDOW_MS + HOUR_MS / 2;

        await scanCandidates(
            repository,
            [candidate("us7000pending-source", { occurred_at_ms: occurredAt })],
            baseNow,
        );
        await processDueEventsInlineForTests(repository, runner, baseNow);

        const row = await repository.get("us7000pending-source");
        expect(row).toMatchObject({ status: "pending_source" });
        expect(row?.next_retry_at_ms).toBe(row?.finalization_deadline_at_ms);
    });

    it("fails malformed finalized payload metadata without storing finalized metadata", async () => {
        const repository = new InMemoryStateRepository();
        const relayer = new RecordingRelayerAdapter();
        const runner: RunnerAdapter = {
            run: async () => ({
                status: "finalized",
                payload: {
                    event_uid: "",
                    event_revision: Number.MAX_SAFE_INTEGER + 1,
                    source_updated_at_ms: "bad",
                },
                payload_bcs_hex: "0x01",
                signature: "0xsig",
                public_key: "0xpub",
            }),
        };

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processDueEventsInlineForTests(repository, runner, baseNow, undefined, relayer);

        expect(relayer.inputs).toHaveLength(0);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "failed",
            error_code: "BCS_SERIALIZATION_FAILED",
            event_uid: null,
            latest_revision: 0,
            source_updated_at_ms: baseNow - HOUR_MS,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
            relayer_status: null,
            relayer_request_json: null,
            relayer_error_code: null,
            relayer_error_message: null,
            relayer_updated_at_ms: null,
        });
    });
});

class RecordingRelayerAdapter implements RelayerAdapter {
    readonly mode: "preview" | "dry_run" | "submit";
    readonly inputs: unknown[] = [];
    readonly preview: RelayerRequestPreview = {
        target: "0x123::disaster_oracle::submit_payload_v1",
        registry: "0x456",
        arguments: ["0x456", [1], [2], [3]],
        submitRequest: {
            target: "0x123::disaster_oracle::submit_payload_v1",
            registry: "0x456",
            arguments: ["0x456", [1], [2], [3]],
        },
    };

    constructor(
        private readonly options:
            | { ok: false; error_code: "RELAYER_SUBMIT_FAILED" | "MOVE_REJECTED"; message: string }
            | { ok?: true; mode?: "preview" | "dry_run" | "submit"; digest?: string } = {},
    ) {
        this.mode = "mode" in options && options.mode !== undefined ? options.mode : "preview";
    }

    async relay(input: unknown) {
        this.inputs.push(structuredClone(input));
        if ("ok" in this.options && this.options.ok === false) {
            return this.options;
        }
        return {
            ok: true as const,
            value: {
                mode: this.mode,
                request: this.preview,
                ...("digest" in this.options && this.options.digest !== undefined
                    ? { digest: this.options.digest }
                    : {}),
            },
        };
    }
}

describe("manual submit API", () => {
    it("returns 503 when MANUAL_SUBMIT_TOKEN is not configured", async () => {
        const app = createWorkerApp();
        const response = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                body: JSON.stringify({ source_event_id: "us7000sonari" }),
            }),
            { EARTHQUAKE_EVENTS: new InMemoryStateRepository() },
        );

        expect(response.status).toBe(503);
    });

    it("returns 401 for a mismatched bearer token", async () => {
        const app = createWorkerApp();
        const response = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                headers: { authorization: "Bearer wrong" },
                body: JSON.stringify({ source_event_id: "us7000sonari" }),
            }),
            env(),
        );

        expect(response.status).toBe(401);
    });

    it("returns 400 for invalid JSON and empty ids", async () => {
        const app = createWorkerApp();

        const invalidJson = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                headers: { authorization: "Bearer secret-token" },
                body: "{",
            }),
            env(),
        );
        const emptyId = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                headers: { authorization: "Bearer secret-token" },
                body: JSON.stringify({ source_event_id: "" }),
            }),
            env(),
        );

        expect(invalidJson.status).toBe(400);
        expect(emptyId.status).toBe(400);
    });

    it("accepts a valid manual earthquake and queues only that event", async () => {
        const repository = new InMemoryStateRepository();
        const app = createWorkerApp({ now: () => baseNow });
        const response = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                headers: { authorization: "Bearer secret-token" },
                body: JSON.stringify({
                    source_event_id: "us7000sonari",
                    occurred_at_ms: baseNow - 25 * HOUR_MS,
                    source_updated_at_ms: baseNow - HOUR_MS,
                }),
            }),
            env(repository),
        );

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
            accepted: true,
            source_event_id: "us7000sonari",
            summary: {
                enqueued: 1,
                deferred: 0,
                recovered: 0,
                rejected: 0,
            },
            event: {
                source_event_id: "us7000sonari",
                status: "queued",
                runner_job_id: "us7000sonari:1",
            },
        });
        expect(await repository.get("us7000sonari")).toMatchObject({
            source_event_id: "us7000sonari",
            status: "queued",
            runner_job_id: "us7000sonari:1",
        });
    });

    it("manual submit bypasses auto-screening for an existing ignored_small candidate", async () => {
        const repository = new InMemoryStateRepository();
        const app = createWorkerApp({ now: () => baseNow });

        await scanCandidates(
            repository,
            [
                candidate("us7000manual-small", {
                    magnitude: null,
                    summary_mmi: null,
                    alert: null,
                    tsunami: false,
                }),
            ],
            baseNow - 1_000,
        );

        const response = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                headers: { authorization: "Bearer secret-token" },
                body: JSON.stringify({
                    source_event_id: "us7000manual-small",
                    occurred_at_ms: baseNow - 25 * HOUR_MS,
                    source_updated_at_ms: baseNow - HOUR_MS,
                }),
            }),
            env(repository),
        );

        expect(response.status).toBe(202);
        expect(await repository.get("us7000manual-small")).toMatchObject({
            status: "queued",
            runner_job_id: "us7000manual-small:1",
        });
    });
});

class TestRunnerQueue implements RunnerJobQueue {
    readonly messages: RunnerQueueJob[] = [];

    async send(message: RunnerQueueJob): Promise<void> {
        this.messages.push(structuredClone(message));
    }
}

describe("health endpoint", () => {
    it("does not require the D1 binding", async () => {
        const app = createWorkerApp();
        const response = await app.fetch(
            new Request("https://watcher.test/health"),
            {} as WorkerEnv,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            ok: true,
            service: "sonari-oracle-watcher",
        });
    });
});

describe("runner boundary", () => {
    it("builds only the minimal validator-approved WorkerToTeeRequest", () => {
        const request = buildWorkerToTeeRequest("us7000sonari");

        expect(Object.keys(request).sort()).toEqual([
            "geo_resolution",
            "hazard_type",
            "primary_source",
            "source_event_id",
        ]);
        expect(request).toEqual({
            source_event_id: "us7000sonari",
            hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
            primary_source: BCS_ENUMS.primarySource.USGS,
            geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
        });
        expect(validateWorkerToTeeRequest(request)).toEqual({ ok: true, value: request });
    });

    it("passes only validator-normalized values to the runner", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processDueEventsInlineForTests(repository, runner, baseNow);

        expect(runner.requests).toEqual([buildWorkerToTeeRequest("us7000sonari")]);
        for (const forbidden of [
            "request_type",
            "context",
            "deadline",
            "retry",
            "payload",
            "signature",
            "hash",
            "affected_cells_root",
            "raw_data_hash",
            "magnitude",
            "summary_mmi",
            "alert",
            "tsunami",
        ]) {
            expect(runner.requests[0]).not.toHaveProperty(forbidden);
        }
    });
});

describe("relayer environment mode validation", () => {
    it("runs preview mode through the relayer sidecar when explicitly configured", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new TestRunnerQueue();
        const calls: Request[] = [];
        const fetcher = vi.fn(async (input: RequestInfo | URL) => {
            const request = input instanceof Request ? input : new Request(input);
            calls.push(request.clone());
            return Response.json({ ok: true, value: relayerSidecarPreview() });
        });
        const app = createWorkerApp({
            now: () => baseNow,
            fetcher,
            runner: new MockRunnerLifecycleAdapter(),
        });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processQueuedEvent(app, repository, queue, {
            RELAYER_MODE: "preview",
            ORACLE_SIDECAR_URL: "http://127.0.0.1:8789",
            RELAYER_TARGET: "0x123::disaster_oracle::submit_payload_v1",
            RELAYER_REGISTRY: "0x456",
        });

        expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/relayer/preview"]);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            relayer_mode: "preview",
            relayer_status: "succeeded",
        });
    });

    it("keeps ORACLE_SIDECAR_URL scoped to the relayer and uses the mock runner by default", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new TestRunnerQueue();
        const calls: Request[] = [];
        const fetcher = vi.fn(async (input: RequestInfo | URL) => {
            const request = input instanceof Request ? input : new Request(input);
            calls.push(request.clone());
            if (request.url.endsWith("/process_data")) {
                const runner = new MockRunnerAdapter();
                return Response.json({
                    ok: true,
                    result: await runner.run(buildWorkerToTeeRequest("us7000sonari")),
                });
            }
            return Response.json({ ok: true, value: relayerSidecarPreview() });
        });
        const app = createWorkerApp({
            now: () => baseNow,
            fetcher,
        });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processQueuedEvent(app, repository, queue, {
            RELAYER_MODE: "preview",
            ORACLE_SIDECAR_URL: "http://127.0.0.1:8789",
            RELAYER_TARGET: "0x123::disaster_oracle::submit_payload_v1",
            RELAYER_REGISTRY: "0x456",
        });

        expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/relayer/preview"]);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            relayer_status: "succeeded",
        });
    });

    it("uses RUNNER_SIDECAR_URL for the runner sidecar path", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new TestRunnerQueue();
        const calls: Request[] = [];
        const fetcher = vi.fn(async (input: RequestInfo | URL) => {
            const request = input instanceof Request ? input : new Request(input);
            calls.push(request.clone());
            const runner = new MockRunnerAdapter();
            return Response.json({
                ok: true,
                result: await runner.run(buildWorkerToTeeRequest("us7000sonari")),
            });
        });
        const app = createWorkerApp({
            now: () => baseNow,
            fetcher,
        });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processQueuedEvent(app, repository, queue, {
            RUNNER_SIDECAR_URL: "http://127.0.0.1:8789",
        });

        expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/process_data"]);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            relayer_status: null,
        });
    });

    it("prefers AWS runner credentials over RUNNER_SIDECAR_URL", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new TestRunnerQueue();
        const calls: Request[] = [];
        const fetcher = vi.fn(async (input: RequestInfo | URL) => {
            const request = input instanceof Request ? input : new Request(input);
            calls.push(request.clone());
            if (request.url.endsWith("/start")) {
                return Response.json({ ok: true, runner_id: "runner-123" });
            }
            if (request.url.endsWith("/process")) {
                const runner = new MockRunnerAdapter();
                return Response.json({
                    ok: true,
                    result: await runner.run(buildWorkerToTeeRequest("us7000sonari")),
                });
            }
            return Response.json({ ok: true });
        });
        const app = createWorkerApp({
            now: () => baseNow,
            fetcher,
        });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processQueuedEvent(app, repository, queue, {
            AWS_RUNNER_BASE_URL: "https://runner.example",
            AWS_RUNNER_TOKEN: "runner-token",
            RUNNER_SIDECAR_URL: "http://127.0.0.1:8789",
        });

        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
            "/start",
            "/process",
            "/stop",
        ]);
        expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
            "Bearer runner-token",
            "Bearer runner-token",
            "Bearer runner-token",
        ]);
    });

    it("passes dry_run mode gRPC settings to the relayer sidecar", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new TestRunnerQueue();
        const calls: Request[] = [];
        const fetcher = vi.fn(async (input: RequestInfo | URL) => {
            const request = input instanceof Request ? input : new Request(input);
            calls.push(request.clone());
            return Response.json({ ok: true, value: relayerSidecarPreview() });
        });
        const app = createWorkerApp({
            now: () => baseNow,
            fetcher,
            runner: new MockRunnerLifecycleAdapter(),
        });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processQueuedEvent(app, repository, queue, {
            RELAYER_MODE: "dry_run",
            ORACLE_SIDECAR_URL: "http://127.0.0.1:8789",
            RELAYER_TARGET: "0x123::disaster_oracle::submit_payload_v1",
            RELAYER_REGISTRY: "0x456",
            RELAYER_GRPC_URL: "https://fullnode.testnet.sui.io:443",
            RELAYER_SENDER_ADDRESS: "0xabc",
        });

        expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/relayer/dry_run"]);
        await expect(calls[0]?.json()).resolves.toMatchObject({
            grpcUrl: "https://fullnode.testnet.sui.io:443",
            senderAddress: "0xabc",
        });
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            relayer_mode: "dry_run",
            relayer_status: "succeeded",
        });
    });

    it("fails closed for invalid RELAYER_MODE without calling the sidecar", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new TestRunnerQueue();
        const fetcher = vi.fn(async () => Response.json({ ok: true }));
        const app = createWorkerApp({
            now: () => baseNow,
            fetcher,
            runner: new MockRunnerLifecycleAdapter(),
        });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processQueuedEvent(app, repository, queue, {
            RELAYER_MODE: "invalid",
            ORACLE_SIDECAR_URL: "http://127.0.0.1:8789",
            RELAYER_TARGET: "0x123::disaster_oracle::submit_payload_v1",
            RELAYER_REGISTRY: "0x456",
        });

        expect(fetcher).not.toHaveBeenCalled();
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            relayer_mode: "preview",
            relayer_status: "failed",
            relayer_error_code: "RELAYER_SUBMIT_FAILED",
        });
    });

    it("keeps submit mode fail-closed even when RELAYER_ALLOW_SUBMIT is true", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new TestRunnerQueue();
        const fetcher = vi.fn(async () =>
            Response.json({
                ok: true,
                value: {
                    request: {
                        target: "0x123::disaster_oracle::submit_payload_v1",
                        registry: "0x456",
                        arguments: ["0x456", [1], [2], [3]],
                        submitRequest: {
                            target: "0x123::disaster_oracle::submit_payload_v1",
                            registry: "0x456",
                            arguments: ["0x456", [1], [2], [3]],
                        },
                    },
                    digest: "7Zunexpected",
                },
            }),
        );
        const app = createWorkerApp({
            now: () => baseNow,
            fetcher,
            runner: new MockRunnerLifecycleAdapter(),
        });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processQueuedEvent(app, repository, queue, {
            RELAYER_MODE: "submit",
            RELAYER_ALLOW_SUBMIT: "true",
            ORACLE_SIDECAR_URL: "http://127.0.0.1:8789",
            RELAYER_TARGET: "0x123::disaster_oracle::submit_payload_v1",
            RELAYER_REGISTRY: "0x456",
        });

        expect(fetcher).not.toHaveBeenCalled();
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            relayer_mode: "submit",
            relayer_status: "failed",
            relayer_digest: null,
            relayer_error_code: "RELAYER_SUBMIT_FAILED",
        });
    });
});

function relayerSidecarPreview(): RelayerRequestPreview {
    return {
        target: "0x123::disaster_oracle::submit_payload_v1",
        registry: "0x456",
        arguments: ["0x456", [1], [2], [3]],
        submitRequest: {
            target: "0x123::disaster_oracle::submit_payload_v1",
            registry: "0x456",
            arguments: ["0x456", [1], [2], [3]],
        },
    };
}

async function processQueuedEvent(
    app: ReturnType<typeof createWorkerApp>,
    repository: InMemoryStateRepository,
    queue: TestRunnerQueue,
    envPatch: Partial<WorkerEnv>,
): Promise<void> {
    await app.fetch(new Request("https://watcher.test/tasks/process-due", { method: "POST" }), {
        ...env(repository),
        RUNNER_JOBS: queue,
        ...envPatch,
    });

    expect(queue.messages).toHaveLength(1);
    await app.queue(
        {
            messages: [
                {
                    body: queue.messages[0] as RunnerQueueJob,
                    ack: () => {},
                    retry: () => {},
                },
            ],
        },
        {
            ...env(repository),
            RUNNER_JOBS: queue,
            ...envPatch,
        },
    );
}
