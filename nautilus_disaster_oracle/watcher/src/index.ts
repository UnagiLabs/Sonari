import {
    BCS_ENUMS,
    DEFAULT_ORACLE_CONTRACT,
    ERROR_CODES,
    type OffchainStatus,
    type OracleErrorCode,
    type SignedFinalizedPayload,
    type TeeCoreResult,
    validateWorkerToTeeRequest,
    type WorkerToTeeRequest,
} from "@sonari/oracle-shared";
import {
    DAY_MS,
    DEFAULT_DUE_LIMIT,
    FAILED_RETRY_BACKOFF_MS,
    FINALIZATION_WINDOW_MS,
    HOUR_MS,
    PROCESSING_STALE_AFTER_MS,
} from "./constants.js";
import { HttpRelayerPreviewAdapter, type RelayerPreviewAdapter } from "./relayer_preview.js";
import {
    D1StateRepository,
    type EarthquakeEventRow,
    type RunnerQueueJob,
    type StateRepository,
    type UpsertCandidateOptions,
} from "./state.js";
import {
    AwsRunnerLifecycleAdapter,
    MockRunnerLifecycleAdapter,
    type RunnerAdapter,
    type RunnerLifecycleAdapter,
    RunnerProcessError,
} from "./trigger_tee.js";
import { fetchUsgsRecentCandidates, type UsgsEarthquakeCandidate } from "./usgs.js";

export {
    DAY_MS,
    DEFAULT_DUE_LIMIT,
    FAILED_RETRY_BACKOFF_MS,
    FINALIZATION_WINDOW_MS,
    HOUR_MS,
    PROCESSING_STALE_AFTER_MS,
} from "./constants.js";
export type {
    RelayerPreviewAdapter,
    RelayerPreviewErrorCode,
    RelayerPreviewResult,
    RelayerRequestPreview,
} from "./relayer_preview.js";
export { HttpRelayerPreviewAdapter } from "./relayer_preview.js";
export {
    screenUsgsCandidate,
    WATCHER_ALERT_LEVELS,
    WATCHER_MIN_MAGNITUDE,
    WATCHER_MIN_SUMMARY_MMI,
} from "./screening.js";
export type {
    EarthquakeEventRow,
    RunnerQueueJob,
    StateRepository,
    UpsertCandidateOptions,
} from "./state.js";
export { D1StateRepository, InMemoryStateRepository } from "./state.js";
export type { RunnerAdapter, RunnerLifecycleAdapter } from "./trigger_tee.js";
export {
    AwsRunnerLifecycleAdapter,
    HttpRunnerAdapter,
    MockRunnerAdapter,
    MockRunnerLifecycleAdapter,
    RunnerProcessError,
} from "./trigger_tee.js";
export type { UsgsEarthquakeCandidate } from "./usgs.js";
export {
    fetchUsgsRecentCandidates,
    parseUsgsRecentFeed,
    USGS_RECENT_FEED_URL,
} from "./usgs.js";

const TERMINAL_STATUSES = new Set<OffchainStatus>([
    "ignored_small",
    "finalized",
    "submitted",
    "rejected",
]);

export interface WorkerEnv {
    EARTHQUAKE_EVENTS?: StateRepository | D1Database;
    RUNNER_JOBS?: RunnerJobQueue;
    MANUAL_SUBMIT_TOKEN?: string;
    ORACLE_SIDECAR_URL?: string;
    RELAYER_TARGET?: string;
    RELAYER_REGISTRY?: string;
    AWS_RUNNER_BASE_URL?: string;
    AWS_RUNNER_TOKEN?: string;
    AWS_RUNNER_TIMEOUT_MS?: string;
}

export interface ExecutionContextLike {
    waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerAppOptions {
    now?: () => number;
    runner?: RunnerLifecycleAdapter;
    relayerPreview?: RelayerPreviewAdapter;
    fetcher?: typeof fetch;
}

export interface RunnerJobQueue {
    send(message: RunnerQueueJob): Promise<unknown>;
}

export interface RunnerJobMessage {
    body: RunnerQueueJob;
    ack(): void;
    retry(): void;
}

export interface RunnerMessageBatch {
    messages: RunnerJobMessage[];
}

export interface EnqueueSummary {
    enqueued: number;
    deferred: number;
    recovered: number;
    rejected: number;
}

export interface ProcessSummary {
    processed: number;
    deferred: number;
    recovered: number;
    failed: number;
    rejected: number;
}

interface JsonResponseInit {
    status?: number;
}

type AppliedRunnerResult =
    | { finalized: false }
    | { finalized: true; result: SignedFinalizedPayload };

export function buildWorkerToTeeRequest(source_event_id: string): WorkerToTeeRequest {
    const validation = validateWorkerToTeeRequest({
        source_event_id,
        hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
        primary_source: BCS_ENUMS.primarySource.USGS,
        geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
    });

    if (!validation.ok) {
        throw new Error(validation.message);
    }

    return validation.value;
}

export async function scanCandidates(
    repository: StateRepository,
    candidates: readonly UsgsEarthquakeCandidate[],
    nowMs: number,
    options: UpsertCandidateOptions = {},
): Promise<number> {
    for (const candidate of candidates) {
        await repository.upsertCandidate(candidate, nowMs, options);
    }
    return candidates.length;
}

export async function enqueueDueEvents(
    repository: StateRepository,
    queue: RunnerJobQueue,
    nowMs: number,
    limit = DEFAULT_DUE_LIMIT,
): Promise<EnqueueSummary> {
    const summary: EnqueueSummary = {
        enqueued: 0,
        deferred: 0,
        recovered: 0,
        rejected: 0,
    };

    summary.recovered = await repository.recoverStaleProcessing(
        nowMs - PROCESSING_STALE_AFTER_MS,
        nowMs,
        nowMs + FAILED_RETRY_BACKOFF_MS,
    );
    summary.recovered += await repository.recoverStaleQueued(
        nowMs - PROCESSING_STALE_AFTER_MS,
        nowMs,
        nowMs + FAILED_RETRY_BACKOFF_MS,
    );

    const rows = await repository.listDue(nowMs, limit);
    for (const row of rows) {
        await enqueueSingleDueEvent(repository, queue, row, nowMs, summary);
    }

    return summary;
}

/**
 * Test/local compatibility helper that executes due runner jobs inline.
 * Worker runtime paths enqueue jobs only; runner execution belongs to the Queue consumer.
 */
export async function processDueEventsInlineForTests(
    repository: StateRepository,
    runner: RunnerAdapter,
    nowMs: number,
    limit = DEFAULT_DUE_LIMIT,
    relayerPreview?: RelayerPreviewAdapter,
): Promise<ProcessSummary> {
    const queue = new InlineQueue();
    const enqueueSummary = await enqueueDueEvents(repository, queue, nowMs, limit);
    const lifecycleRunner = new RunnerAdapterLifecycleBridge(runner);
    let processed = 0;
    let failed = 0;

    for (const job of queue.messages) {
        const before = await repository.get(job.source_event_id);
        await handleRunnerQueueMessage(
            repository,
            lifecycleRunner,
            new InlineMessage(job),
            nowMs,
            30_000,
            relayerPreview,
        );
        const after = await repository.get(job.source_event_id);
        if (before !== null && after?.status === "failed" && before.status !== "failed") {
            failed += 1;
        } else {
            processed += 1;
        }
    }

    return {
        processed,
        deferred: enqueueSummary.deferred,
        recovered: enqueueSummary.recovered,
        failed,
        rejected: enqueueSummary.rejected,
    };
}

export function createWorkerApp(options: WorkerAppOptions = {}) {
    const now = options.now ?? Date.now;
    const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));

    return {
        async fetch(request: Request, env: WorkerEnv): Promise<Response> {
            const url = new URL(request.url);

            if (request.method === "GET" && url.pathname === "/health") {
                return json({ ok: true, service: "sonari-oracle-watcher" });
            }

            const repository = repositoryFromEnv(env);

            if (request.method === "POST" && url.pathname === "/manual/earthquakes") {
                return handleManualEarthquake(request, env, repository, now());
            }

            if (request.method === "POST" && url.pathname === "/tasks/process-due") {
                const summary = await enqueueDueEvents(
                    repository,
                    queueFromEnv(env),
                    now(),
                    DEFAULT_DUE_LIMIT,
                );
                return json({ ok: true, summary });
            }

            return json({ ok: false, error: "not_found" }, { status: 404 });
        },

        async scheduled(
            _controller: unknown,
            env: WorkerEnv,
            _ctx?: ExecutionContextLike,
        ): Promise<void> {
            const nowMs = now();
            const repository = repositoryFromEnv(env);
            const queue = queueFromEnv(env);
            const candidates = await fetchUsgsRecentCandidates(fetcher);
            await scanCandidates(repository, candidates, nowMs);
            await enqueueDueEvents(repository, queue, nowMs, DEFAULT_DUE_LIMIT);
        },

        async queue(batch: RunnerMessageBatch, env: WorkerEnv): Promise<void> {
            const repository = repositoryFromEnv(env);
            const runner = options.runner ?? runnerFromEnv(env, fetcher);
            const relayerPreview = options.relayerPreview ?? relayerPreviewFromEnv(env, fetcher);
            for (const message of batch.messages) {
                await handleRunnerQueueMessage(
                    repository,
                    runner,
                    message,
                    now(),
                    runnerTimeoutMsFromEnv(env),
                    relayerPreview,
                );
            }
        },
    };
}

async function handleManualEarthquake(
    request: Request,
    env: WorkerEnv,
    repository: StateRepository,
    nowMs: number,
): Promise<Response> {
    if (env.MANUAL_SUBMIT_TOKEN === undefined || env.MANUAL_SUBMIT_TOKEN.length === 0) {
        return json({ ok: false, error: "manual_submit_token_not_configured" }, { status: 503 });
    }

    if (request.headers.get("authorization") !== `Bearer ${env.MANUAL_SUBMIT_TOKEN}`) {
        return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const body = await readJson(request);
    if (!isRecord(body)) {
        return json({ ok: false, error: "invalid_json" }, { status: 400 });
    }

    const sourceEventId = readSourceEventId(body);
    if (sourceEventId === null) {
        return json({ ok: false, error: "invalid_source_event_id" }, { status: 400 });
    }

    const occurredAtMs = readOptionalMs(body.occurred_at_ms) ?? nowMs;
    const sourceUpdatedAtMs = readOptionalMs(body.source_updated_at_ms) ?? nowMs;

    await scanCandidates(
        repository,
        [
            {
                source_event_id: sourceEventId,
                occurred_at_ms: occurredAtMs,
                source_updated_at_ms: sourceUpdatedAtMs,
                magnitude: null,
                summary_mmi: null,
                alert: null,
                tsunami: false,
            },
        ],
        nowMs,
        { bypassScreening: true },
    );

    const summary = emptyEnqueueSummary();
    const row = await repository.get(sourceEventId);
    if (row !== null) {
        await enqueueSingleDueEvent(repository, queueFromEnv(env), row, nowMs, summary);
    }

    return json(
        {
            accepted: true,
            source_event_id: sourceEventId,
            summary,
            event: await repository.get(sourceEventId),
        },
        { status: 202 },
    );
}

async function enqueueSingleDueEvent(
    repository: StateRepository,
    queue: RunnerJobQueue,
    row: EarthquakeEventRow,
    nowMs: number,
    summary: EnqueueSummary,
): Promise<void> {
    if (TERMINAL_STATUSES.has(row.status)) {
        return;
    }

    const occurredAtMs = row.finalization_deadline_at_ms - FINALIZATION_WINDOW_MS;
    const firstEligibleAtMs = occurredAtMs + DAY_MS;

    if (nowMs < firstEligibleAtMs) {
        await repository.deferUntil(row.source_event_id, firstEligibleAtMs, nowMs);
        summary.deferred += 1;
        return;
    }

    if (isDeadlineExceededPending(row.status, nowMs, row.finalization_deadline_at_ms)) {
        await repository.markRejected(row.source_event_id, "REJECTED_AUTO_TRIGGER", nowMs);
        summary.rejected += 1;
        return;
    }

    const attempt = row.retry_count + 1;
    const runnerJobId = `${row.source_event_id}:${attempt}`;
    const job = await repository.enqueueRunnerJob(row.source_event_id, attempt, runnerJobId, nowMs);
    if (job === null) {
        return;
    }

    try {
        await queue.send(job);
        summary.enqueued += 1;
    } catch (error) {
        await repository.markQueueEnqueueFailed(
            row.source_event_id,
            runnerJobId,
            nowMs,
            nowMs + FAILED_RETRY_BACKOFF_MS,
            errorMessage(error),
        );
    }
}

async function handleRunnerQueueMessage(
    repository: StateRepository,
    runner: RunnerLifecycleAdapter,
    message: RunnerJobMessage,
    nowMs: number,
    timeoutMs: number,
    relayerPreview?: RelayerPreviewAdapter,
): Promise<void> {
    const job = message.body;
    if (!isRunnerQueueJob(job)) {
        message.ack();
        return;
    }

    const row = await repository.get(job.source_event_id);
    if (!shouldClaimQueueJob(row, job)) {
        message.ack();
        return;
    }

    const timeoutAtMs = nowMs + timeoutMs;
    const claimed = await repository.claimQueuedForProcessing(job, nowMs, timeoutAtMs);
    if (!claimed) {
        message.ack();
        return;
    }

    let runnerId: string | null = null;
    try {
        const started = await runner.start();
        runnerId = started.runner_id;
        await repository.recordRunnerStarted(
            job.source_event_id,
            job.runner_job_id,
            runnerId,
            nowMs,
            timeoutAtMs,
        );
        const result = await processWithTimeout(
            runner,
            runnerId,
            buildWorkerToTeeRequest(job.source_event_id),
            timeoutMs,
        );
        const applied = await applyRunnerResult(repository, job.source_event_id, result, nowMs);
        if (applied.finalized) {
            await runRelayerPreview(
                repository,
                job.source_event_id,
                applied.result,
                nowMs,
                relayerPreview,
            );
        }
    } catch (error) {
        await repository.markFailed(
            job.source_event_id,
            mapRunnerErrorCode(error),
            nowMs,
            nowMs + FAILED_RETRY_BACKOFF_MS,
            errorMessage(error),
        );
    } finally {
        if (runnerId !== null) {
            try {
                await runner.stop(runnerId);
                await repository.recordRunnerStopped(job.source_event_id, job.runner_job_id, nowMs);
            } catch (error) {
                await repository.recordRunnerStopFailed(
                    job.source_event_id,
                    job.runner_job_id,
                    errorMessage(error),
                    nowMs,
                );
            }
        }
    }

    message.ack();
}

async function applyRunnerResult(
    repository: StateRepository,
    sourceEventId: string,
    result: TeeCoreResult,
    nowMs: number,
): Promise<AppliedRunnerResult> {
    if (result.status === "finalized") {
        if (!hasValidFinalizedResult(result)) {
            await repository.markFailed(
                sourceEventId,
                "BCS_SERIALIZATION_FAILED",
                nowMs,
                nowMs + FAILED_RETRY_BACKOFF_MS,
            );
            return { finalized: false };
        }

        await repository.applyRunnerResult(sourceEventId, result, nowMs);
        return { finalized: true, result };
    }

    if (result.status === "pending_source" || result.status === "pending_mmi") {
        const row = await repository.get(sourceEventId);
        if (
            row !== null &&
            isDeadlineExceededPending(result.status, nowMs, row.finalization_deadline_at_ms)
        ) {
            await repository.markRejected(sourceEventId, "REJECTED_AUTO_TRIGGER", nowMs);
            return { finalized: false };
        }
        if (row !== null) {
            const nextRetryAtMs = Math.min(nowMs + HOUR_MS, row.finalization_deadline_at_ms);
            await repository.applyRunnerResult(sourceEventId, result, nowMs, nextRetryAtMs);
            return { finalized: false };
        }
    }

    await repository.applyRunnerResult(sourceEventId, result, nowMs);
    return { finalized: false };
}

async function runRelayerPreview(
    repository: StateRepository,
    sourceEventId: string,
    result: SignedFinalizedPayload,
    nowMs: number,
    relayerPreview?: RelayerPreviewAdapter,
): Promise<void> {
    if (relayerPreview === undefined) {
        return;
    }

    try {
        const previewResult = await relayerPreview.previewRelayerRequest(result);
        if (previewResult.ok) {
            await repository.markRelayerPreviewSucceeded(sourceEventId, previewResult.value, nowMs);
            return;
        }
        await repository.markRelayerPreviewFailed(
            sourceEventId,
            previewResult.error_code,
            previewResult.message,
            nowMs,
        );
    } catch (error) {
        await repository.markRelayerPreviewFailed(
            sourceEventId,
            "RELAYER_SUBMIT_FAILED",
            errorMessage(error),
            nowMs,
        );
    }
}

function isDeadlineExceededPending(
    status: OffchainStatus,
    nowMs: number,
    deadlineAtMs: number,
): boolean {
    return (status === "pending_source" || status === "pending_mmi") && nowMs >= deadlineAtMs;
}

function repositoryFromEnv(env: WorkerEnv): StateRepository {
    if (env.EARTHQUAKE_EVENTS === undefined) {
        throw new Error("EARTHQUAKE_EVENTS binding is required");
    }
    if (isStateRepository(env.EARTHQUAKE_EVENTS)) {
        return env.EARTHQUAKE_EVENTS;
    }
    return new D1StateRepository(env.EARTHQUAKE_EVENTS);
}

function queueFromEnv(env: WorkerEnv): RunnerJobQueue {
    if (env.RUNNER_JOBS === undefined) {
        throw new Error("RUNNER_JOBS binding is required");
    }
    return env.RUNNER_JOBS;
}

function runnerFromEnv(env: WorkerEnv, fetcher: typeof fetch): RunnerLifecycleAdapter {
    if (isNonEmptyString(env.AWS_RUNNER_BASE_URL) && isNonEmptyString(env.AWS_RUNNER_TOKEN)) {
        return new AwsRunnerLifecycleAdapter({
            baseUrl: env.AWS_RUNNER_BASE_URL,
            token: env.AWS_RUNNER_TOKEN,
            fetcher,
        });
    }
    return new MockRunnerLifecycleAdapter();
}

function relayerPreviewFromEnv(
    env: WorkerEnv,
    fetcher: typeof fetch,
): RelayerPreviewAdapter | undefined {
    if (
        isNonEmptyString(env.ORACLE_SIDECAR_URL) &&
        isNonEmptyString(env.RELAYER_TARGET) &&
        isNonEmptyString(env.RELAYER_REGISTRY)
    ) {
        return new HttpRelayerPreviewAdapter(
            {
                sidecarUrl: env.ORACLE_SIDECAR_URL,
                target: env.RELAYER_TARGET,
                registry: env.RELAYER_REGISTRY,
            },
            fetcher,
        );
    }
    return undefined;
}

function isStateRepository(input: StateRepository | D1Database): input is StateRepository {
    return typeof input === "object" && input !== null && "upsertCandidate" in input;
}

function isNonEmptyString(input: unknown): input is string {
    return typeof input === "string" && input.length > 0;
}

function json(body: unknown, init: JsonResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

async function readJson(request: Request): Promise<unknown> {
    try {
        return await request.json();
    } catch {
        return null;
    }
}

function readSourceEventId(body: Record<string, unknown>): string | null {
    const value = body.source_event_id ?? body.id;
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readOptionalMs(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function hasValidFinalizedResult(result: SignedFinalizedPayload): boolean {
    const payload = result.payload;
    if (!isRecord(payload)) {
        return false;
    }
    return (
        typeof payload.event_uid === "string" &&
        payload.event_uid.length > 0 &&
        Number.isSafeInteger(payload.event_revision) &&
        Number.isSafeInteger(payload.source_updated_at_ms) &&
        isNonEmptyString(result.payload_bcs_hex) &&
        isNonEmptyString(result.signature) &&
        isNonEmptyString(result.public_key)
    );
}

function emptyEnqueueSummary(): EnqueueSummary {
    return {
        enqueued: 0,
        deferred: 0,
        recovered: 0,
        rejected: 0,
    };
}

function shouldClaimQueueJob(row: EarthquakeEventRow | null, job: RunnerQueueJob): boolean {
    return (
        row !== null &&
        row.status === "queued" &&
        row.runner_job_id === job.runner_job_id &&
        row.runner_attempt === job.attempt &&
        row.retry_count === job.attempt - 1
    );
}

function isRunnerQueueJob(input: unknown): input is RunnerQueueJob {
    const attempt = isRecord(input) ? input.attempt : undefined;
    return (
        isRecord(input) &&
        isNonEmptyString(input.runner_job_id) &&
        isNonEmptyString(input.source_event_id) &&
        Number.isSafeInteger(attempt) &&
        Number(attempt) > 0 &&
        Number.isSafeInteger(input.enqueued_at_ms)
    );
}

async function processWithTimeout(
    runner: RunnerLifecycleAdapter,
    runnerId: string,
    request: WorkerToTeeRequest,
    timeoutMs: number,
): Promise<TeeCoreResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            runner.process(runnerId, request, controller.signal),
            new Promise<TeeCoreResult>((_resolve, reject) => {
                timeout = setTimeout(() => {
                    controller.abort();
                    reject(new Error(`AWS runner timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

function mapRunnerErrorCode(error: unknown): OracleErrorCode {
    if (
        error instanceof RunnerProcessError &&
        error.errorCode !== undefined &&
        (ERROR_CODES as readonly string[]).includes(error.errorCode)
    ) {
        return error.errorCode;
    }
    return "AWS_RUNNER_TIMEOUT";
}

function runnerTimeoutMsFromEnv(env: WorkerEnv): number {
    if (env.AWS_RUNNER_TIMEOUT_MS === undefined) {
        return 30_000;
    }
    const parsed = Number(env.AWS_RUNNER_TIMEOUT_MS);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 30_000;
}

class InlineQueue implements RunnerJobQueue {
    readonly messages: RunnerQueueJob[] = [];

    async send(message: RunnerQueueJob): Promise<void> {
        this.messages.push(structuredClone(message));
    }
}

class InlineMessage implements RunnerJobMessage {
    constructor(readonly body: RunnerQueueJob) {}

    ack(): void {}

    retry(): void {}
}

class RunnerAdapterLifecycleBridge implements RunnerLifecycleAdapter {
    constructor(private readonly runner: RunnerAdapter) {}

    async start(): Promise<{ runner_id: string }> {
        return { runner_id: "inline-runner" };
    }

    async process(
        _runnerId: string,
        request: WorkerToTeeRequest,
        _signal?: AbortSignal,
    ): Promise<TeeCoreResult> {
        return this.runner.run(request);
    }

    async stop(_runnerId: string): Promise<void> {}
}

const app = createWorkerApp();

export default app;
