import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
    BCS_ENUMS,
    DEFAULT_ORACLE_CONTRACT,
    type EarthquakeVerifierRequest,
    type OffchainStatus,
    type SignedFinalizedPayload,
    type TeeCoreResult,
} from "@sonari/earthquake-shared";
import {
    DAY_MS,
    DEFAULT_DUE_LIMIT,
    FAILED_RETRY_BACKOFF_MS,
    HOUR_MS,
    PROCESSING_STALE_AFTER_MS,
} from "./constants.js";
import type { RelayerAdapter } from "./relayer_preview.js";
import { screenUsgsCandidate } from "./screening.js";
import { isValidUsgsSourceEventId } from "./source_event_id.js";
import { DynamoDbStateRepository, type RunnerQueueJob, type StateRepository } from "./state.js";
import {
    resolveUsgsSourceEventId as defaultResolveUsgsSourceEventId,
    fetchUsgsRecentCandidates,
    type UsgsEarthquakeCandidate,
    type UsgsSourceEventIdResolution,
    type UsgsSourceEventIdResolver,
    type UsgsSourceEventIdResolverResult,
    type UsgsSourceEventIdUnavailableResolution,
} from "./usgs.js";

export {
    DAY_MS,
    DEFAULT_DUE_LIMIT,
    FAILED_RETRY_BACKOFF_MS,
    FINALIZATION_WINDOW_MS,
    HOUR_MS,
    PROCESSING_STALE_AFTER_MS,
} from "./constants.js";
export {
    screenUsgsCandidate,
    WATCHER_ALERT_LEVELS,
    WATCHER_MIN_MAGNITUDE,
    WATCHER_MIN_SUMMARY_MMI,
} from "./screening.js";
export { assertValidUsgsSourceEventId, isValidUsgsSourceEventId } from "./source_event_id.js";
export type {
    EarthquakeEventRow,
    RunnerPhase,
    RunnerQueueJob,
    RunnerWorkflowProgressUpdate,
    StateRepository,
    UpsertCandidateOptions,
} from "./state.js";
export { DynamoDbStateRepository, InMemoryStateRepository } from "./state.js";
export type { UsgsEarthquakeCandidate } from "./usgs.js";
export {
    fetchUsgsRecentCandidates,
    parseUsgsRecentFeed,
    resolveUsgsSourceEventId,
    USGS_RECENT_FEED_URL,
    usgsDetailUrl,
} from "./usgs.js";

const INLINE_TEST_RUNNER_TIMEOUT_MS = 90_000;

export interface WorkflowStarter {
    start(input: { sourceEventId: string; executionName: string; attempt?: number }): Promise<void>;
}

export interface StepFunctionsClientLike {
    send(command: StartExecutionCommand): Promise<unknown>;
}

export class StepFunctionsWorkflowStarter implements WorkflowStarter {
    private readonly client: StepFunctionsClientLike;

    constructor(
        private readonly stateMachineArn: string,
        client?: StepFunctionsClientLike,
    ) {
        this.client = client ?? new SFNClient({});
    }

    async start(input: {
        sourceEventId: string;
        executionName: string;
        attempt?: number;
    }): Promise<void> {
        await this.client.send(
            new StartExecutionCommand({
                stateMachineArn: this.stateMachineArn,
                name: input.executionName,
                input: JSON.stringify({
                    source_event_id: input.sourceEventId,
                    attempt: input.attempt ?? 1,
                }),
            }),
        );
    }
}

export interface ScheduledHandlerOptions {
    repository: StateRepository;
    workflow: WorkflowStarter;
    now?: () => number;
    fetchCandidates?: () => Promise<UsgsEarthquakeCandidate[]>;
    resolveSourceEventId?: UsgsSourceEventIdResolver;
    dueLimit?: number;
}

export interface ScheduledHandlerResult {
    scanned: number;
    workflow_started: number;
}

export function createScheduledHandler(options: ScheduledHandlerOptions) {
    return async function scheduledHandler(): Promise<ScheduledHandlerResult> {
        const nowMs = options.now?.() ?? Date.now();
        const candidates = await (options.fetchCandidates ?? fetchUsgsRecentCandidates)();
        await scanCandidates(options.repository, candidates, nowMs, {
            resolveSourceEventId: options.resolveSourceEventId ?? defaultResolveUsgsSourceEventId,
        });
        const started = await startDueWorkflows(
            options.repository,
            options.workflow,
            nowMs,
            options.dueLimit ?? DEFAULT_DUE_LIMIT,
        );
        return { scanned: candidates.length, workflow_started: started };
    };
}

export interface ManualLambdaEvent {
    headers?: Record<string, string | undefined>;
    body?: string | null;
}

export interface ManualHandlerOptions {
    repository: StateRepository;
    workflow: WorkflowStarter;
    token: string;
    now?: () => number;
    resolveSourceEventId?: UsgsSourceEventIdResolver;
}

export interface LambdaHttpResponse {
    statusCode: number;
    headers?: Record<string, string>;
    body: string;
}

export function createManualHandler(options: ManualHandlerOptions) {
    return async function manualHandler(event: ManualLambdaEvent): Promise<LambdaHttpResponse> {
        if (!isAuthorized(event.headers, options.token)) {
            return jsonResponse(401, { ok: false, message: "unauthorized" });
        }
        const body = parseJsonBody(event.body);
        if (
            !isRecord(body) ||
            typeof body.source_event_id !== "string" ||
            !isValidUsgsSourceEventId(body.source_event_id)
        ) {
            return jsonResponse(400, { ok: false, message: "valid source_event_id is required" });
        }
        const nowMs = options.now?.() ?? Date.now();
        const resolution = await resolveSourceEventId(
            {
                sourceEventId: body.source_event_id,
            },
            options.resolveSourceEventId,
        );
        if (resolution !== null && isUnavailableSourceEventIdResolution(resolution)) {
            return jsonResponse(503, {
                ok: false,
                message: "USGS detail unavailable; retry later",
            });
        }
        if (resolution === null || !isValidUsgsSourceEventId(resolution.source_event_id)) {
            return jsonResponse(400, {
                ok: false,
                message: "source_event_id does not match USGS detail",
            });
        }
        await options.repository.upsertManualEvent(resolution.source_event_id, nowMs, {
            ...(resolution.requested_source_event_id === undefined
                ? {}
                : { requestedSourceEventId: resolution.requested_source_event_id }),
        });
        const workflowStarted = await startDueWorkflows(
            options.repository,
            options.workflow,
            nowMs,
            1,
        );
        return jsonResponse(200, manualSubmitResponse(workflowStarted, resolution));
    };
}

export function buildEarthquakeVerifierRequest(sourceEventId: string): EarthquakeVerifierRequest {
    return {
        source_event_id: sourceEventId,
        hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
        primary_source: BCS_ENUMS.primarySource.USGS,
        geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
    };
}

interface ScanCandidatesOptions {
    bypassScreening?: boolean;
    resolveSourceEventId?: UsgsSourceEventIdResolver;
}

export async function scanCandidates(
    repository: StateRepository,
    candidates: UsgsEarthquakeCandidate[],
    nowMs: number,
    options: ScanCandidatesOptions = {},
): Promise<void> {
    const seen = new Set<string>();
    for (const candidate of candidates) {
        if (!isValidUsgsSourceEventId(candidate.source_event_id)) {
            continue;
        }
        if (!options.bypassScreening && !screenUsgsCandidate(candidate).runnerEligible) {
            await repository.upsertCandidate(candidate, nowMs, options);
            continue;
        }
        const resolution = await resolveSourceEventId(
            { sourceEventId: candidate.source_event_id },
            options.resolveSourceEventId,
        );
        if (resolution !== null && isUnavailableSourceEventIdResolution(resolution)) {
            continue;
        }
        if (resolution === null || !isValidUsgsSourceEventId(resolution.source_event_id)) {
            continue;
        }
        if (seen.has(resolution.source_event_id)) {
            continue;
        }
        seen.add(resolution.source_event_id);
        const canonicalCandidate = {
            ...candidate,
            source_event_id: resolution.source_event_id,
            ...(resolution.requested_source_event_id === undefined
                ? {}
                : { requested_source_event_id: resolution.requested_source_event_id }),
        };
        await repository.upsertCandidate(canonicalCandidate, nowMs, options);
        if (!options.bypassScreening && nowMs - candidate.occurred_at_ms < DAY_MS) {
            const row = await repository.get(canonicalCandidate.source_event_id);
            if (row?.status === "new") {
                await repository.deferUntil(
                    canonicalCandidate.source_event_id,
                    candidate.occurred_at_ms + DAY_MS,
                    nowMs,
                );
            }
        }
    }
}

async function resolveSourceEventId(
    input: Parameters<UsgsSourceEventIdResolver>[0],
    resolver: UsgsSourceEventIdResolver | undefined,
): Promise<UsgsSourceEventIdResolverResult | null> {
    return resolver === undefined ? { source_event_id: input.sourceEventId } : resolver(input);
}

function isUnavailableSourceEventIdResolution(
    resolution: UsgsSourceEventIdResolverResult,
): resolution is UsgsSourceEventIdUnavailableResolution {
    return "unavailable" in resolution;
}

function manualSubmitResponse(
    workflowStarted: number,
    resolution: UsgsSourceEventIdResolution,
): Record<string, unknown> {
    return {
        ok: true,
        workflow_started: workflowStarted,
        source_event_id: resolution.source_event_id,
        ...(resolution.requested_source_event_id === undefined
            ? {}
            : { requested_source_event_id: resolution.requested_source_event_id }),
    };
}

export async function startDueWorkflows(
    repository: StateRepository,
    workflow: WorkflowStarter,
    nowMs: number,
    limit = DEFAULT_DUE_LIMIT,
): Promise<number> {
    const staleBeforeMs = nowMs - PROCESSING_STALE_AFTER_MS;
    if (await repository.hasActiveRunnerWorkflow(staleBeforeMs)) {
        return 0;
    }
    await repository.recoverStaleProcessing(staleBeforeMs, nowMs, nowMs + FAILED_RETRY_BACKOFF_MS);
    if (await repository.hasActiveRunnerWorkflow(staleBeforeMs)) {
        return 0;
    }
    const rows = await repository.listDue(nowMs, limit);
    let started = 0;
    for (const row of rows) {
        if (row.finalization_deadline_at_ms <= nowMs && isPendingStatus(row.status)) {
            await repository.markRejected(row.source_event_id, "REJECTED_AUTO_TRIGGER", nowMs);
            continue;
        }
        const attempt = row.retry_count + 1;
        const executionName = `earthquake-${sanitizeExecutionName(row.source_event_id)}-${attempt}`;
        const start = await repository.tryStartRunnerWorkflowExclusively(
            row.source_event_id,
            executionName,
            nowMs,
            row.retry_count,
        );
        if (start === null) {
            break;
        }
        try {
            await workflow.start({
                sourceEventId: row.source_event_id,
                executionName,
                attempt: start.attempt,
            });
        } catch (error) {
            await repository.markFailed(
                row.source_event_id,
                "AWS_RUNNER_START_FAILED",
                nowMs,
                nowMs + FAILED_RETRY_BACKOFF_MS,
                error instanceof Error ? error.message : String(error),
                start.attempt,
            );
            await repository.markWorkflowStopped(row.source_event_id, start.attempt, nowMs);
            break;
        }
        started += 1;
        break;
    }
    return started;
}

export interface RunnerJobQueue {
    send(message: RunnerQueueJob): Promise<unknown>;
}

export interface EnqueueSummary {
    enqueued: number;
    deferred: number;
    recovered: number;
    rejected: number;
}

export async function enqueueDueEvents(
    repository: StateRepository,
    queue: RunnerJobQueue,
    nowMs: number,
    limit = DEFAULT_DUE_LIMIT,
): Promise<EnqueueSummary> {
    const summary: EnqueueSummary = { enqueued: 0, deferred: 0, recovered: 0, rejected: 0 };
    summary.recovered += await repository.recoverStaleQueued(
        nowMs - PROCESSING_STALE_AFTER_MS,
        nowMs,
        nowMs + FAILED_RETRY_BACKOFF_MS,
    );
    summary.recovered += await repository.recoverStaleProcessing(
        nowMs - PROCESSING_STALE_AFTER_MS,
        nowMs,
        nowMs + FAILED_RETRY_BACKOFF_MS,
    );
    for (const row of await repository.listDue(nowMs, limit)) {
        if (row.finalization_deadline_at_ms <= nowMs && isPendingStatus(row.status)) {
            await repository.markRejected(row.source_event_id, "REJECTED_AUTO_TRIGGER", nowMs);
            summary.rejected += 1;
            continue;
        }
        const attempt = row.retry_count + 1;
        const runnerJobId = `${row.source_event_id}:${attempt}`;
        const job = await repository.enqueueRunnerJob(
            row.source_event_id,
            attempt,
            runnerJobId,
            nowMs,
        );
        if (job === null) {
            summary.deferred += 1;
            continue;
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
                error instanceof Error ? error.message : String(error),
            );
            summary.deferred += 1;
        }
    }
    return summary;
}

export interface ProcessSummary {
    enqueued: number;
    processed: number;
    finalized: number;
    pending: number;
    rejected: number;
    failed: number;
    deferred: number;
    recovered: number;
}

export interface RunnerAdapter {
    run(request: EarthquakeVerifierRequest): Promise<TeeCoreResult>;
}

export async function processDueEventsInlineForTests(
    repository: StateRepository,
    runner: RunnerAdapter,
    nowMs: number,
    limit = DEFAULT_DUE_LIMIT,
    relayer?: RelayerAdapter,
): Promise<ProcessSummary> {
    const queue = new InlineQueue();
    const enqueueSummary = await enqueueDueEvents(repository, queue, nowMs, limit);
    const summary: ProcessSummary = {
        enqueued: enqueueSummary.enqueued,
        processed: 0,
        finalized: 0,
        pending: 0,
        rejected: 0,
        failed: 0,
        deferred: enqueueSummary.deferred,
        recovered: enqueueSummary.recovered,
    };
    for (const job of queue.messages) {
        const claimed = await repository.claimQueuedForProcessing(
            job,
            nowMs,
            nowMs + INLINE_TEST_RUNNER_TIMEOUT_MS,
        );
        if (!claimed) {
            summary.deferred += 1;
            continue;
        }
        try {
            const result = await runner.run(buildEarthquakeVerifierRequest(job.source_event_id));
            await repository.applyRunnerResult(
                job.source_event_id,
                result,
                nowMs,
                isPendingStatus(result.status) ? nowMs + HOUR_MS : undefined,
            );
            await repository.recordRunnerStopped(job.source_event_id, job.runner_job_id, nowMs);
            summary.processed += 1;
            if (result.status === "finalized") {
                summary.finalized += 1;
                await runRelayer(repository, job.source_event_id, result, nowMs, relayer);
            } else if (isPendingStatus(result.status)) {
                summary.pending += 1;
            } else {
                summary.rejected += 1;
            }
        } catch (error) {
            await repository.markFailed(
                job.source_event_id,
                "AWS_RUNNER_PROCESS_FAILED",
                nowMs,
                nowMs + FAILED_RETRY_BACKOFF_MS,
                error instanceof Error ? error.message : String(error),
            );
            summary.failed += 1;
        }
    }
    return summary;
}

export interface DefaultScheduledHandlerOptions {
    repository?: StateRepository;
    fetchCandidates?: () => Promise<UsgsEarthquakeCandidate[]>;
    now?: () => number;
    dueLimit?: number;
    sfnClient?: StepFunctionsClientLike;
    resolveSourceEventId?: UsgsSourceEventIdResolver;
}

export function createDefaultScheduledHandlerFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: DefaultScheduledHandlerOptions = {},
) {
    const tableName = requiredEnv(env, "EVENTS_TABLE_NAME");
    const stateMachineArn = requiredEnv(env, "RUNNER_STATE_MACHINE_ARN");
    const scheduledOptions: ScheduledHandlerOptions = {
        repository: options.repository ?? new DynamoDbStateRepository(tableName),
        workflow: new StepFunctionsWorkflowStarter(stateMachineArn, options.sfnClient),
    };
    if (options.fetchCandidates !== undefined) {
        scheduledOptions.fetchCandidates = options.fetchCandidates;
    }
    if (options.now !== undefined) {
        scheduledOptions.now = options.now;
    }
    if (options.dueLimit !== undefined) {
        scheduledOptions.dueLimit = options.dueLimit;
    }
    if (options.resolveSourceEventId !== undefined) {
        scheduledOptions.resolveSourceEventId = options.resolveSourceEventId;
    }
    return createScheduledHandler(scheduledOptions);
}

class InlineQueue implements RunnerJobQueue {
    readonly messages: RunnerQueueJob[] = [];

    async send(message: RunnerQueueJob): Promise<void> {
        this.messages.push(message);
    }
}

async function runRelayer(
    repository: StateRepository,
    sourceEventId: string,
    result: SignedFinalizedPayload,
    nowMs: number,
    relayer?: RelayerAdapter,
): Promise<void> {
    if (relayer === undefined) {
        return;
    }
    const relayerResult = await relayer.relay(result);
    if (relayerResult.ok) {
        await repository.markRelayerSucceeded(sourceEventId, relayerResult.value, nowMs);
        return;
    }
    await repository.markRelayerFailed(
        sourceEventId,
        relayer.mode,
        relayerResult.error_code,
        relayerResult.message,
        nowMs,
    );
}

function isPendingStatus(status: OffchainStatus | TeeCoreResult["status"]): boolean {
    return status === "pending_source" || status === "pending_mmi";
}

function sanitizeExecutionName(sourceEventId: string): string {
    return sourceEventId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
}

function isAuthorized(
    headers: Record<string, string | undefined> | undefined,
    token: string,
): boolean {
    const authorization = headers?.authorization ?? headers?.Authorization;
    return authorization === `Bearer ${token}`;
}

function parseJsonBody(body: string | null | undefined): unknown {
    if (body === undefined || body === null || body.length === 0) {
        return null;
    }
    try {
        return JSON.parse(body) as unknown;
    } catch {
        return null;
    }
}

function jsonResponse(statusCode: number, body: unknown): LambdaHttpResponse {
    return {
        statusCode,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    };
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}
