import {
    BCS_ENUMS,
    DEFAULT_ORACLE_CONTRACT,
    type OffchainStatus,
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
    PROCESSING_STALE_AFTER_MS,
} from "./constants.js";
import { HttpRelayerPreviewAdapter, type RelayerPreviewAdapter } from "./relayer_preview.js";
import {
    D1StateRepository,
    type EarthquakeEventRow,
    type StateRepository,
    type UpsertCandidateOptions,
} from "./state.js";
import { HttpRunnerAdapter, MockRunnerAdapter, type RunnerAdapter } from "./trigger_tee.js";
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
export type { EarthquakeEventRow, StateRepository, UpsertCandidateOptions } from "./state.js";
export { D1StateRepository, InMemoryStateRepository } from "./state.js";
export type { RunnerAdapter, RunnerContext } from "./trigger_tee.js";
export { HttpRunnerAdapter, MockRunnerAdapter } from "./trigger_tee.js";
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
    MANUAL_SUBMIT_TOKEN?: string;
    ORACLE_SIDECAR_URL?: string;
    RELAYER_TARGET?: string;
    RELAYER_REGISTRY?: string;
}

export interface ExecutionContextLike {
    waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerAppOptions {
    now?: () => number;
    runner?: RunnerAdapter;
    relayerPreview?: RelayerPreviewAdapter;
    fetcher?: typeof fetch;
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
        request_type: "DETECT_BY_EVENT_ID",
        hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
        primary_source: BCS_ENUMS.primarySource.USGS,
        source_event_id,
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

export async function processDueEvents(
    repository: StateRepository,
    runner: RunnerAdapter,
    nowMs: number,
    limit = DEFAULT_DUE_LIMIT,
    relayerPreview?: RelayerPreviewAdapter,
): Promise<ProcessSummary> {
    const summary: ProcessSummary = {
        processed: 0,
        deferred: 0,
        recovered: 0,
        failed: 0,
        rejected: 0,
    };

    summary.recovered = await repository.recoverStaleProcessing(
        nowMs - PROCESSING_STALE_AFTER_MS,
        nowMs,
        nowMs + FAILED_RETRY_BACKOFF_MS,
    );

    const rows = await repository.listDue(nowMs, limit);
    for (const row of rows) {
        await processSingleDueEvent(repository, runner, row, nowMs, summary, relayerPreview);
    }

    return summary;
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
            const runner = options.runner ?? runnerFromEnv(env, fetcher);
            const relayerPreview = options.relayerPreview ?? relayerPreviewFromEnv(env, fetcher);

            if (request.method === "POST" && url.pathname === "/manual/earthquakes") {
                return handleManualEarthquake(
                    request,
                    env,
                    repository,
                    runner,
                    now(),
                    relayerPreview,
                );
            }

            if (request.method === "POST" && url.pathname === "/tasks/process-due") {
                const summary = await processDueEvents(
                    repository,
                    runner,
                    now(),
                    DEFAULT_DUE_LIMIT,
                    relayerPreview,
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
            const runner = options.runner ?? runnerFromEnv(env, fetcher);
            const relayerPreview = options.relayerPreview ?? relayerPreviewFromEnv(env, fetcher);
            const candidates = await fetchUsgsRecentCandidates(fetcher);
            await scanCandidates(repository, candidates, nowMs);
            await processDueEvents(repository, runner, nowMs, DEFAULT_DUE_LIMIT, relayerPreview);
        },
    };
}

async function handleManualEarthquake(
    request: Request,
    env: WorkerEnv,
    repository: StateRepository,
    runner: RunnerAdapter,
    nowMs: number,
    relayerPreview?: RelayerPreviewAdapter,
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

    const summary = emptyProcessSummary();
    const row = await repository.get(sourceEventId);
    if (row !== null) {
        await processSingleDueEvent(repository, runner, row, nowMs, summary, relayerPreview);
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

async function processSingleDueEvent(
    repository: StateRepository,
    runner: RunnerAdapter,
    row: EarthquakeEventRow,
    nowMs: number,
    summary: ProcessSummary,
    relayerPreview?: RelayerPreviewAdapter,
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

    const claimed = await repository.claimForProcessing(row.source_event_id, nowMs);
    if (!claimed) {
        return;
    }

    try {
        const result = await runner.run(buildWorkerToTeeRequest(row.source_event_id), {
            nowMs,
            finalizationDeadlineAtMs: row.finalization_deadline_at_ms,
        });
        const applied = await applyRunnerResult(repository, row.source_event_id, result, nowMs);
        if (applied.finalized) {
            await runRelayerPreview(
                repository,
                row.source_event_id,
                applied.result,
                nowMs,
                relayerPreview,
            );
        }
        summary.processed += 1;
    } catch (error) {
        console.error("Oracle runner failed", {
            source_event_id: row.source_event_id,
            message: errorMessage(error),
        });
        await repository.markFailed(
            row.source_event_id,
            "AWS_RUNNER_TIMEOUT",
            nowMs,
            nowMs + FAILED_RETRY_BACKOFF_MS,
        );
        summary.failed += 1;
    }
}

async function applyRunnerResult(
    repository: StateRepository,
    sourceEventId: string,
    result: TeeCoreResult,
    nowMs: number,
): Promise<AppliedRunnerResult> {
    if (result.status === "finalized") {
        if (!hasValidFinalizedMetadata(result.payload)) {
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
            await repository.applyRunnerResult(
                sourceEventId,
                {
                    ...result,
                    next_retry_at_ms: Math.min(
                        result.next_retry_at_ms,
                        row.finalization_deadline_at_ms,
                    ),
                },
                nowMs,
            );
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

function runnerFromEnv(env: WorkerEnv, fetcher: typeof fetch): RunnerAdapter {
    if (isNonEmptyString(env.ORACLE_SIDECAR_URL)) {
        return new HttpRunnerAdapter(env.ORACLE_SIDECAR_URL, fetcher);
    }
    return new MockRunnerAdapter();
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

function hasValidFinalizedMetadata(payload: unknown): payload is {
    event_uid: string;
    event_revision: number;
    source_updated_at_ms: number;
} {
    if (!isRecord(payload)) {
        return false;
    }
    return (
        typeof payload.event_uid === "string" &&
        payload.event_uid.length > 0 &&
        Number.isSafeInteger(payload.event_revision) &&
        Number.isSafeInteger(payload.source_updated_at_ms)
    );
}

function emptyProcessSummary(): ProcessSummary {
    return {
        processed: 0,
        deferred: 0,
        recovered: 0,
        failed: 0,
        rejected: 0,
    };
}

const app = createWorkerApp();

export default app;
