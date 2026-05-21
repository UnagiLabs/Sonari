import type { SignedFinalizedPayload, TeeCoreResult, WorkerToTeeRequest } from "@sonari/oracle-shared";
import { describe, expect, it } from "vitest";
import type {
    RelayerAdapter,
    RelayerRequestPreview,
    RunnerJobQueue,
    RunnerLifecycleAdapter,
    RunnerQueueJob,
    WorkerEnv,
} from "../src/index.js";
import {
    enqueueDueEvents,
    FAILED_RETRY_BACKOFF_MS,
    FINALIZATION_WINDOW_MS,
    HOUR_MS,
    InMemoryStateRepository,
    MockRunnerLifecycleAdapter,
    PROCESSING_STALE_AFTER_MS,
    scanCandidates,
    createWorkerApp,
    RunnerProcessError,
} from "../src/index.js";
import type { EarthquakeEventRow, StateRepository } from "../src/state.js";
import type { UsgsEarthquakeCandidate } from "../src/usgs.js";

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

function env(repository: StateRepository, queue = new RecordingQueue()): WorkerEnv {
    return {
        EARTHQUAKE_EVENTS: repository,
        RUNNER_JOBS: queue,
        MANUAL_SUBMIT_TOKEN: "secret-token",
    };
}

describe("runner queue enqueue", () => {
    it("enqueues due rows without invoking the runner", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new RecordingQueue();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        const summary = await enqueueDueEvents(repository, queue, baseNow);

        expect(summary).toMatchObject({
            enqueued: 1,
            deferred: 0,
            recovered: 0,
            rejected: 0,
        });
        expect(queue.messages).toEqual([
            {
                runner_job_id: "us7000sonari:1",
                source_event_id: "us7000sonari",
                attempt: 1,
                enqueued_at_ms: baseNow,
            },
        ]);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "queued",
            runner_job_id: "us7000sonari:1",
            runner_attempt: 1,
            runner_queued_at_ms: baseNow,
            retry_count: 0,
        });
    });

    it("manual submit queues the event and returns 202 without direct runner execution", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new RecordingQueue();
        const runner = new RecordingRunnerLifecycleAdapter();
        const app = createWorkerApp({ now: () => baseNow, runner });

        const response = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                headers: { authorization: "Bearer secret-token" },
                body: JSON.stringify({
                    source_event_id: "us7000manual",
                    occurred_at_ms: baseNow - 25 * HOUR_MS,
                    source_updated_at_ms: baseNow - HOUR_MS,
                }),
            }),
            env(repository, queue),
        );

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
            accepted: true,
            source_event_id: "us7000manual",
            summary: { enqueued: 1 },
            event: {
                status: "queued",
                runner_job_id: "us7000manual:1",
            },
        });
        expect(runner.processRequests).toHaveLength(0);
        expect(queue.messages).toHaveLength(1);
    });

    it("recovers stale processing rows without clearing runner lifecycle evidence", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new RecordingQueue();

        await scanCandidates(repository, [candidate("us7000stale")], baseNow);
        const job = await repository.enqueueRunnerJob("us7000stale", 1, "us7000stale:1", baseNow);
        expect(job).not.toBeNull();
        await repository.claimQueuedForProcessing(
            {
                runner_job_id: "us7000stale:1",
                source_event_id: "us7000stale",
                attempt: 1,
                enqueued_at_ms: baseNow,
            },
            baseNow - PROCESSING_STALE_AFTER_MS - 1,
            baseNow + 30_000,
        );
        await repository.recordRunnerStarted(
            "us7000stale",
            "us7000stale:1",
            "runner-stale",
            baseNow - PROCESSING_STALE_AFTER_MS - 1,
            baseNow + 30_000,
        );

        const summary = await enqueueDueEvents(repository, queue, baseNow);

        expect(summary.recovered).toBe(1);
        expect(await repository.get("us7000stale")).toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_TIMEOUT",
            retry_count: 1,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
            runner_id: "runner-stale",
            runner_started_at_ms: baseNow - PROCESSING_STALE_AFTER_MS - 1,
            runner_stopped_at_ms: null,
        });
    });

    it("restores rows to new when queue send fails and retries only after backoff", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new FailingQueue(new Error("queue unavailable"));

        await scanCandidates(repository, [candidate("us7000sendfail")], baseNow);
        const summary = await enqueueDueEvents(repository, queue, baseNow);

        expect(summary.enqueued).toBe(0);
        expect(queue.calls).toBe(1);
        expect(await repository.get("us7000sendfail")).toMatchObject({
            status: "new",
            retry_count: 0,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
            runner_job_id: null,
            runner_queued_at_ms: null,
            runner_attempt: null,
            runner_error_message: "queue unavailable",
        });

        const beforeBackoffQueue = new RecordingQueue();
        const beforeBackoffSummary = await enqueueDueEvents(
            repository,
            beforeBackoffQueue,
            baseNow + FAILED_RETRY_BACKOFF_MS - 1,
        );
        expect(beforeBackoffSummary.enqueued).toBe(0);
        expect(beforeBackoffQueue.messages).toHaveLength(0);

        const retryQueue = new RecordingQueue();
        const retrySummary = await enqueueDueEvents(
            repository,
            retryQueue,
            baseNow + FAILED_RETRY_BACKOFF_MS,
        );
        expect(retrySummary.enqueued).toBe(1);
        expect(retryQueue.messages).toEqual([
            {
                runner_job_id: "us7000sendfail:1",
                source_event_id: "us7000sendfail",
                attempt: 1,
                enqueued_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
            },
        ]);
    });

    it("recovers stale queued rows to retryable new rows", async () => {
        const repository = new InMemoryStateRepository();
        const queue = new RecordingQueue();
        const queuedAtMs = baseNow - PROCESSING_STALE_AFTER_MS - 1;

        await scanCandidates(repository, [candidate("us7000stalequeued")], baseNow);
        const staleJob = await repository.enqueueRunnerJob(
            "us7000stalequeued",
            1,
            "us7000stalequeued:1",
            queuedAtMs,
        );
        expect(staleJob).not.toBeNull();

        const summary = await enqueueDueEvents(repository, queue, baseNow);

        expect(summary.recovered).toBe(1);
        expect(summary.enqueued).toBe(0);
        expect(await repository.get("us7000stalequeued")).toMatchObject({
            status: "new",
            retry_count: 0,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
            runner_job_id: null,
            runner_queued_at_ms: null,
            runner_attempt: null,
        });

        const retryQueue = new RecordingQueue();
        const retrySummary = await enqueueDueEvents(
            repository,
            retryQueue,
            baseNow + FAILED_RETRY_BACKOFF_MS,
        );
        expect(retrySummary.enqueued).toBe(1);
    });
});

describe("runner queue consumer", () => {
    it("claims queued jobs before invoking AWS runner lifecycle", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new RecordingRunnerLifecycleAdapter();
        const relayer = new RecordingRelayerAdapter();
        const app = createWorkerApp({ now: () => baseNow, runner, relayer });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        const job = await repository.enqueueRunnerJob("us7000sonari", 1, "us7000sonari:1", baseNow);
        expect(job).not.toBeNull();
        const message = new FakeQueueMessage(job as RunnerQueueJob);

        await app.queue({ messages: [message] }, env(repository));

        expect(message.acked).toBe(true);
        expect(runner.starts).toBe(1);
        expect(runner.processRequests).toEqual([
            {
                source_event_id: "us7000sonari",
                hazard_type: 1,
                primary_source: 1,
                geo_resolution: 7,
            },
        ]);
        expect(runner.stops).toEqual(["runner-1"]);
        expect(relayer.inputs).toHaveLength(1);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            event_uid: "us7000sonari",
            runner_id: "runner-1",
            runner_started_at_ms: baseNow,
            runner_stopped_at_ms: baseNow,
            relayer_status: "succeeded",
        });
    });

    it("acks duplicate, stale, and terminal jobs without invoking AWS", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new RecordingRunnerLifecycleAdapter();
        const app = createWorkerApp({ now: () => baseNow, runner });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        const job = await repository.enqueueRunnerJob("us7000sonari", 1, "us7000sonari:1", baseNow);
        expect(job).not.toBeNull();
        await repository.claimQueuedForProcessing(job as RunnerQueueJob, baseNow, baseNow + 30_000);

        const duplicate = new FakeQueueMessage(job as RunnerQueueJob);
        await app.queue({ messages: [duplicate] }, env(repository));

        expect(duplicate.acked).toBe(true);
        expect(runner.starts).toBe(0);
    });

    it("maps AWS start failures to failed rows without trying to stop a missing runner", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new RecordingRunnerLifecycleAdapter({
            startError: new Error("start failed"),
        });
        const app = createWorkerApp({ now: () => baseNow, runner });

        await scanCandidates(repository, [candidate("us7000startfail")], baseNow);
        const job = await repository.enqueueRunnerJob(
            "us7000startfail",
            1,
            "us7000startfail:1",
            baseNow,
        );

        const message = new FakeQueueMessage(job as RunnerQueueJob);
        await app.queue({ messages: [message] }, env(repository));

        expect(message.acked).toBe(true);
        expect(runner.stops).toEqual([]);
        expect(await repository.get("us7000startfail")).toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_START_FAILED",
            runner_error_message: "start failed",
            retry_count: 1,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
        });
    });

    it("maps AWS process failures to failed rows and still stops the runner", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new RecordingRunnerLifecycleAdapter({
            processError: new Error("HTTP 503 from runner"),
        });
        const app = createWorkerApp({ now: () => baseNow, runner });

        await scanCandidates(repository, [candidate("us7000timeout")], baseNow);
        const job = await repository.enqueueRunnerJob("us7000timeout", 1, "us7000timeout:1", baseNow);

        const message = new FakeQueueMessage(job as RunnerQueueJob);
        await app.queue({ messages: [message] }, env(repository));

        expect(message.acked).toBe(true);
        expect(runner.stops).toEqual(["runner-1"]);
        expect(await repository.get("us7000timeout")).toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_PROCESS_FAILED",
            runner_error_message: "HTTP 503 from runner",
            retry_count: 1,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
        });
    });

    it("preserves shared AWS process error codes returned by the runner", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new RecordingRunnerLifecycleAdapter({
            processError: new RunnerProcessError("bad bcs", "BCS_SERIALIZATION_FAILED"),
        });
        const app = createWorkerApp({ now: () => baseNow, runner });

        await scanCandidates(repository, [candidate("us7000badbcs")], baseNow);
        const job = await repository.enqueueRunnerJob("us7000badbcs", 1, "us7000badbcs:1", baseNow);

        const message = new FakeQueueMessage(job as RunnerQueueJob);
        await app.queue({ messages: [message] }, env(repository));

        expect(await repository.get("us7000badbcs")).toMatchObject({
            status: "failed",
            error_code: "BCS_SERIALIZATION_FAILED",
            runner_error_message: "bad bcs",
        });
    });

    it("records stop failures without overwriting the main result", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new RecordingRunnerLifecycleAdapter({
            stopError: new Error("stop failed"),
            result: {
                status: "pending_source",
                source_event_id: "us7000pending",
                error_code: "SHAKEMAP_PRODUCT_MISSING",
            },
        });
        const app = createWorkerApp({ now: () => baseNow, runner });

        await scanCandidates(repository, [candidate("us7000pending")], baseNow);
        const job = await repository.enqueueRunnerJob("us7000pending", 1, "us7000pending:1", baseNow);

        const message = new FakeQueueMessage(job as RunnerQueueJob);
        await app.queue({ messages: [message] }, env(repository));

        expect(message.acked).toBe(true);
        expect(await repository.get("us7000pending")).toMatchObject({
            status: "pending_source",
            error_code: "SHAKEMAP_PRODUCT_MISSING",
            runner_stop_error: "stop failed",
            runner_stopped_at_ms: null,
        });
    });

    it("fails malformed finalized results before relayer preview", async () => {
        const repository = new InMemoryStateRepository();
        const relayer = new RecordingRelayerAdapter();
        const runner = new RecordingRunnerLifecycleAdapter({
            result: {
                status: "finalized",
                payload: {
                    event_uid: "us7000bad",
                    event_revision: 1,
                    source_updated_at_ms: baseNow,
                },
                payload_bcs_hex: "",
                signature: "0xsig",
                public_key: "0xpub",
            },
        });
        const app = createWorkerApp({ now: () => baseNow, runner, relayer });

        await scanCandidates(repository, [candidate("us7000bad")], baseNow);
        const job = await repository.enqueueRunnerJob("us7000bad", 1, "us7000bad:1", baseNow);

        const message = new FakeQueueMessage(job as RunnerQueueJob);
        await app.queue({ messages: [message] }, env(repository));

        expect(relayer.inputs).toHaveLength(0);
        expect(await repository.get("us7000bad")).toMatchObject({
            status: "failed",
            error_code: "BCS_SERIALIZATION_FAILED",
            event_uid: null,
            retry_count: 1,
        });
    });
});

class RecordingQueue implements RunnerJobQueue {
    readonly messages: RunnerQueueJob[] = [];

    async send(message: RunnerQueueJob): Promise<void> {
        this.messages.push(structuredClone(message));
    }
}

class FailingQueue implements RunnerJobQueue {
    calls = 0;

    constructor(private readonly error: Error) {}

    async send(_message: RunnerQueueJob): Promise<void> {
        this.calls += 1;
        throw this.error;
    }
}

class FakeQueueMessage {
    acked = false;
    retried = false;

    constructor(readonly body: RunnerQueueJob) {}

    ack(): void {
        this.acked = true;
    }

    retry(): void {
        this.retried = true;
    }
}

class RecordingRunnerLifecycleAdapter implements RunnerLifecycleAdapter {
    starts = 0;
    readonly stops: string[] = [];
    readonly processRequests: WorkerToTeeRequest[] = [];

    constructor(
        private readonly options: {
            result?: TeeCoreResult;
            startError?: Error;
            processError?: Error;
            stopError?: Error;
        } = {},
    ) {}

    async start(): Promise<{ runner_id: string }> {
        if (this.options.startError !== undefined) {
            throw this.options.startError;
        }
        this.starts += 1;
        return { runner_id: `runner-${this.starts}` };
    }

    async process(
        _runnerId: string,
        request: WorkerToTeeRequest,
        _signal?: AbortSignal,
    ): Promise<TeeCoreResult> {
        this.processRequests.push(structuredClone(request));
        if (this.options.processError !== undefined) {
            throw this.options.processError;
        }
        return (
            this.options.result ?? {
                status: "finalized",
                payload: {
                    event_uid: request.source_event_id,
                    event_revision: 3,
                    source_updated_at_ms: baseNow - HOUR_MS,
                },
                payload_bcs_hex: "0x01",
                signature: "0xsig",
                public_key: "0xpub",
            }
        );
    }

    async stop(runnerId: string): Promise<void> {
        if (this.options.stopError !== undefined) {
            throw this.options.stopError;
        }
        this.stops.push(runnerId);
    }
}

class RecordingRelayerAdapter implements RelayerAdapter {
    readonly mode = "preview" as const;
    readonly inputs: SignedFinalizedPayload[] = [];
    readonly preview: RelayerRequestPreview = {
        target: "0x123::disaster_oracle::submit_payload_v1",
        registry: "0x456",
        verifierRegistry: "0x654",
        clock: "0x0000000000000000000000000000000000000000000000000000000000000006",
        arguments: [
            "0x456",
            "0x654",
            "0x0000000000000000000000000000000000000000000000000000000000000006",
            [1],
            [2],
            [3],
        ],
        submitRequest: {
            target: "0x123::disaster_oracle::submit_payload_v1",
            registry: "0x456",
            verifierRegistry: "0x654",
            clock: "0x0000000000000000000000000000000000000000000000000000000000000006",
            arguments: [
                "0x456",
                "0x654",
                "0x0000000000000000000000000000000000000000000000000000000000000006",
                [1],
                [2],
                [3],
            ],
        },
    };

    async relay(input: SignedFinalizedPayload) {
        this.inputs.push(structuredClone(input));
        return { ok: true as const, value: { mode: "preview" as const, request: this.preview } };
    }
}
