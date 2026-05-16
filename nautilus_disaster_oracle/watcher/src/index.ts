import {
    BCS_ENUMS,
    DEFAULT_ORACLE_CONTRACT,
    type OffchainStatus,
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
import { type D1Database, D1StateRepository, type StateRepository } from "./state.js";
import { MockRunnerAdapter, type RunnerAdapter } from "./trigger_tee.js";
import { fetchUsgsRecentCandidates, type UsgsEarthquakeCandidate } from "./usgs.js";

export {
    DAY_MS,
    DEFAULT_DUE_LIMIT,
    FAILED_RETRY_BACKOFF_MS,
    FINALIZATION_WINDOW_MS,
    HOUR_MS,
    PROCESSING_STALE_AFTER_MS,
} from "./constants.js";
export type { D1Database, StateRepository } from "./state.js";
export { D1StateRepository, InMemoryStateRepository } from "./state.js";
export type { RunnerAdapter, RunnerContext } from "./trigger_tee.js";
export { MockRunnerAdapter } from "./trigger_tee.js";
export type { UsgsEarthquakeCandidate } from "./usgs.js";
export {
    fetchUsgsRecentCandidates,
    parseUsgsRecentFeed,
    USGS_RECENT_FEED_URL,
} from "./usgs.js";

const TERMINAL_STATUSES = new Set<OffchainStatus>(["finalized", "submitted", "rejected"]);

export interface WorkerEnv {
    EARTHQUAKE_EVENTS: StateRepository | D1Database;
    MANUAL_SUBMIT_TOKEN?: string;
}

export interface ExecutionContextLike {
    waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerAppOptions {
    now?: () => number;
    runner?: RunnerAdapter;
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
): Promise<number> {
    for (const candidate of candidates) {
        await repository.upsertCandidate(candidate, nowMs);
    }
    return candidates.length;
}

export async function processDueEvents(
    repository: StateRepository,
    runner: RunnerAdapter,
    nowMs: number,
    limit = DEFAULT_DUE_LIMIT,
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
        if (TERMINAL_STATUSES.has(row.status)) {
            continue;
        }

        const occurredAtMs = row.finalization_deadline_at_ms - FINALIZATION_WINDOW_MS;
        const firstEligibleAtMs = occurredAtMs + DAY_MS;

        if (nowMs < firstEligibleAtMs) {
            await repository.deferUntil(row.source_event_id, firstEligibleAtMs, nowMs);
            summary.deferred += 1;
            continue;
        }

        if (isDeadlineExceededPending(row.status, nowMs, row.finalization_deadline_at_ms)) {
            await repository.markRejected(row.source_event_id, "REJECTED_AUTO_TRIGGER", nowMs);
            summary.rejected += 1;
            continue;
        }

        await repository.markProcessing(row.source_event_id, nowMs);

        try {
            const result = await runner.run(buildWorkerToTeeRequest(row.source_event_id), {
                nowMs,
                finalizationDeadlineAtMs: row.finalization_deadline_at_ms,
            });
            await applyRunnerResult(repository, row.source_event_id, result, nowMs);
            summary.processed += 1;
        } catch {
            await repository.markFailed(
                row.source_event_id,
                "AWS_RUNNER_TIMEOUT",
                nowMs,
                nowMs + FAILED_RETRY_BACKOFF_MS,
            );
            summary.failed += 1;
        }
    }

    return summary;
}

export function createWorkerApp(options: WorkerAppOptions = {}) {
    const now = options.now ?? Date.now;
    const runner = options.runner ?? new MockRunnerAdapter();
    const fetcher = options.fetcher ?? fetch;

    return {
        async fetch(request: Request, env: WorkerEnv): Promise<Response> {
            const url = new URL(request.url);
            const repository = repositoryFromEnv(env);

            if (request.method === "GET" && url.pathname === "/health") {
                return json({ ok: true });
            }

            if (request.method === "POST" && url.pathname === "/manual/earthquakes") {
                return handleManualEarthquake(request, env, repository, now());
            }

            if (request.method === "POST" && url.pathname === "/tasks/process-due") {
                const summary = await processDueEvents(repository, runner, now());
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
            const candidates = await fetchUsgsRecentCandidates(fetcher);
            await scanCandidates(repository, candidates, nowMs);
            await processDueEvents(repository, runner, nowMs);
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
            },
        ],
        nowMs,
    );

    return json({ accepted: true, source_event_id: sourceEventId }, { status: 202 });
}

async function applyRunnerResult(
    repository: StateRepository,
    sourceEventId: string,
    result: TeeCoreResult,
    nowMs: number,
): Promise<void> {
    if (result.status === "pending_source" || result.status === "pending_mmi") {
        const row = await repository.get(sourceEventId);
        if (
            row !== null &&
            isDeadlineExceededPending(result.status, nowMs, row.finalization_deadline_at_ms)
        ) {
            await repository.markRejected(sourceEventId, "REJECTED_AUTO_TRIGGER", nowMs);
            return;
        }
    }

    await repository.applyRunnerResult(sourceEventId, result, nowMs);
}

function isDeadlineExceededPending(
    status: OffchainStatus,
    nowMs: number,
    deadlineAtMs: number,
): boolean {
    return (status === "pending_source" || status === "pending_mmi") && nowMs >= deadlineAtMs;
}

function repositoryFromEnv(env: WorkerEnv): StateRepository {
    if (isStateRepository(env.EARTHQUAKE_EVENTS)) {
        return env.EARTHQUAKE_EVENTS;
    }
    return new D1StateRepository(env.EARTHQUAKE_EVENTS);
}

function isStateRepository(input: StateRepository | D1Database): input is StateRepository {
    return "upsertCandidate" in input;
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

const app = createWorkerApp();

export default app;
