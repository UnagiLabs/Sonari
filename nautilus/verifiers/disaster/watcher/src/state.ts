import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { OffchainStatus, OracleErrorCode, TeeCoreResult } from "@sonari/oracle-shared";
import { FAILED_RETRY_BACKOFF_MS, FINALIZATION_WINDOW_MS } from "./constants.js";
import type {
    RelayerErrorCode,
    RelayerMode,
    RelayerStatus,
    RelayerSuccess,
} from "./relayer_preview.js";
import { screenUsgsCandidate } from "./screening.js";
import type { UsgsEarthquakeCandidate } from "./usgs.js";

export interface EarthquakeEventRow {
    source_event_id: string;
    event_uid: string | null;
    status: OffchainStatus;
    retry_count: number;
    next_retry_at_ms: number | null;
    finalization_deadline_at_ms: number;
    latest_revision: number;
    last_seen_at_ms: number;
    source_updated_at_ms: number | null;
    error_code: OracleErrorCode | null;
    relayer_mode: RelayerMode | null;
    relayer_status: RelayerStatus | null;
    relayer_request_json: string | null;
    relayer_digest: string | null;
    relayer_error_code: RelayerErrorCode | null;
    relayer_error_message: string | null;
    relayer_updated_at_ms: number | null;
    relayer_submitted_at_ms: number | null;
    runner_job_id: string | null;
    runner_queued_at_ms: number | null;
    runner_attempt: number | null;
    runner_id: string | null;
    runner_started_at_ms: number | null;
    runner_stopped_at_ms: number | null;
    runner_timeout_at_ms: number | null;
    runner_error_message: string | null;
    runner_stop_error: string | null;
    runner_phase: RunnerPhase | null;
    runner_instance_id: string | null;
    runner_command_id: string | null;
    runner_result_s3_key: string | null;
    runner_last_poll_at_ms: number | null;
    tee_result_json: string | null;
    payload_bcs_hex: string | null;
    signature: string | null;
    public_key: string | null;
    finalized_at_ms: number | null;
    created_at_ms: number;
    updated_at_ms: number;
}

export type RunnerPhase =
    | "queued"
    | "starting_instance"
    | "waiting_for_instance"
    | "dispatching_command"
    | "polling_command"
    | "reading_result"
    | "applying_result"
    | "stopping_instance"
    | "complete";

export interface RunnerQueueJob {
    runner_job_id: string;
    source_event_id: string;
    attempt: number;
    enqueued_at_ms: number;
}

export interface UpsertCandidateOptions {
    bypassScreening?: boolean;
}

export interface WorkflowStartInput {
    sourceEventId: string;
    executionName: string;
    attempt: number;
}

export interface StateRepository {
    upsertCandidate(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
        options?: UpsertCandidateOptions,
    ): Promise<void>;
    upsertManualEvent(sourceEventId: string, nowMs: number): Promise<void>;
    get(sourceEventId: string): Promise<EarthquakeEventRow | null>;
    listDue(nowMs: number, limit: number): Promise<EarthquakeEventRow[]>;
    hasActiveRunnerWorkflow(): Promise<boolean>;
    markWorkflowStarted(
        sourceEventId: string,
        executionName: string,
        nowMs: number,
    ): Promise<WorkflowStartInput | null>;
    markFailed(
        sourceEventId: string,
        errorCode: OracleErrorCode,
        nowMs: number,
        nextRetryAtMs: number,
        runnerErrorMessage?: string,
    ): Promise<void>;
    applyRunnerResult(
        sourceEventId: string,
        result: TeeCoreResult,
        nowMs: number,
        pendingNextRetryAtMs?: number,
    ): Promise<void>;
    markRelayerSucceeded(
        sourceEventId: string,
        success: RelayerSuccess,
        nowMs: number,
    ): Promise<void>;
    markRelayerFailed(
        sourceEventId: string,
        mode: RelayerMode,
        errorCode: RelayerErrorCode,
        message: string,
        nowMs: number,
    ): Promise<void>;

    // Compatibility helpers used by local scripts while AWS Lambda is the production path.
    enqueueRunnerJob(
        sourceEventId: string,
        attempt: number,
        runnerJobId: string,
        nowMs: number,
    ): Promise<RunnerQueueJob | null>;
    markQueueEnqueueFailed(
        sourceEventId: string,
        runnerJobId: string,
        nowMs: number,
        nextRetryAtMs: number,
        message: string,
    ): Promise<void>;
    claimQueuedForProcessing(
        job: RunnerQueueJob,
        nowMs: number,
        timeoutAtMs: number,
    ): Promise<boolean>;
    recordRunnerStarted(
        sourceEventId: string,
        runnerJobId: string,
        runnerId: string,
        nowMs: number,
        timeoutAtMs: number,
    ): Promise<void>;
    recordRunnerStopped(sourceEventId: string, runnerJobId: string, nowMs: number): Promise<void>;
    recordRunnerStopFailed(
        sourceEventId: string,
        runnerJobId: string,
        message: string,
        nowMs: number,
    ): Promise<void>;
    deferUntil(sourceEventId: string, nextRetryAtMs: number, nowMs: number): Promise<void>;
    markRejected(
        sourceEventId: string,
        errorCode: Extract<OracleErrorCode, "REJECTED_AUTO_TRIGGER">,
        nowMs: number,
    ): Promise<void>;
    recoverStaleProcessing(
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<number>;
    recoverStaleQueued(
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<number>;
}

const DUE_STATUSES = new Set<OffchainStatus>(["new", "pending_source", "pending_mmi", "failed"]);
const TERMINAL_STATUSES = new Set<OffchainStatus>([
    "finalized",
    "submitted",
    "rejected",
    "ignored_small",
]);

export class InMemoryStateRepository implements StateRepository {
    private readonly rows = new Map<string, EarthquakeEventRow>();

    async upsertCandidate(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
        options: UpsertCandidateOptions = {},
    ): Promise<void> {
        const existing = this.rows.get(candidate.source_event_id);
        const screening = options.bypassScreening
            ? { status: "new" as const, error_code: null }
            : screenUsgsCandidate(candidate);
        const status =
            existing?.status === "ignored_small"
                ? screening.status
                : existing !== undefined &&
                    (TERMINAL_STATUSES.has(existing.status) || existing.status !== "new")
                  ? existing.status
                  : screening.status;
        const retryCount = existing?.retry_count ?? 0;
        const row = baseRow(candidate.source_event_id, nowMs, {
            event_uid: existing?.event_uid ?? candidate.source_event_id,
            status,
            retry_count: retryCount,
            next_retry_at_ms: status === "new" ? null : (existing?.next_retry_at_ms ?? null),
            finalization_deadline_at_ms:
                existing?.finalization_deadline_at_ms ??
                candidate.occurred_at_ms + FINALIZATION_WINDOW_MS,
            latest_revision: existing?.latest_revision ?? 0,
            last_seen_at_ms: nowMs,
            source_updated_at_ms: candidate.source_updated_at_ms,
            error_code:
                status === "ignored_small"
                    ? "WATCHER_BELOW_AUTO_THRESHOLD"
                    : (existing?.error_code ?? null),
            created_at_ms: existing?.created_at_ms ?? nowMs,
        });
        this.rows.set(candidate.source_event_id, mergePreservingResult(existing, row, nowMs));
    }

    async upsertManualEvent(sourceEventId: string, nowMs: number): Promise<void> {
        await this.upsertCandidate(
            {
                source_event_id: sourceEventId,
                occurred_at_ms: nowMs,
                source_updated_at_ms: nowMs,
                magnitude: null,
                summary_mmi: null,
                alert: null,
                tsunami: false,
            },
            nowMs,
            { bypassScreening: true },
        );
    }

    async get(sourceEventId: string): Promise<EarthquakeEventRow | null> {
        const row = this.rows.get(sourceEventId);
        return row === undefined ? null : structuredClone(row);
    }

    async listDue(nowMs: number, limit: number): Promise<EarthquakeEventRow[]> {
        return [...this.rows.values()]
            .filter((row) => DUE_STATUSES.has(row.status) && isReadyForRetryOrDeadline(row, nowMs))
            .sort((a, b) => a.updated_at_ms - b.updated_at_ms)
            .slice(0, limit)
            .map((row) => structuredClone(row));
    }

    async hasActiveRunnerWorkflow(): Promise<boolean> {
        return [...this.rows.values()].some((row) => row.status === "processing");
    }

    async markWorkflowStarted(
        sourceEventId: string,
        executionName: string,
        nowMs: number,
    ): Promise<WorkflowStartInput | null> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined || !DUE_STATUSES.has(row.status)) {
            return null;
        }
        const attempt = row.retry_count + 1;
        row.status = "processing";
        row.runner_job_id = executionName;
        row.runner_attempt = attempt;
        row.runner_phase = "starting_instance";
        row.runner_started_at_ms = nowMs;
        row.runner_timeout_at_ms = nowMs + FAILED_RETRY_BACKOFF_MS;
        row.error_code = null;
        row.updated_at_ms = nowMs;
        return { sourceEventId, executionName, attempt };
    }

    async markFailed(
        sourceEventId: string,
        errorCode: OracleErrorCode,
        nowMs: number,
        nextRetryAtMs: number,
        runnerErrorMessage?: string,
    ): Promise<void> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return;
        }
        row.status = "failed";
        row.retry_count += 1;
        row.next_retry_at_ms = nextRetryAtMs;
        row.error_code = errorCode;
        row.runner_error_message = runnerErrorMessage ?? null;
        row.updated_at_ms = nowMs;
    }

    async applyRunnerResult(
        sourceEventId: string,
        result: TeeCoreResult,
        nowMs: number,
        pendingNextRetryAtMs?: number,
    ): Promise<void> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return;
        }
        await applyResultToRow(row, result, nowMs, pendingNextRetryAtMs);
    }

    async markRelayerSucceeded(
        sourceEventId: string,
        success: RelayerSuccess,
        nowMs: number,
    ): Promise<void> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return;
        }
        if (success.mode === "submit") {
            row.status = "submitted";
            row.relayer_submitted_at_ms = nowMs;
        }
        row.relayer_mode = success.mode;
        row.relayer_status = "succeeded";
        row.relayer_request_json = JSON.stringify(success.request);
        row.relayer_digest = success.digest ?? null;
        row.relayer_error_code = null;
        row.relayer_error_message = null;
        row.relayer_updated_at_ms = nowMs;
        row.updated_at_ms = nowMs;
    }

    async markRelayerFailed(
        sourceEventId: string,
        mode: RelayerMode,
        errorCode: RelayerErrorCode,
        message: string,
        nowMs: number,
    ): Promise<void> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return;
        }
        row.relayer_mode = mode;
        row.relayer_status = "failed";
        row.relayer_error_code = errorCode;
        row.relayer_error_message = message;
        row.relayer_updated_at_ms = nowMs;
        row.updated_at_ms = nowMs;
    }

    async enqueueRunnerJob(
        sourceEventId: string,
        attempt: number,
        runnerJobId: string,
        nowMs: number,
    ): Promise<RunnerQueueJob | null> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined || !DUE_STATUSES.has(row.status) || row.retry_count !== attempt - 1) {
            return null;
        }
        row.status = "queued";
        row.runner_job_id = runnerJobId;
        row.runner_queued_at_ms = nowMs;
        row.runner_attempt = attempt;
        row.runner_phase = "queued";
        row.next_retry_at_ms = null;
        row.error_code = null;
        row.updated_at_ms = nowMs;
        return {
            runner_job_id: runnerJobId,
            source_event_id: sourceEventId,
            attempt,
            enqueued_at_ms: nowMs,
        };
    }

    async markQueueEnqueueFailed(
        sourceEventId: string,
        runnerJobId: string,
        nowMs: number,
        nextRetryAtMs: number,
        message: string,
    ): Promise<void> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined || row.runner_job_id !== runnerJobId) {
            return;
        }
        row.status = "new";
        row.next_retry_at_ms = nextRetryAtMs;
        row.runner_error_message = message;
        row.updated_at_ms = nowMs;
    }

    async claimQueuedForProcessing(
        job: RunnerQueueJob,
        nowMs: number,
        timeoutAtMs: number,
    ): Promise<boolean> {
        const row = this.rows.get(job.source_event_id);
        if (
            row === undefined ||
            row.status !== "queued" ||
            row.runner_job_id !== job.runner_job_id ||
            row.runner_attempt !== job.attempt
        ) {
            return false;
        }
        row.status = "processing";
        row.runner_timeout_at_ms = timeoutAtMs;
        row.updated_at_ms = nowMs;
        return true;
    }

    async recordRunnerStarted(
        sourceEventId: string,
        runnerJobId: string,
        runnerId: string,
        nowMs: number,
        timeoutAtMs: number,
    ): Promise<void> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined || row.runner_job_id !== runnerJobId) {
            return;
        }
        row.runner_id = runnerId;
        row.runner_started_at_ms = nowMs;
        row.runner_timeout_at_ms = timeoutAtMs;
        row.updated_at_ms = nowMs;
    }

    async recordRunnerStopped(
        sourceEventId: string,
        runnerJobId: string,
        nowMs: number,
    ): Promise<void> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined || row.runner_job_id !== runnerJobId) {
            return;
        }
        row.runner_stopped_at_ms = nowMs;
        row.runner_stop_error = null;
        row.updated_at_ms = nowMs;
    }

    async recordRunnerStopFailed(
        sourceEventId: string,
        runnerJobId: string,
        message: string,
        nowMs: number,
    ): Promise<void> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined || row.runner_job_id !== runnerJobId) {
            return;
        }
        row.runner_stop_error = message;
        row.updated_at_ms = nowMs;
    }

    async deferUntil(sourceEventId: string, nextRetryAtMs: number, nowMs: number): Promise<void> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return;
        }
        row.next_retry_at_ms = nextRetryAtMs;
        row.updated_at_ms = nowMs;
    }

    async markRejected(
        sourceEventId: string,
        errorCode: Extract<OracleErrorCode, "REJECTED_AUTO_TRIGGER">,
        nowMs: number,
    ): Promise<void> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return;
        }
        row.status = "rejected";
        row.error_code = errorCode;
        row.next_retry_at_ms = null;
        row.updated_at_ms = nowMs;
    }

    async recoverStaleProcessing(
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<number> {
        let recovered = 0;
        for (const row of this.rows.values()) {
            if (row.status === "processing" && row.updated_at_ms <= staleBeforeMs) {
                await this.markFailed(
                    row.source_event_id,
                    "AWS_RUNNER_TIMEOUT",
                    nowMs,
                    nextRetryAtMs,
                );
                recovered += 1;
            }
        }
        return recovered;
    }

    async recoverStaleQueued(
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<number> {
        let recovered = 0;
        for (const row of this.rows.values()) {
            if (
                row.status === "queued" &&
                row.runner_queued_at_ms !== null &&
                row.runner_queued_at_ms <= staleBeforeMs
            ) {
                await this.markQueueEnqueueFailed(
                    row.source_event_id,
                    row.runner_job_id ?? "",
                    nowMs,
                    nextRetryAtMs,
                    "queued runner job was not processed before stale timeout",
                );
                recovered += 1;
            }
        }
        return recovered;
    }
}

export interface DynamoDbDocumentClientLike {
    send(command: unknown): Promise<unknown>;
}

export class DynamoDbStateRepository implements StateRepository {
    private readonly documentClient: DynamoDbDocumentClientLike;

    constructor(
        readonly tableName: string,
        client?: DynamoDbDocumentClientLike,
    ) {
        this.documentClient = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
    }

    async upsertCandidate(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
        options: UpsertCandidateOptions = {},
    ): Promise<void> {
        const existing = await this.get(candidate.source_event_id);
        const screening = options.bypassScreening
            ? { status: "new" as const, error_code: null }
            : screenUsgsCandidate(candidate);
        const status =
            existing?.status === "ignored_small"
                ? screening.status
                : existing !== null &&
                    (TERMINAL_STATUSES.has(existing.status) || existing.status !== "new")
                  ? existing.status
                  : screening.status;
        const next = baseRow(candidate.source_event_id, nowMs, {
            event_uid: existing?.event_uid ?? candidate.source_event_id,
            status,
            retry_count: existing?.retry_count ?? 0,
            next_retry_at_ms: status === "new" ? null : (existing?.next_retry_at_ms ?? null),
            finalization_deadline_at_ms:
                existing?.finalization_deadline_at_ms ??
                candidate.occurred_at_ms + FINALIZATION_WINDOW_MS,
            latest_revision: existing?.latest_revision ?? 0,
            last_seen_at_ms: nowMs,
            source_updated_at_ms: candidate.source_updated_at_ms,
            error_code:
                status === "ignored_small"
                    ? "WATCHER_BELOW_AUTO_THRESHOLD"
                    : (existing?.error_code ?? null),
            created_at_ms: existing?.created_at_ms ?? nowMs,
        });
        await this.put(mergePreservingResult(existing ?? undefined, next, nowMs));
    }

    async upsertManualEvent(sourceEventId: string, nowMs: number): Promise<void> {
        await this.upsertCandidate(
            {
                source_event_id: sourceEventId,
                occurred_at_ms: nowMs,
                source_updated_at_ms: nowMs,
                magnitude: null,
                summary_mmi: null,
                alert: null,
                tsunami: false,
            },
            nowMs,
            { bypassScreening: true },
        );
    }

    async get(sourceEventId: string): Promise<EarthquakeEventRow | null> {
        const result = (await this.documentClient.send(
            new GetCommand({
                TableName: this.tableName,
                Key: { source_event_id: sourceEventId },
            }),
        )) as { Item?: EarthquakeEventRow };
        return result.Item ?? null;
    }

    async listDue(nowMs: number, limit: number): Promise<EarthquakeEventRow[]> {
        return (await this.scanRows())
            .filter((row) => DUE_STATUSES.has(row.status) && isReadyForRetryOrDeadline(row, nowMs))
            .sort((a, b) => a.updated_at_ms - b.updated_at_ms)
            .slice(0, limit);
    }

    async hasActiveRunnerWorkflow(): Promise<boolean> {
        return (await this.scanRows()).some((row) => row.status === "processing");
    }

    async markWorkflowStarted(
        sourceEventId: string,
        executionName: string,
        nowMs: number,
    ): Promise<WorkflowStartInput | null> {
        const row = await this.get(sourceEventId);
        if (row === null || !DUE_STATUSES.has(row.status)) {
            return null;
        }
        const attempt = row.retry_count + 1;
        row.status = "processing";
        row.runner_job_id = executionName;
        row.runner_attempt = attempt;
        row.runner_phase = "starting_instance";
        row.runner_started_at_ms = nowMs;
        row.runner_timeout_at_ms = nowMs + FAILED_RETRY_BACKOFF_MS;
        row.error_code = null;
        row.updated_at_ms = nowMs;
        await this.put(row);
        return { sourceEventId, executionName, attempt };
    }

    async markFailed(
        sourceEventId: string,
        errorCode: OracleErrorCode,
        nowMs: number,
        nextRetryAtMs: number,
        runnerErrorMessage?: string,
    ): Promise<void> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return;
        }
        row.status = "failed";
        row.retry_count += 1;
        row.next_retry_at_ms = nextRetryAtMs;
        row.error_code = errorCode;
        row.runner_error_message = runnerErrorMessage ?? null;
        row.updated_at_ms = nowMs;
        await this.put(row);
    }

    async applyRunnerResult(
        sourceEventId: string,
        result: TeeCoreResult,
        nowMs: number,
        pendingNextRetryAtMs?: number,
    ): Promise<void> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return;
        }
        await applyResultToRow(row, result, nowMs, pendingNextRetryAtMs);
        await this.put(row);
    }

    async markRelayerSucceeded(
        sourceEventId: string,
        success: RelayerSuccess,
        nowMs: number,
    ): Promise<void> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return;
        }
        if (success.mode === "submit") {
            row.status = "submitted";
            row.relayer_submitted_at_ms = nowMs;
        }
        row.relayer_mode = success.mode;
        row.relayer_status = "succeeded";
        row.relayer_request_json = JSON.stringify(success.request);
        row.relayer_digest = success.digest ?? null;
        row.relayer_error_code = null;
        row.relayer_error_message = null;
        row.relayer_updated_at_ms = nowMs;
        row.updated_at_ms = nowMs;
        await this.put(row);
    }

    async markRelayerFailed(
        sourceEventId: string,
        mode: RelayerMode,
        errorCode: RelayerErrorCode,
        message: string,
        nowMs: number,
    ): Promise<void> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return;
        }
        row.relayer_mode = mode;
        row.relayer_status = "failed";
        row.relayer_error_code = errorCode;
        row.relayer_error_message = message;
        row.relayer_updated_at_ms = nowMs;
        row.updated_at_ms = nowMs;
        await this.put(row);
    }

    async enqueueRunnerJob(
        sourceEventId: string,
        attempt: number,
        runnerJobId: string,
        nowMs: number,
    ): Promise<RunnerQueueJob | null> {
        const row = await this.get(sourceEventId);
        if (row === null || !DUE_STATUSES.has(row.status) || row.retry_count !== attempt - 1) {
            return null;
        }
        row.status = "queued";
        row.runner_job_id = runnerJobId;
        row.runner_queued_at_ms = nowMs;
        row.runner_attempt = attempt;
        row.runner_phase = "queued";
        row.next_retry_at_ms = null;
        row.error_code = null;
        row.updated_at_ms = nowMs;
        await this.put(row);
        return {
            runner_job_id: runnerJobId,
            source_event_id: sourceEventId,
            attempt,
            enqueued_at_ms: nowMs,
        };
    }

    async markQueueEnqueueFailed(
        sourceEventId: string,
        runnerJobId: string,
        nowMs: number,
        nextRetryAtMs: number,
        message: string,
    ): Promise<void> {
        const row = await this.get(sourceEventId);
        if (row === null || row.runner_job_id !== runnerJobId) {
            return;
        }
        row.status = "new";
        row.next_retry_at_ms = nextRetryAtMs;
        row.runner_error_message = message;
        row.updated_at_ms = nowMs;
        await this.put(row);
    }

    async claimQueuedForProcessing(
        job: RunnerQueueJob,
        nowMs: number,
        timeoutAtMs: number,
    ): Promise<boolean> {
        const row = await this.get(job.source_event_id);
        if (
            row === null ||
            row.status !== "queued" ||
            row.runner_job_id !== job.runner_job_id ||
            row.runner_attempt !== job.attempt
        ) {
            return false;
        }
        row.status = "processing";
        row.runner_timeout_at_ms = timeoutAtMs;
        row.updated_at_ms = nowMs;
        await this.put(row);
        return true;
    }

    async recordRunnerStarted(
        sourceEventId: string,
        runnerJobId: string,
        runnerId: string,
        nowMs: number,
        timeoutAtMs: number,
    ): Promise<void> {
        const row = await this.get(sourceEventId);
        if (row === null || row.runner_job_id !== runnerJobId) {
            return;
        }
        row.runner_id = runnerId;
        row.runner_started_at_ms = nowMs;
        row.runner_timeout_at_ms = timeoutAtMs;
        row.updated_at_ms = nowMs;
        await this.put(row);
    }

    async recordRunnerStopped(
        sourceEventId: string,
        runnerJobId: string,
        nowMs: number,
    ): Promise<void> {
        const row = await this.get(sourceEventId);
        if (row === null || row.runner_job_id !== runnerJobId) {
            return;
        }
        row.runner_stopped_at_ms = nowMs;
        row.runner_stop_error = null;
        row.updated_at_ms = nowMs;
        await this.put(row);
    }

    async recordRunnerStopFailed(
        sourceEventId: string,
        runnerJobId: string,
        message: string,
        nowMs: number,
    ): Promise<void> {
        const row = await this.get(sourceEventId);
        if (row === null || row.runner_job_id !== runnerJobId) {
            return;
        }
        row.runner_stop_error = message;
        row.updated_at_ms = nowMs;
        await this.put(row);
    }

    async deferUntil(sourceEventId: string, nextRetryAtMs: number, nowMs: number): Promise<void> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return;
        }
        row.next_retry_at_ms = nextRetryAtMs;
        row.updated_at_ms = nowMs;
        await this.put(row);
    }

    async markRejected(
        sourceEventId: string,
        errorCode: Extract<OracleErrorCode, "REJECTED_AUTO_TRIGGER">,
        nowMs: number,
    ): Promise<void> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return;
        }
        row.status = "rejected";
        row.error_code = errorCode;
        row.next_retry_at_ms = null;
        row.updated_at_ms = nowMs;
        await this.put(row);
    }

    async recoverStaleProcessing(
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<number> {
        const rows = await this.scanRows();
        let recovered = 0;
        for (const row of rows) {
            if (row.status === "processing" && row.updated_at_ms <= staleBeforeMs) {
                await this.markFailed(
                    row.source_event_id,
                    "AWS_RUNNER_TIMEOUT",
                    nowMs,
                    nextRetryAtMs,
                );
                recovered += 1;
            }
        }
        return recovered;
    }

    async recoverStaleQueued(
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<number> {
        const rows = await this.scanRows();
        let recovered = 0;
        for (const row of rows) {
            if (
                row.status === "queued" &&
                row.runner_queued_at_ms !== null &&
                row.runner_queued_at_ms <= staleBeforeMs
            ) {
                await this.markQueueEnqueueFailed(
                    row.source_event_id,
                    row.runner_job_id ?? "",
                    nowMs,
                    nextRetryAtMs,
                    "queued runner job was not processed before stale timeout",
                );
                recovered += 1;
            }
        }
        return recovered;
    }

    private async scanRows(): Promise<EarthquakeEventRow[]> {
        const rows: EarthquakeEventRow[] = [];
        let exclusiveStartKey: Record<string, unknown> | undefined;
        do {
            const result = (await this.documentClient.send(
                new ScanCommand({
                    TableName: this.tableName,
                    ...(exclusiveStartKey === undefined
                        ? {}
                        : { ExclusiveStartKey: exclusiveStartKey }),
                }),
            )) as {
                Items?: EarthquakeEventRow[];
                LastEvaluatedKey?: Record<string, unknown>;
            };
            rows.push(...(result.Items ?? []));
            exclusiveStartKey = result.LastEvaluatedKey;
        } while (exclusiveStartKey !== undefined);
        return rows;
    }

    private async put(row: EarthquakeEventRow): Promise<void> {
        await this.documentClient.send(
            new PutCommand({
                TableName: this.tableName,
                Item: row,
            }),
        );
    }
}

function baseRow(
    sourceEventId: string,
    nowMs: number,
    patch: Partial<EarthquakeEventRow>,
): EarthquakeEventRow {
    return {
        source_event_id: sourceEventId,
        event_uid: null,
        status: "new",
        retry_count: 0,
        next_retry_at_ms: null,
        finalization_deadline_at_ms: nowMs + FINALIZATION_WINDOW_MS,
        latest_revision: 0,
        last_seen_at_ms: nowMs,
        source_updated_at_ms: null,
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
        runner_phase: null,
        runner_instance_id: null,
        runner_command_id: null,
        runner_result_s3_key: null,
        runner_last_poll_at_ms: null,
        tee_result_json: null,
        payload_bcs_hex: null,
        signature: null,
        public_key: null,
        finalized_at_ms: null,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
        ...patch,
    };
}

function mergePreservingResult(
    existing: EarthquakeEventRow | undefined,
    next: EarthquakeEventRow,
    nowMs: number,
): EarthquakeEventRow {
    if (existing === undefined) {
        return next;
    }
    return {
        ...existing,
        event_uid: next.event_uid,
        status: next.status,
        next_retry_at_ms: next.next_retry_at_ms,
        finalization_deadline_at_ms: next.finalization_deadline_at_ms,
        latest_revision: next.latest_revision,
        last_seen_at_ms: next.last_seen_at_ms,
        source_updated_at_ms: next.source_updated_at_ms,
        error_code: next.status === "ignored_small" ? next.error_code : existing.error_code,
        updated_at_ms: nowMs,
    };
}

function isReadyForRetryOrDeadline(row: EarthquakeEventRow, nowMs: number): boolean {
    if (
        (row.status === "pending_source" || row.status === "pending_mmi") &&
        row.finalization_deadline_at_ms <= nowMs
    ) {
        return true;
    }
    return row.next_retry_at_ms === null || row.next_retry_at_ms <= nowMs;
}

async function applyResultToRow(
    row: EarthquakeEventRow,
    result: TeeCoreResult,
    nowMs: number,
    pendingNextRetryAtMs?: number,
): Promise<void> {
    row.tee_result_json = JSON.stringify(result);
    row.updated_at_ms = nowMs;
    row.error_code = result.status === "finalized" ? null : result.error_code;
    row.runner_phase = "complete";
    if (result.status === "finalized") {
        const metadata = finalizedPayloadMetadata(result.payload);
        row.status = "finalized";
        row.next_retry_at_ms = null;
        row.event_uid = metadata.eventUid;
        row.latest_revision = metadata.eventRevision;
        row.source_updated_at_ms = metadata.sourceUpdatedAtMs;
        row.payload_bcs_hex = result.payload_bcs_hex;
        row.signature = result.signature;
        row.public_key = result.public_key;
        row.finalized_at_ms = nowMs;
        return;
    }
    if (result.status === "rejected") {
        row.status = "rejected";
        row.next_retry_at_ms = null;
        return;
    }
    row.status = result.status;
    row.retry_count += 1;
    row.next_retry_at_ms = pendingNextRetryAtMs ?? nowMs + FAILED_RETRY_BACKOFF_MS;
}

function finalizedPayloadMetadata(
    payload: Extract<TeeCoreResult, { status: "finalized" }>["payload"],
): {
    eventUid: string;
    eventRevision: number;
    sourceUpdatedAtMs: number;
} {
    if (
        typeof payload.event_uid !== "string" ||
        typeof payload.event_revision !== "number" ||
        typeof payload.source_updated_at_ms !== "number"
    ) {
        throw new Error("invalid finalized TEE result metadata");
    }
    return {
        eventUid: payload.event_uid,
        eventRevision: payload.event_revision,
        sourceUpdatedAtMs: payload.source_updated_at_ms,
    };
}
