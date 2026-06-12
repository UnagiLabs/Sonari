import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DeleteCommand,
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    ScanCommand,
    TransactWriteCommand,
    UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
    type EarthquakeOraclePayload,
    type OffchainStatus,
    type OracleErrorCode,
    type TeeCoreResult,
    validateRelayerSubmitInput,
} from "@sonari/earthquake-shared";
import {
    FAILED_RETRY_BACKOFF_MS,
    FINALIZATION_WINDOW_MS,
    PROCESSING_STALE_AFTER_MS,
} from "./constants.js";
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
    requested_source_event_id?: string | null;
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
    relayer_object_id: string | null;
    relayer_error_code: RelayerErrorCode | null;
    relayer_error_message: string | null;
    relayer_updated_at_ms: number | null;
    relayer_submitted_at_ms: number | null;
    source_archive_status: SourceArchiveStatus | null;
    source_archive_error_code: SourceArchiveErrorCode | null;
    source_archive_attempt: number | null;
    source_artifact_s3_keys_json: string | null;
    walrus_archive_updated_at_ms: number | null;
    affected_cells_proof_registration_status: AffectedCellsProofRegistrationStatus | null;
    affected_cells_proof_registration_error_code: AffectedCellsProofRegistrationErrorCode | null;
    affected_cells_proof_registration_attempt: number | null;
    affected_cells_proof_registration_next_retry_at_ms: number | null;
    affected_cells_proof_registration_error_message: string | null;
    affected_cells_proof_registration_updated_at_ms: number | null;
    floor_census_status: FloorCensusStatus | null;
    floor_census_attempt: number | null;
    floor_census_retry_count: number;
    floor_census_digest: string | null;
    floor_census_counts_json: string | null;
    floor_census_error_message: string | null;
    floor_census_updated_at_ms: number | null;
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
    | "health_checking"
    | "getting_attestation"
    | "registering_enclave"
    | "dispatching_command"
    | "polling_command"
    | "reading_result"
    | "applying_result"
    | "archiving_sources"
    | "registering_affected_cells_proof"
    | "stopping_instance"
    | "complete";

export type SourceArchiveStatus =
    | "skipped"
    | "success"
    | "configuration_failed"
    | "retryable_failed"
    | "integrity_failed";
export type SourceArchiveErrorCode =
    | "SOURCE_ARCHIVE_CONFIGURATION_FAILED"
    | "SOURCE_ARCHIVE_RETRYABLE_FAILED"
    | "SOURCE_ARCHIVE_INTEGRITY_FAILED";

export type AffectedCellsProofRegistrationStatus =
    | "skipped"
    | "success"
    | "configuration_failed"
    | "retryable_failed"
    | "integrity_failed";
export type AffectedCellsProofRegistrationErrorCode =
    | "AFFECTED_CELLS_PROOF_REGISTRATION_CONFIGURATION_FAILED"
    | "AFFECTED_CELLS_PROOF_REGISTRATION_RETRYABLE_FAILED"
    | "AFFECTED_CELLS_PROOF_REGISTRATION_INTEGRITY_FAILED";
export type FloorCensusStatus = "skipped" | "processing" | "succeeded" | "failed";

export interface FloorCensusStateUpdate {
    status: Exclude<FloorCensusStatus, "processing">;
    digest?: string | undefined;
    counts?: readonly [bigint, bigint, bigint] | undefined;
    message?: string | undefined;
}

export interface RunnerQueueJob {
    runner_job_id: string;
    source_event_id: string;
    attempt: number;
    enqueued_at_ms: number;
}

export interface UpsertCandidateOptions {
    bypassScreening?: boolean;
}

export interface UpsertManualEventOptions {
    requestedSourceEventId?: string;
}

export interface WorkflowStartInput {
    sourceEventId: string;
    executionName: string;
    attempt: number;
}

interface RunnerWorkflowLockRow {
    source_event_id: typeof RUNNER_WORKFLOW_LOCK_SOURCE_EVENT_ID;
    lock_owner_source_event_id: string;
    runner_job_id: string;
    runner_attempt: number;
    lock_acquired_at_ms: number;
    lock_expires_at_ms: number;
}

export interface RunnerWorkflowProgressUpdate {
    sourceEventId: string;
    attempt: number;
    phase: RunnerPhase;
    nowMs: number;
    instanceId?: string | undefined;
    commandId?: string | undefined;
    resultS3Key?: string | undefined;
    lastPollAtMs?: number | undefined;
    allowNonProcessing?: boolean | undefined;
}

export interface StateRepository {
    upsertCandidate(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
        options?: UpsertCandidateOptions,
    ): Promise<void>;
    upsertManualEvent(
        sourceEventId: string,
        nowMs: number,
        options?: UpsertManualEventOptions,
    ): Promise<void>;
    get(sourceEventId: string): Promise<EarthquakeEventRow | null>;
    listDue(nowMs: number, limit: number): Promise<EarthquakeEventRow[]>;
    listDueAffectedCellsProofRegistrations(
        nowMs: number,
        limit: number,
    ): Promise<EarthquakeEventRow[]>;
    claimAffectedCellsProofRegistrationRetry(
        sourceEventId: string,
        expectedNextRetryAtMs: number,
        nowMs: number,
    ): Promise<{ attempt: number; resultS3Key: string } | null>;
    hasActiveRunnerWorkflow(staleBeforeMs?: number): Promise<boolean>;
    tryStartRunnerWorkflowExclusively(
        sourceEventId: string,
        executionName: string,
        nowMs: number,
        expectedRetryCount?: number,
    ): Promise<WorkflowStartInput | null>;
    markWorkflowStarted(
        sourceEventId: string,
        executionName: string,
        nowMs: number,
        expectedRetryCount?: number,
    ): Promise<WorkflowStartInput | null>;
    markWorkflowStopped(sourceEventId: string, attempt: number, nowMs: number): Promise<boolean>;
    updateRunnerWorkflowProgress(input: RunnerWorkflowProgressUpdate): Promise<boolean>;
    markFailed(
        sourceEventId: string,
        errorCode: OracleErrorCode,
        nowMs: number,
        nextRetryAtMs: number,
        runnerErrorMessage?: string,
        expectedAttempt?: number,
    ): Promise<boolean>;
    applyRunnerResult(
        sourceEventId: string,
        result: TeeCoreResult,
        nowMs: number,
        pendingNextRetryAtMs?: number,
        expectedAttempt?: number,
    ): Promise<boolean>;
    markRelayerSucceeded(
        sourceEventId: string,
        success: RelayerSuccess,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean>;
    markRelayerFailed(
        sourceEventId: string,
        mode: RelayerMode,
        errorCode: RelayerErrorCode,
        message: string,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean>;
    markSourceArchiveResult(
        sourceEventId: string,
        input: SourceArchiveStateUpdate,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean>;
    markAffectedCellsProofRegistrationResult(
        sourceEventId: string,
        input: AffectedCellsProofRegistrationStateUpdate,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean>;
    markFloorCensusProcessing(
        sourceEventId: string,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean>;
    markFloorCensusResult(
        sourceEventId: string,
        input: FloorCensusStateUpdate,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean>;

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

export interface SourceArchiveStateUpdate {
    status: SourceArchiveStatus;
    artifactS3Keys: string[];
    errorCode?: SourceArchiveErrorCode;
    retryableNextRetryAtMs?: number;
    message?: string;
}

export interface AffectedCellsProofRegistrationStateUpdate {
    status: AffectedCellsProofRegistrationStatus;
    errorCode?: AffectedCellsProofRegistrationErrorCode;
    retryableNextRetryAtMs?: number;
    message?: string;
}

const DUE_STATUSES = new Set<OffchainStatus>(["new", "pending_source", "pending_mmi", "failed"]);
const TERMINAL_STATUSES = new Set<OffchainStatus>([
    "finalized",
    "submitted",
    "rejected",
    "ignored_small",
]);
const RESULT_TERMINAL_STATUSES = new Set<OffchainStatus>(["finalized", "submitted", "rejected"]);
const RUNNER_WORKFLOW_LOCK_SOURCE_EVENT_ID = "__sonari_runner_workflow_lock__";

export class InMemoryStateRepository implements StateRepository {
    private readonly rows = new Map<string, EarthquakeEventRow>();
    private runnerWorkflowLock: RunnerWorkflowLockRow | undefined;

    async upsertCandidate(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
        options: UpsertCandidateOptions = {},
    ): Promise<void> {
        const existing = this.rows.get(candidate.source_event_id);
        const screening = options.bypassScreening
            ? { status: "new" as const, error_code: null }
            : screenUsgsCandidate(candidate);
        const status = nextScreeningStatus(existing?.status, screening.status);
        const retryCount = existing?.retry_count ?? 0;
        const row = baseRow(candidate.source_event_id, nowMs, {
            requested_source_event_id: candidate.requested_source_event_id ?? null,
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

    async upsertManualEvent(
        sourceEventId: string,
        nowMs: number,
        options: UpsertManualEventOptions = {},
    ): Promise<void> {
        await this.upsertCandidate(
            {
                source_event_id: sourceEventId,
                ...(options.requestedSourceEventId === undefined
                    ? {}
                    : { requested_source_event_id: options.requestedSourceEventId }),
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
        const row = this.rows.get(sourceEventId);
        if (row !== undefined && DUE_STATUSES.has(row.status)) {
            row.next_retry_at_ms = null;
            row.updated_at_ms = nowMs;
        }
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

    async listDueAffectedCellsProofRegistrations(
        nowMs: number,
        limit: number,
    ): Promise<EarthquakeEventRow[]> {
        return [...this.rows.values()]
            .filter((row) => isDueAffectedCellsProofRegistration(row, nowMs))
            .sort(
                (a, b) =>
                    (a.affected_cells_proof_registration_next_retry_at_ms ?? a.updated_at_ms) -
                    (b.affected_cells_proof_registration_next_retry_at_ms ?? b.updated_at_ms),
            )
            .slice(0, limit)
            .map((row) => structuredClone(row));
    }

    async claimAffectedCellsProofRegistrationRetry(
        sourceEventId: string,
        expectedNextRetryAtMs: number,
        nowMs: number,
    ): Promise<{ attempt: number; resultS3Key: string } | null> {
        const row = this.rows.get(sourceEventId);
        if (
            row === undefined ||
            !isDueAffectedCellsProofRegistration(row, nowMs) ||
            row.affected_cells_proof_registration_next_retry_at_ms !== expectedNextRetryAtMs ||
            row.runner_attempt === null ||
            row.runner_result_s3_key === null
        ) {
            return null;
        }
        row.affected_cells_proof_registration_next_retry_at_ms = nowMs + PROCESSING_STALE_AFTER_MS;
        row.affected_cells_proof_registration_updated_at_ms = nowMs;
        row.updated_at_ms = nowMs;
        return { attempt: row.runner_attempt, resultS3Key: row.runner_result_s3_key };
    }

    async hasActiveRunnerWorkflow(staleBeforeMs?: number): Promise<boolean> {
        return [...this.rows.values()].some((row) => isActiveRunnerWorkflow(row, staleBeforeMs));
    }

    async tryStartRunnerWorkflowExclusively(
        sourceEventId: string,
        executionName: string,
        nowMs: number,
        expectedRetryCount?: number,
    ): Promise<WorkflowStartInput | null> {
        if (
            this.runnerWorkflowLock !== undefined &&
            this.runnerWorkflowLock.lock_expires_at_ms > nowMs
        ) {
            return null;
        }
        const started = await this.markWorkflowStarted(
            sourceEventId,
            executionName,
            nowMs,
            expectedRetryCount,
        );
        if (started === null) {
            return null;
        }
        this.runnerWorkflowLock = {
            source_event_id: RUNNER_WORKFLOW_LOCK_SOURCE_EVENT_ID,
            lock_owner_source_event_id: sourceEventId,
            runner_job_id: executionName,
            runner_attempt: started.attempt,
            lock_acquired_at_ms: nowMs,
            lock_expires_at_ms: nowMs + FAILED_RETRY_BACKOFF_MS,
        };
        return started;
    }

    async markWorkflowStarted(
        sourceEventId: string,
        executionName: string,
        nowMs: number,
        expectedRetryCount?: number,
    ): Promise<WorkflowStartInput | null> {
        const row = this.rows.get(sourceEventId);
        if (
            row === undefined ||
            !DUE_STATUSES.has(row.status) ||
            !isReadyForRetryOrDeadline(row, nowMs) ||
            (expectedRetryCount !== undefined && row.retry_count !== expectedRetryCount)
        ) {
            return null;
        }
        const attempt = row.retry_count + 1;
        row.status = "processing";
        row.runner_job_id = executionName;
        row.runner_queued_at_ms = null;
        row.runner_attempt = attempt;
        row.runner_id = null;
        row.runner_phase = "starting_instance";
        row.runner_started_at_ms = nowMs;
        row.runner_stopped_at_ms = null;
        row.runner_timeout_at_ms = nowMs + FAILED_RETRY_BACKOFF_MS;
        row.runner_error_message = null;
        row.runner_stop_error = null;
        row.runner_instance_id = null;
        row.runner_command_id = null;
        row.runner_result_s3_key = null;
        row.runner_last_poll_at_ms = null;
        row.tee_result_json = null;
        row.error_code = null;
        row.updated_at_ms = nowMs;
        return { sourceEventId, executionName, attempt };
    }

    async markWorkflowStopped(
        sourceEventId: string,
        attempt: number,
        nowMs: number,
    ): Promise<boolean> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined || row.runner_attempt !== attempt) {
            return false;
        }
        row.runner_stopped_at_ms = nowMs;
        row.runner_stop_error = null;
        row.runner_phase = "complete";
        row.updated_at_ms = nowMs;
        this.releaseRunnerWorkflowLock(sourceEventId, attempt);
        return true;
    }

    async updateRunnerWorkflowProgress(input: RunnerWorkflowProgressUpdate): Promise<boolean> {
        const row = this.rows.get(input.sourceEventId);
        if (
            row === undefined ||
            row.runner_attempt !== input.attempt ||
            (!input.allowNonProcessing && row.status !== "processing")
        ) {
            return false;
        }
        applyRunnerWorkflowProgress(row, input);
        return true;
    }

    async markFailed(
        sourceEventId: string,
        errorCode: OracleErrorCode,
        nowMs: number,
        nextRetryAtMs: number,
        runnerErrorMessage?: string,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return false;
        }
        if (
            expectedAttempt !== undefined &&
            (row.status !== "processing" || row.runner_attempt !== expectedAttempt)
        ) {
            return false;
        }
        row.status = "failed";
        row.retry_count += 1;
        row.next_retry_at_ms = nextRetryAtMs;
        row.error_code = errorCode;
        row.runner_error_message = runnerErrorMessage ?? null;
        row.updated_at_ms = nowMs;
        return true;
    }

    async applyRunnerResult(
        sourceEventId: string,
        result: TeeCoreResult,
        nowMs: number,
        pendingNextRetryAtMs?: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return false;
        }
        if (
            expectedAttempt !== undefined &&
            (row.status !== "processing" || row.runner_attempt !== expectedAttempt)
        ) {
            return false;
        }
        await applyResultToRow(row, result, nowMs, pendingNextRetryAtMs);
        return true;
    }

    async markRelayerSucceeded(
        sourceEventId: string,
        success: RelayerSuccess,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        if (success.mode === "submit") {
            row.status = "submitted";
            row.relayer_submitted_at_ms = nowMs;
        }
        row.relayer_mode = success.mode;
        row.relayer_status = "succeeded";
        row.relayer_request_json = JSON.stringify(success.request);
        row.relayer_digest = success.digest ?? null;
        row.relayer_object_id = success.objectId ?? null;
        row.relayer_error_code = null;
        row.relayer_error_message = null;
        row.relayer_updated_at_ms = nowMs;
        row.updated_at_ms = nowMs;
        return true;
    }

    async markRelayerFailed(
        sourceEventId: string,
        mode: RelayerMode,
        errorCode: RelayerErrorCode,
        message: string,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        row.relayer_mode = mode;
        row.relayer_status = "failed";
        row.relayer_error_code = errorCode;
        row.relayer_error_message = message;
        row.relayer_updated_at_ms = nowMs;
        row.updated_at_ms = nowMs;
        return true;
    }

    async markSourceArchiveResult(
        sourceEventId: string,
        input: SourceArchiveStateUpdate,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        applySourceArchiveResultToRow(row, input, nowMs, expectedAttempt);
        return true;
    }

    async markAffectedCellsProofRegistrationResult(
        sourceEventId: string,
        input: AffectedCellsProofRegistrationStateUpdate,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        applyAffectedCellsProofRegistrationResultToRow(row, input, nowMs, expectedAttempt);
        return true;
    }

    async markFloorCensusProcessing(
        sourceEventId: string,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined || row.floor_census_status === "succeeded") {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        row.floor_census_status = "processing";
        row.floor_census_attempt = expectedAttempt ?? row.runner_attempt;
        row.floor_census_updated_at_ms = nowMs;
        row.updated_at_ms = nowMs;
        return true;
    }

    async markFloorCensusResult(
        sourceEventId: string,
        input: FloorCensusStateUpdate,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        applyFloorCensusResultToRow(row, input, nowMs, expectedAttempt);
        return true;
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
                const didRecover = await this.markFailed(
                    row.source_event_id,
                    "AWS_RUNNER_TIMEOUT",
                    nowMs,
                    nextRetryAtMs,
                );
                if (didRecover) {
                    recovered += 1;
                }
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

    private releaseRunnerWorkflowLock(sourceEventId: string, attempt: number): void {
        if (
            this.runnerWorkflowLock?.lock_owner_source_event_id === sourceEventId &&
            this.runnerWorkflowLock.runner_attempt === attempt
        ) {
            this.runnerWorkflowLock = undefined;
        }
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
        const screening = options.bypassScreening
            ? { status: "new" as const, error_code: null }
            : screenUsgsCandidate(candidate);
        try {
            await this.updateScreenableCandidate(candidate, nowMs, screening);
        } catch (error) {
            if (!isConditionalCheckFailed(error)) {
                throw error;
            }
            await this.updateWatcherMetadata(candidate, nowMs);
        }
    }

    async upsertManualEvent(
        sourceEventId: string,
        nowMs: number,
        options: UpsertManualEventOptions = {},
    ): Promise<void> {
        await this.upsertCandidate(
            {
                source_event_id: sourceEventId,
                ...(options.requestedSourceEventId === undefined
                    ? {}
                    : { requested_source_event_id: options.requestedSourceEventId }),
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
        await this.clearManualRetryBackoff(sourceEventId, nowMs);
    }

    private async clearManualRetryBackoff(sourceEventId: string, nowMs: number): Promise<void> {
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { source_event_id: sourceEventId },
                    ConditionExpression:
                        "attribute_exists(#source_event_id) AND #status IN (:new_status, :pending_source_status, :pending_mmi_status, :failed_status)",
                    UpdateExpression:
                        "SET #next_retry_at_ms = :null_value, #updated_at_ms = :updated_at_ms",
                    ExpressionAttributeNames: {
                        "#source_event_id": "source_event_id",
                        "#status": "status",
                        "#next_retry_at_ms": "next_retry_at_ms",
                        "#updated_at_ms": "updated_at_ms",
                    },
                    ExpressionAttributeValues: {
                        ":new_status": "new",
                        ":pending_source_status": "pending_source",
                        ":pending_mmi_status": "pending_mmi",
                        ":failed_status": "failed",
                        ":null_value": null,
                        ":updated_at_ms": nowMs,
                    },
                }),
            );
        } catch (error) {
            if (!isConditionalCheckFailed(error)) {
                throw error;
            }
        }
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

    async listDueAffectedCellsProofRegistrations(
        nowMs: number,
        limit: number,
    ): Promise<EarthquakeEventRow[]> {
        return (await this.scanRows())
            .filter((row) => isDueAffectedCellsProofRegistration(row, nowMs))
            .sort(
                (a, b) =>
                    (a.affected_cells_proof_registration_next_retry_at_ms ?? a.updated_at_ms) -
                    (b.affected_cells_proof_registration_next_retry_at_ms ?? b.updated_at_ms),
            )
            .slice(0, limit);
    }

    async claimAffectedCellsProofRegistrationRetry(
        sourceEventId: string,
        expectedNextRetryAtMs: number,
        nowMs: number,
    ): Promise<{ attempt: number; resultS3Key: string } | null> {
        const row = await this.get(sourceEventId);
        if (
            row === null ||
            !isDueAffectedCellsProofRegistration(row, nowMs) ||
            row.affected_cells_proof_registration_next_retry_at_ms !== expectedNextRetryAtMs ||
            row.runner_attempt === null ||
            row.runner_result_s3_key === null
        ) {
            return null;
        }
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { source_event_id: sourceEventId },
                    ConditionExpression:
                        "#affected_cells_proof_registration_status = :retryable_failed_status AND #affected_cells_proof_registration_next_retry_at_ms = :expected_next_retry_at_ms AND #source_archive_status = :source_archive_success_status AND #runner_attempt = :runner_attempt AND #runner_result_s3_key = :runner_result_s3_key",
                    UpdateExpression:
                        "SET #affected_cells_proof_registration_next_retry_at_ms = :lease_until_ms, #affected_cells_proof_registration_updated_at_ms = :updated_at_ms, #updated_at_ms = :updated_at_ms",
                    ExpressionAttributeNames: {
                        "#affected_cells_proof_registration_status":
                            "affected_cells_proof_registration_status",
                        "#affected_cells_proof_registration_next_retry_at_ms":
                            "affected_cells_proof_registration_next_retry_at_ms",
                        "#affected_cells_proof_registration_updated_at_ms":
                            "affected_cells_proof_registration_updated_at_ms",
                        "#source_archive_status": "source_archive_status",
                        "#runner_attempt": "runner_attempt",
                        "#runner_result_s3_key": "runner_result_s3_key",
                        "#updated_at_ms": "updated_at_ms",
                    },
                    ExpressionAttributeValues: {
                        ":retryable_failed_status": "retryable_failed",
                        ":expected_next_retry_at_ms": expectedNextRetryAtMs,
                        ":source_archive_success_status": "success",
                        ":runner_attempt": row.runner_attempt,
                        ":runner_result_s3_key": row.runner_result_s3_key,
                        ":updated_at_ms": nowMs,
                        ":lease_until_ms": nowMs + PROCESSING_STALE_AFTER_MS,
                    },
                }),
            );
        } catch (error) {
            if (isConditionalCheckFailed(error)) {
                return null;
            }
            throw error;
        }
        return { attempt: row.runner_attempt, resultS3Key: row.runner_result_s3_key };
    }

    async hasActiveRunnerWorkflow(staleBeforeMs?: number): Promise<boolean> {
        return (await this.scanRows()).some((row) => isActiveRunnerWorkflow(row, staleBeforeMs));
    }

    async tryStartRunnerWorkflowExclusively(
        sourceEventId: string,
        executionName: string,
        nowMs: number,
        expectedRetryCount?: number,
    ): Promise<WorkflowStartInput | null> {
        const retryCount = expectedRetryCount ?? (await this.get(sourceEventId))?.retry_count;
        if (retryCount === undefined) {
            return null;
        }
        const attempt = retryCount + 1;
        try {
            await this.documentClient.send(
                new TransactWriteCommand({
                    TransactItems: [
                        {
                            Update: {
                                TableName: this.tableName,
                                Key: { source_event_id: sourceEventId },
                                ConditionExpression: workflowStartConditionExpression(),
                                UpdateExpression: workflowStartUpdateExpression(),
                                ExpressionAttributeNames: workflowStartExpressionNames(),
                                ExpressionAttributeValues: workflowStartExpressionValues({
                                    retryCount,
                                    executionName,
                                    attempt,
                                    nowMs,
                                }),
                            },
                        },
                        {
                            Put: {
                                TableName: this.tableName,
                                Item: {
                                    source_event_id: RUNNER_WORKFLOW_LOCK_SOURCE_EVENT_ID,
                                    lock_owner_source_event_id: sourceEventId,
                                    runner_job_id: executionName,
                                    runner_attempt: attempt,
                                    lock_acquired_at_ms: nowMs,
                                    lock_expires_at_ms: nowMs + FAILED_RETRY_BACKOFF_MS,
                                } satisfies RunnerWorkflowLockRow,
                                ConditionExpression:
                                    "attribute_not_exists(#source_event_id) OR #lock_expires_at_ms <= :now_ms",
                                ExpressionAttributeNames: {
                                    "#source_event_id": "source_event_id",
                                    "#lock_expires_at_ms": "lock_expires_at_ms",
                                },
                                ExpressionAttributeValues: {
                                    ":now_ms": nowMs,
                                },
                            },
                        },
                    ],
                }),
            );
        } catch (error) {
            if (isConditionalCheckFailed(error) || isTransactionCanceled(error)) {
                return null;
            }
            throw error;
        }
        return { sourceEventId, executionName, attempt };
    }

    async markWorkflowStarted(
        sourceEventId: string,
        executionName: string,
        nowMs: number,
        expectedRetryCount?: number,
    ): Promise<WorkflowStartInput | null> {
        const retryCount = expectedRetryCount ?? (await this.get(sourceEventId))?.retry_count;
        if (retryCount === undefined) {
            return null;
        }
        const attempt = retryCount + 1;
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { source_event_id: sourceEventId },
                    ConditionExpression: workflowStartConditionExpression(),
                    UpdateExpression: workflowStartUpdateExpression(),
                    ExpressionAttributeNames: workflowStartExpressionNames(),
                    ExpressionAttributeValues: workflowStartExpressionValues({
                        retryCount,
                        executionName,
                        attempt,
                        nowMs,
                    }),
                }),
            );
        } catch (error) {
            if (isConditionalCheckFailed(error)) {
                return null;
            }
            throw error;
        }
        return { sourceEventId, executionName, attempt };
    }

    async markWorkflowStopped(
        sourceEventId: string,
        attempt: number,
        nowMs: number,
    ): Promise<boolean> {
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { source_event_id: sourceEventId },
                    ConditionExpression: "#runner_attempt = :expected_attempt",
                    UpdateExpression:
                        "SET #runner_stopped_at_ms = :runner_stopped_at_ms, #runner_stop_error = :runner_stop_error, #runner_phase = :runner_phase, #updated_at_ms = :updated_at_ms",
                    ExpressionAttributeNames: {
                        "#runner_attempt": "runner_attempt",
                        "#runner_stopped_at_ms": "runner_stopped_at_ms",
                        "#runner_stop_error": "runner_stop_error",
                        "#runner_phase": "runner_phase",
                        "#updated_at_ms": "updated_at_ms",
                    },
                    ExpressionAttributeValues: {
                        ":expected_attempt": attempt,
                        ":runner_stopped_at_ms": nowMs,
                        ":runner_stop_error": null,
                        ":runner_phase": "complete",
                        ":updated_at_ms": nowMs,
                    },
                }),
            );
            await this.releaseRunnerWorkflowLock(sourceEventId, attempt);
            return true;
        } catch (error) {
            if (isConditionalCheckFailed(error)) {
                return false;
            }
            throw error;
        }
    }

    async updateRunnerWorkflowProgress(input: RunnerWorkflowProgressUpdate): Promise<boolean> {
        const patch: Partial<EarthquakeEventRow> = {
            runner_phase: input.phase,
            updated_at_ms: input.nowMs,
        };
        if (input.instanceId !== undefined) {
            patch.runner_instance_id = input.instanceId;
        }
        if (input.commandId !== undefined) {
            patch.runner_command_id = input.commandId;
        }
        if (input.resultS3Key !== undefined) {
            patch.runner_result_s3_key = input.resultS3Key;
        }
        if (input.lastPollAtMs !== undefined) {
            patch.runner_last_poll_at_ms = input.lastPollAtMs;
        }
        const entries = Object.entries(patch);
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { source_event_id: input.sourceEventId },
                    ConditionExpression: input.allowNonProcessing
                        ? "#runner_attempt = :expected_attempt"
                        : "#status = :processing_status AND #runner_attempt = :expected_attempt",
                    UpdateExpression: `SET ${entries
                        .map(([field]) => `#${field} = :${field}`)
                        .join(", ")}`,
                    ExpressionAttributeNames: {
                        ...expressionNames(entries.map(([field]) => field)),
                        ...(input.allowNonProcessing ? {} : { "#status": "status" }),
                        "#runner_attempt": "runner_attempt",
                    },
                    ExpressionAttributeValues: {
                        ...Object.fromEntries(
                            entries.map(([field, value]) => [`:${field}`, value]),
                        ),
                        ...(input.allowNonProcessing ? {} : { ":processing_status": "processing" }),
                        ":expected_attempt": input.attempt,
                    },
                }),
            );
            return true;
        } catch (error) {
            if (isConditionalCheckFailed(error)) {
                return false;
            }
            throw error;
        }
    }

    async markFailed(
        sourceEventId: string,
        errorCode: OracleErrorCode,
        nowMs: number,
        nextRetryAtMs: number,
        runnerErrorMessage?: string,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return false;
        }
        if (
            expectedAttempt !== undefined &&
            (row.status !== "processing" || row.runner_attempt !== expectedAttempt)
        ) {
            return false;
        }
        row.status = "failed";
        row.retry_count += 1;
        row.next_retry_at_ms = nextRetryAtMs;
        row.error_code = errorCode;
        row.runner_error_message = runnerErrorMessage ?? null;
        row.updated_at_ms = nowMs;
        return this.put(row, expectedAttempt);
    }

    async applyRunnerResult(
        sourceEventId: string,
        result: TeeCoreResult,
        nowMs: number,
        pendingNextRetryAtMs?: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return false;
        }
        if (
            expectedAttempt !== undefined &&
            (row.status !== "processing" || row.runner_attempt !== expectedAttempt)
        ) {
            return false;
        }
        await applyResultToRow(row, result, nowMs, pendingNextRetryAtMs);
        return this.put(row, expectedAttempt);
    }

    async markRelayerSucceeded(
        sourceEventId: string,
        success: RelayerSuccess,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        if (success.mode === "submit") {
            row.status = "submitted";
            row.relayer_submitted_at_ms = nowMs;
        }
        row.relayer_mode = success.mode;
        row.relayer_status = "succeeded";
        row.relayer_request_json = JSON.stringify(success.request);
        row.relayer_digest = success.digest ?? null;
        row.relayer_object_id = success.objectId ?? null;
        row.relayer_error_code = null;
        row.relayer_error_message = null;
        row.relayer_updated_at_ms = nowMs;
        row.updated_at_ms = nowMs;
        return this.put(row, expectedAttempt, true);
    }

    async markRelayerFailed(
        sourceEventId: string,
        mode: RelayerMode,
        errorCode: RelayerErrorCode,
        message: string,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        row.relayer_mode = mode;
        row.relayer_status = "failed";
        row.relayer_error_code = errorCode;
        row.relayer_error_message = message;
        row.relayer_updated_at_ms = nowMs;
        row.updated_at_ms = nowMs;
        return this.put(row, expectedAttempt, true);
    }

    async markSourceArchiveResult(
        sourceEventId: string,
        input: SourceArchiveStateUpdate,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        applySourceArchiveResultToRow(row, input, nowMs, expectedAttempt);
        return this.put(row, expectedAttempt, true);
    }

    async markAffectedCellsProofRegistrationResult(
        sourceEventId: string,
        input: AffectedCellsProofRegistrationStateUpdate,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        applyAffectedCellsProofRegistrationResultToRow(row, input, nowMs, expectedAttempt);
        return this.put(row, expectedAttempt, true);
    }

    async markFloorCensusProcessing(
        sourceEventId: string,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = await this.get(sourceEventId);
        if (row === null || row.floor_census_status === "succeeded") {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        row.floor_census_status = "processing";
        row.floor_census_attempt = expectedAttempt ?? row.runner_attempt;
        row.floor_census_updated_at_ms = nowMs;
        row.updated_at_ms = nowMs;
        return this.put(row, expectedAttempt, true);
    }

    async markFloorCensusResult(
        sourceEventId: string,
        input: FloorCensusStateUpdate,
        nowMs: number,
        expectedAttempt?: number,
    ): Promise<boolean> {
        const row = await this.get(sourceEventId);
        if (row === null) {
            return false;
        }
        if (expectedAttempt !== undefined && row.runner_attempt !== expectedAttempt) {
            return false;
        }
        applyFloorCensusResultToRow(row, input, nowMs, expectedAttempt);
        return this.put(row, expectedAttempt, true);
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
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { source_event_id: sourceEventId },
                    ConditionExpression:
                        "attribute_exists(#source_event_id) AND #status = :new_status",
                    UpdateExpression:
                        "SET #next_retry_at_ms = :next_retry_at_ms, #updated_at_ms = :updated_at_ms",
                    ExpressionAttributeNames: {
                        "#source_event_id": "source_event_id",
                        "#status": "status",
                        "#next_retry_at_ms": "next_retry_at_ms",
                        "#updated_at_ms": "updated_at_ms",
                    },
                    ExpressionAttributeValues: {
                        ":new_status": "new",
                        ":next_retry_at_ms": nextRetryAtMs,
                        ":updated_at_ms": nowMs,
                    },
                }),
            );
        } catch (error) {
            if (!isConditionalCheckFailed(error)) {
                throw error;
            }
        }
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
                if (
                    await this.recoverStaleProcessingRow(row, staleBeforeMs, nowMs, nextRetryAtMs)
                ) {
                    recovered += 1;
                }
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
                    ConsistentRead: true,
                    ...(exclusiveStartKey === undefined
                        ? {}
                        : { ExclusiveStartKey: exclusiveStartKey }),
                }),
            )) as {
                Items?: EarthquakeEventRow[];
                LastEvaluatedKey?: Record<string, unknown>;
            };
            rows.push(...(result.Items ?? []).filter(isEarthquakeEventRow));
            exclusiveStartKey = result.LastEvaluatedKey;
        } while (exclusiveStartKey !== undefined);
        return rows;
    }

    private async releaseRunnerWorkflowLock(sourceEventId: string, attempt: number): Promise<void> {
        try {
            await this.documentClient.send(
                new DeleteCommand({
                    TableName: this.tableName,
                    Key: { source_event_id: RUNNER_WORKFLOW_LOCK_SOURCE_EVENT_ID },
                    ConditionExpression:
                        "#lock_owner_source_event_id = :source_event_id AND #runner_attempt = :runner_attempt",
                    ExpressionAttributeNames: {
                        "#lock_owner_source_event_id": "lock_owner_source_event_id",
                        "#runner_attempt": "runner_attempt",
                    },
                    ExpressionAttributeValues: {
                        ":source_event_id": sourceEventId,
                        ":runner_attempt": attempt,
                    },
                }),
            );
        } catch (error) {
            if (!isConditionalCheckFailed(error)) {
                throw error;
            }
        }
    }

    private async put(
        row: EarthquakeEventRow,
        expectedAttempt?: number,
        allowNonProcessing = false,
    ): Promise<boolean> {
        try {
            await this.documentClient.send(
                new PutCommand({
                    TableName: this.tableName,
                    Item: row,
                    ...(expectedAttempt === undefined
                        ? {}
                        : {
                              ConditionExpression: allowNonProcessing
                                  ? "#runner_attempt = :expected_attempt"
                                  : "#status = :processing_status AND #runner_attempt = :expected_attempt",
                              ExpressionAttributeNames: {
                                  ...(allowNonProcessing ? {} : { "#status": "status" }),
                                  "#runner_attempt": "runner_attempt",
                              },
                              ExpressionAttributeValues: {
                                  ...(allowNonProcessing
                                      ? {}
                                      : { ":processing_status": "processing" }),
                                  ":expected_attempt": expectedAttempt,
                              },
                          }),
                }),
            );
            return true;
        } catch (error) {
            if (isConditionalCheckFailed(error)) {
                return false;
            }
            throw error;
        }
    }

    private async recoverStaleProcessingRow(
        row: EarthquakeEventRow,
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<boolean> {
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { source_event_id: row.source_event_id },
                    ConditionExpression:
                        "#status = :processing_status AND #updated_at_ms <= :stale_before_ms",
                    UpdateExpression:
                        "SET #status = :failed_status, #retry_count = :retry_count, #next_retry_at_ms = :next_retry_at_ms, #error_code = :error_code, #runner_error_message = :runner_error_message, #updated_at_ms = :updated_at_ms",
                    ExpressionAttributeNames: {
                        "#status": "status",
                        "#retry_count": "retry_count",
                        "#next_retry_at_ms": "next_retry_at_ms",
                        "#error_code": "error_code",
                        "#runner_error_message": "runner_error_message",
                        "#updated_at_ms": "updated_at_ms",
                    },
                    ExpressionAttributeValues: {
                        ":processing_status": "processing",
                        ":stale_before_ms": staleBeforeMs,
                        ":failed_status": "failed",
                        ":retry_count": row.retry_count + 1,
                        ":next_retry_at_ms": nextRetryAtMs,
                        ":error_code": "AWS_RUNNER_TIMEOUT",
                        ":runner_error_message": null,
                        ":updated_at_ms": nowMs,
                    },
                }),
            );
            return true;
        } catch (error) {
            if (isConditionalCheckFailed(error)) {
                return false;
            }
            throw error;
        }
    }

    private async updateScreenableCandidate(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
        screening: { status: OffchainStatus; error_code: OracleErrorCode | null },
    ): Promise<void> {
        const conditionExpression =
            screening.status === "ignored_small"
                ? "attribute_not_exists(#source_event_id) OR #status = :ignored_small_status"
                : "attribute_not_exists(#source_event_id) OR #status IN (:new_status, :ignored_small_status)";
        const conditionValues =
            screening.status === "ignored_small"
                ? { ":ignored_small_status": "ignored_small" }
                : { ":new_status": "new", ":ignored_small_status": "ignored_small" };
        const row = baseRow(candidate.source_event_id, nowMs, {
            requested_source_event_id: candidate.requested_source_event_id ?? null,
            event_uid: candidate.source_event_id,
            status: screening.status,
            retry_count: 0,
            next_retry_at_ms: null,
            finalization_deadline_at_ms: candidate.occurred_at_ms + FINALIZATION_WINDOW_MS,
            latest_revision: 0,
            last_seen_at_ms: nowMs,
            source_updated_at_ms: candidate.source_updated_at_ms,
            error_code:
                screening.status === "ignored_small"
                    ? "WATCHER_BELOW_AUTO_THRESHOLD"
                    : screening.error_code,
            created_at_ms: nowMs,
        });
        await this.documentClient.send(
            new UpdateCommand({
                TableName: this.tableName,
                Key: { source_event_id: candidate.source_event_id },
                ConditionExpression: conditionExpression,
                UpdateExpression: [
                    "SET #requested_source_event_id = :requested_source_event_id",
                    "#event_uid = :event_uid",
                    "#status = :status",
                    "#retry_count = :retry_count",
                    "#next_retry_at_ms = :next_retry_at_ms",
                    "#finalization_deadline_at_ms = :finalization_deadline_at_ms",
                    "#latest_revision = :latest_revision",
                    "#last_seen_at_ms = :last_seen_at_ms",
                    "#source_updated_at_ms = :source_updated_at_ms",
                    "#error_code = :error_code",
                    "#relayer_mode = :relayer_mode",
                    "#relayer_status = :relayer_status",
                    "#relayer_request_json = :relayer_request_json",
                    "#relayer_digest = :relayer_digest",
                    "#relayer_object_id = :relayer_object_id",
                    "#relayer_error_code = :relayer_error_code",
                    "#relayer_error_message = :relayer_error_message",
                    "#relayer_updated_at_ms = :relayer_updated_at_ms",
                    "#relayer_submitted_at_ms = :relayer_submitted_at_ms",
                    "#source_archive_status = :source_archive_status",
                    "#source_archive_error_code = :source_archive_error_code",
                    "#source_archive_attempt = :source_archive_attempt",
                    "#source_artifact_s3_keys_json = :source_artifact_s3_keys_json",
                    "#walrus_archive_updated_at_ms = :walrus_archive_updated_at_ms",
                    "#affected_cells_proof_registration_status = :affected_cells_proof_registration_status",
                    "#affected_cells_proof_registration_error_code = :affected_cells_proof_registration_error_code",
                    "#affected_cells_proof_registration_attempt = :affected_cells_proof_registration_attempt",
                    "#affected_cells_proof_registration_next_retry_at_ms = :affected_cells_proof_registration_next_retry_at_ms",
                    "#affected_cells_proof_registration_error_message = :affected_cells_proof_registration_error_message",
                    "#affected_cells_proof_registration_updated_at_ms = :affected_cells_proof_registration_updated_at_ms",
                    "#floor_census_status = :floor_census_status",
                    "#floor_census_attempt = :floor_census_attempt",
                    "#floor_census_retry_count = :floor_census_retry_count",
                    "#floor_census_digest = :floor_census_digest",
                    "#floor_census_counts_json = :floor_census_counts_json",
                    "#floor_census_error_message = :floor_census_error_message",
                    "#floor_census_updated_at_ms = :floor_census_updated_at_ms",
                    "#runner_job_id = :runner_job_id",
                    "#runner_queued_at_ms = :runner_queued_at_ms",
                    "#runner_attempt = :runner_attempt",
                    "#runner_id = :runner_id",
                    "#runner_started_at_ms = :runner_started_at_ms",
                    "#runner_stopped_at_ms = :runner_stopped_at_ms",
                    "#runner_timeout_at_ms = :runner_timeout_at_ms",
                    "#runner_error_message = :runner_error_message",
                    "#runner_stop_error = :runner_stop_error",
                    "#runner_phase = :runner_phase",
                    "#runner_instance_id = :runner_instance_id",
                    "#runner_command_id = :runner_command_id",
                    "#runner_result_s3_key = :runner_result_s3_key",
                    "#runner_last_poll_at_ms = :runner_last_poll_at_ms",
                    "#tee_result_json = :tee_result_json",
                    "#payload_bcs_hex = :payload_bcs_hex",
                    "#signature = :signature",
                    "#public_key = :public_key",
                    "#finalized_at_ms = :finalized_at_ms",
                    "#created_at_ms = :created_at_ms",
                    "#updated_at_ms = :updated_at_ms",
                ].join(", "),
                ExpressionAttributeNames: expressionNames(Object.keys(row)),
                ExpressionAttributeValues: {
                    ...expressionValues(row),
                    ...conditionValues,
                },
            }),
        );
    }

    private async updateWatcherMetadata(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
    ): Promise<void> {
        try {
            await this.updateNonTerminalWatcherMetadataFields(candidate, nowMs);
        } catch (error) {
            if (!isConditionalCheckFailed(error)) {
                throw error;
            }
            try {
                await this.updateTerminalWatcherMetadataFields(candidate, nowMs);
            } catch (fallbackError) {
                if (!isConditionalCheckFailed(fallbackError)) {
                    throw fallbackError;
                }
                try {
                    await this.updateActiveWatcherMetadataFields(candidate, nowMs);
                } catch (activeFallbackError) {
                    if (!isConditionalCheckFailed(activeFallbackError)) {
                        throw activeFallbackError;
                    }
                }
            }
        }
    }

    private async updateNonTerminalWatcherMetadataFields(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
    ): Promise<void> {
        const stopPendingCondition =
            "(#runner_phase IN (:complete_phase, :stopping_instance_phase) AND #runner_stopped_at_ms = :null_value)";
        await this.documentClient.send(
            new UpdateCommand({
                TableName: this.tableName,
                Key: { source_event_id: candidate.source_event_id },
                ConditionExpression: `attribute_exists(#source_event_id) AND NOT (#status IN (:processing_status, :finalized_status, :submitted_status, :rejected_status)) AND NOT ${stopPendingCondition}`,
                UpdateExpression:
                    "SET #last_seen_at_ms = :last_seen_at_ms, #source_updated_at_ms = :source_updated_at_ms, #updated_at_ms = :updated_at_ms",
                ExpressionAttributeNames: {
                    "#source_event_id": "source_event_id",
                    "#status": "status",
                    "#runner_phase": "runner_phase",
                    "#runner_stopped_at_ms": "runner_stopped_at_ms",
                    "#last_seen_at_ms": "last_seen_at_ms",
                    "#source_updated_at_ms": "source_updated_at_ms",
                    "#updated_at_ms": "updated_at_ms",
                },
                ExpressionAttributeValues: {
                    ":processing_status": "processing",
                    ":finalized_status": "finalized",
                    ":submitted_status": "submitted",
                    ":rejected_status": "rejected",
                    ":complete_phase": "complete",
                    ":stopping_instance_phase": "stopping_instance",
                    ":null_value": null,
                    ":last_seen_at_ms": nowMs,
                    ":source_updated_at_ms": candidate.source_updated_at_ms,
                    ":updated_at_ms": nowMs,
                },
            }),
        );
    }

    private async updateTerminalWatcherMetadataFields(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
    ): Promise<void> {
        const stopPendingCondition =
            "(#runner_phase IN (:complete_phase, :stopping_instance_phase) AND #runner_stopped_at_ms = :null_value)";
        await this.documentClient.send(
            new UpdateCommand({
                TableName: this.tableName,
                Key: { source_event_id: candidate.source_event_id },
                ConditionExpression: `attribute_exists(#source_event_id) AND #status IN (:finalized_status, :submitted_status, :rejected_status) AND NOT ${stopPendingCondition}`,
                UpdateExpression:
                    "SET #last_seen_at_ms = :last_seen_at_ms, #updated_at_ms = :updated_at_ms",
                ExpressionAttributeNames: {
                    "#source_event_id": "source_event_id",
                    "#status": "status",
                    "#runner_phase": "runner_phase",
                    "#runner_stopped_at_ms": "runner_stopped_at_ms",
                    "#last_seen_at_ms": "last_seen_at_ms",
                    "#updated_at_ms": "updated_at_ms",
                },
                ExpressionAttributeValues: {
                    ":finalized_status": "finalized",
                    ":submitted_status": "submitted",
                    ":rejected_status": "rejected",
                    ":complete_phase": "complete",
                    ":stopping_instance_phase": "stopping_instance",
                    ":null_value": null,
                    ":last_seen_at_ms": nowMs,
                    ":updated_at_ms": nowMs,
                },
            }),
        );
    }

    private async updateActiveWatcherMetadataFields(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
    ): Promise<void> {
        await this.documentClient.send(
            new UpdateCommand({
                TableName: this.tableName,
                Key: { source_event_id: candidate.source_event_id },
                ConditionExpression:
                    "attribute_exists(#source_event_id) AND #status = :processing_status",
                UpdateExpression:
                    "SET #last_seen_at_ms = :last_seen_at_ms, #source_updated_at_ms = :source_updated_at_ms",
                ExpressionAttributeNames: {
                    "#source_event_id": "source_event_id",
                    "#status": "status",
                    "#last_seen_at_ms": "last_seen_at_ms",
                    "#source_updated_at_ms": "source_updated_at_ms",
                },
                ExpressionAttributeValues: {
                    ":processing_status": "processing",
                    ":last_seen_at_ms": nowMs,
                    ":source_updated_at_ms": candidate.source_updated_at_ms,
                },
            }),
        );
    }
}

function workflowStartConditionExpression(): string {
    return "#retry_count = :expected_retry_count AND #status IN (:new_status, :pending_source_status, :pending_mmi_status, :failed_status) AND (attribute_not_exists(#next_retry_at_ms) OR #next_retry_at_ms = :null_value OR #next_retry_at_ms <= :now_ms OR (#status IN (:pending_source_status, :pending_mmi_status) AND #finalization_deadline_at_ms <= :now_ms))";
}

function workflowStartUpdateExpression(): string {
    return [
        "SET #status = :processing_status",
        "#runner_job_id = :runner_job_id",
        "#runner_queued_at_ms = :null_value",
        "#runner_attempt = :runner_attempt",
        "#runner_id = :null_value",
        "#runner_phase = :runner_phase",
        "#runner_started_at_ms = :now_ms",
        "#runner_stopped_at_ms = :null_value",
        "#runner_timeout_at_ms = :runner_timeout_at_ms",
        "#runner_error_message = :null_value",
        "#runner_stop_error = :null_value",
        "#runner_instance_id = :null_value",
        "#runner_command_id = :null_value",
        "#runner_result_s3_key = :null_value",
        "#runner_last_poll_at_ms = :null_value",
        "#tee_result_json = :null_value",
        "#error_code = :null_value",
        "#updated_at_ms = :now_ms",
    ].join(", ");
}

function workflowStartExpressionNames(): Record<string, string> {
    return {
        "#status": "status",
        "#retry_count": "retry_count",
        "#next_retry_at_ms": "next_retry_at_ms",
        "#finalization_deadline_at_ms": "finalization_deadline_at_ms",
        "#runner_job_id": "runner_job_id",
        "#runner_queued_at_ms": "runner_queued_at_ms",
        "#runner_attempt": "runner_attempt",
        "#runner_id": "runner_id",
        "#runner_phase": "runner_phase",
        "#runner_started_at_ms": "runner_started_at_ms",
        "#runner_stopped_at_ms": "runner_stopped_at_ms",
        "#runner_timeout_at_ms": "runner_timeout_at_ms",
        "#runner_error_message": "runner_error_message",
        "#runner_stop_error": "runner_stop_error",
        "#runner_instance_id": "runner_instance_id",
        "#runner_command_id": "runner_command_id",
        "#runner_result_s3_key": "runner_result_s3_key",
        "#runner_last_poll_at_ms": "runner_last_poll_at_ms",
        "#tee_result_json": "tee_result_json",
        "#error_code": "error_code",
        "#updated_at_ms": "updated_at_ms",
    };
}

function workflowStartExpressionValues(input: {
    retryCount: number;
    executionName: string;
    attempt: number;
    nowMs: number;
}): Record<string, unknown> {
    return {
        ":expected_retry_count": input.retryCount,
        ":new_status": "new",
        ":pending_source_status": "pending_source",
        ":pending_mmi_status": "pending_mmi",
        ":failed_status": "failed",
        ":processing_status": "processing",
        ":runner_job_id": input.executionName,
        ":runner_attempt": input.attempt,
        ":runner_phase": "starting_instance",
        ":runner_timeout_at_ms": input.nowMs + FAILED_RETRY_BACKOFF_MS,
        ":now_ms": input.nowMs,
        ":null_value": null,
    };
}

function nextScreeningStatus(
    existingStatus: OffchainStatus | undefined,
    screeningStatus: OffchainStatus,
): OffchainStatus {
    if (existingStatus === undefined || existingStatus === "ignored_small") {
        return screeningStatus;
    }
    if (existingStatus === "new" && screeningStatus === "ignored_small") {
        return "new";
    }
    if (TERMINAL_STATUSES.has(existingStatus) || existingStatus !== "new") {
        return existingStatus;
    }
    return screeningStatus;
}

function expressionNames(fields: string[]): Record<string, string> {
    return Object.fromEntries(fields.map((field) => [`#${field}`, field]));
}

function expressionValues(row: EarthquakeEventRow): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(row)
            .filter(([field]) => field !== "source_event_id")
            .map(([field, value]) => [`:${field}`, value]),
    );
}

function isConditionalCheckFailed(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "ConditionalCheckFailedException"
    );
}

function isTransactionCanceled(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "TransactionCanceledException"
    );
}

function isEarthquakeEventRow(row: EarthquakeEventRow): boolean {
    return row.source_event_id !== RUNNER_WORKFLOW_LOCK_SOURCE_EVENT_ID;
}

function baseRow(
    sourceEventId: string,
    nowMs: number,
    patch: Partial<EarthquakeEventRow>,
): EarthquakeEventRow {
    return {
        source_event_id: sourceEventId,
        requested_source_event_id: null,
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
        relayer_object_id: null,
        relayer_error_code: null,
        relayer_error_message: null,
        relayer_updated_at_ms: null,
        relayer_submitted_at_ms: null,
        source_archive_status: null,
        source_archive_error_code: null,
        source_archive_attempt: null,
        source_artifact_s3_keys_json: null,
        walrus_archive_updated_at_ms: null,
        affected_cells_proof_registration_status: null,
        affected_cells_proof_registration_error_code: null,
        affected_cells_proof_registration_attempt: null,
        affected_cells_proof_registration_next_retry_at_ms: null,
        affected_cells_proof_registration_error_message: null,
        affected_cells_proof_registration_updated_at_ms: null,
        floor_census_status: null,
        floor_census_attempt: null,
        floor_census_retry_count: 0,
        floor_census_digest: null,
        floor_census_counts_json: null,
        floor_census_error_message: null,
        floor_census_updated_at_ms: null,
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
        requested_source_event_id:
            next.requested_source_event_id ?? existing.requested_source_event_id ?? null,
        event_uid: next.event_uid,
        status: next.status,
        next_retry_at_ms: next.next_retry_at_ms,
        finalization_deadline_at_ms: next.finalization_deadline_at_ms,
        latest_revision: next.latest_revision,
        last_seen_at_ms: next.last_seen_at_ms,
        source_updated_at_ms: RESULT_TERMINAL_STATUSES.has(existing.status)
            ? existing.source_updated_at_ms
            : next.source_updated_at_ms,
        error_code:
            existing.status === "ignored_small" && next.status === "new"
                ? null
                : next.status === "ignored_small"
                  ? next.error_code
                  : existing.error_code,
        updated_at_ms: isActiveRunnerWorkflow(existing) ? existing.updated_at_ms : nowMs,
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

function isDueAffectedCellsProofRegistration(row: EarthquakeEventRow, nowMs: number): boolean {
    return (
        row.affected_cells_proof_registration_status === "retryable_failed" &&
        row.affected_cells_proof_registration_next_retry_at_ms !== null &&
        row.affected_cells_proof_registration_next_retry_at_ms <= nowMs &&
        row.source_archive_status === "success" &&
        row.runner_result_s3_key !== null &&
        row.runner_attempt !== null
    );
}

function isActiveRunnerWorkflow(row: EarthquakeEventRow, staleBeforeMs?: number): boolean {
    if (staleBeforeMs !== undefined && row.updated_at_ms <= staleBeforeMs) {
        return false;
    }
    if (row.status === "processing") {
        return true;
    }
    return (
        (row.runner_phase === "complete" || row.runner_phase === "stopping_instance") &&
        row.runner_attempt !== null &&
        row.runner_started_at_ms !== null &&
        row.runner_stopped_at_ms === null
    );
}

async function applyResultToRow(
    row: EarthquakeEventRow,
    result: TeeCoreResult,
    nowMs: number,
    pendingNextRetryAtMs?: number,
): Promise<void> {
    if (result.status === "finalized") {
        const metadata = finalizedPayloadMetadata(result);
        row.tee_result_json = JSON.stringify(compactTeeResultForState(result));
        row.updated_at_ms = nowMs;
        row.error_code = null;
        row.runner_phase = "complete";
        row.status = "finalized";
        row.next_retry_at_ms = null;
        row.event_uid = metadata.eventUid;
        row.latest_revision = metadata.eventRevision;
        row.source_updated_at_ms = metadata.sourceUpdatedAtMs;
        row.payload_bcs_hex = result.payload_bcs_hex;
        row.signature = result.signature;
        row.public_key = result.public_key;
        row.finalized_at_ms = nowMs;
        row.source_archive_status = null;
        row.source_archive_error_code = null;
        row.source_archive_attempt = null;
        row.source_artifact_s3_keys_json = null;
        row.walrus_archive_updated_at_ms = null;
        row.affected_cells_proof_registration_status = null;
        row.affected_cells_proof_registration_error_code = null;
        row.affected_cells_proof_registration_attempt = null;
        row.affected_cells_proof_registration_next_retry_at_ms = null;
        row.affected_cells_proof_registration_error_message = null;
        row.affected_cells_proof_registration_updated_at_ms = null;
        row.floor_census_status = null;
        row.floor_census_attempt = null;
        row.floor_census_retry_count = 0;
        row.floor_census_digest = null;
        row.floor_census_counts_json = null;
        row.floor_census_error_message = null;
        row.floor_census_updated_at_ms = null;
        return;
    }
    row.tee_result_json = JSON.stringify(compactTeeResultForState(result));
    row.updated_at_ms = nowMs;
    row.error_code = result.error_code;
    row.runner_phase = "complete";
    if (result.status === "rejected") {
        row.status = "rejected";
        row.next_retry_at_ms = null;
        return;
    }
    row.status = result.status;
    row.retry_count += 1;
    row.next_retry_at_ms = pendingNextRetryAtMs ?? nowMs + FAILED_RETRY_BACKOFF_MS;
}

function compactTeeResultForState(result: TeeCoreResult): Record<string, unknown> {
    if (result.status === "finalized") {
        const payload = result.payload as EarthquakeOraclePayload;
        return {
            status: result.status,
            source_event_id: payload.source_event_id,
            payload: {
                event_uid: payload.event_uid,
                event_revision: payload.event_revision,
                evidence_manifest_uri: payload.evidence_manifest_uri,
                evidence_manifest_hash: payload.evidence_manifest_hash,
                verified_at_ms: payload.verified_at_ms,
            },
            payload_bcs_hex: result.payload_bcs_hex,
            signature: result.signature,
            public_key: result.public_key,
            verifier_config_key: result.verifier_config_key,
            verifier_config_version: result.verifier_config_version,
            enclave_instance_public_key: result.enclave_instance_public_key,
        };
    }
    return {
        status: result.status,
        source_event_id: result.source_event_id,
        error_code: result.error_code,
    };
}

function applySourceArchiveResultToRow(
    row: EarthquakeEventRow,
    input: SourceArchiveStateUpdate,
    nowMs: number,
    expectedAttempt?: number,
): void {
    row.source_archive_status = input.status;
    row.source_archive_error_code = input.errorCode ?? null;
    row.source_archive_attempt = expectedAttempt ?? row.runner_attempt;
    row.source_artifact_s3_keys_json = JSON.stringify(input.artifactS3Keys);
    row.walrus_archive_updated_at_ms = nowMs;
    row.updated_at_ms = nowMs;
    if (input.status === "retryable_failed") {
        row.status = "failed";
        row.retry_count += 1;
        row.error_code = "SOURCE_ARCHIVE_RETRYABLE_FAILED";
        row.runner_error_message = input.message ?? null;
        row.next_retry_at_ms = input.retryableNextRetryAtMs ?? nowMs + FAILED_RETRY_BACKOFF_MS;
    }
    if (input.status === "configuration_failed") {
        row.status = "rejected";
        row.error_code = "SOURCE_ARCHIVE_CONFIGURATION_FAILED";
        row.runner_error_message = input.message ?? null;
        row.next_retry_at_ms = null;
    }
    if (input.status === "integrity_failed") {
        row.status = "rejected";
        row.error_code = "SOURCE_ARCHIVE_INTEGRITY_FAILED";
        row.runner_error_message = input.message ?? null;
        row.next_retry_at_ms = null;
    }
}

function applyAffectedCellsProofRegistrationResultToRow(
    row: EarthquakeEventRow,
    input: AffectedCellsProofRegistrationStateUpdate,
    nowMs: number,
    expectedAttempt?: number,
): void {
    row.affected_cells_proof_registration_status = input.status;
    row.affected_cells_proof_registration_error_code = input.errorCode ?? null;
    row.affected_cells_proof_registration_attempt = expectedAttempt ?? row.runner_attempt;
    row.affected_cells_proof_registration_updated_at_ms = nowMs;
    row.updated_at_ms = nowMs;
    if (input.status === "retryable_failed") {
        row.affected_cells_proof_registration_next_retry_at_ms =
            input.retryableNextRetryAtMs ?? nowMs + FAILED_RETRY_BACKOFF_MS;
        row.affected_cells_proof_registration_error_message = input.message ?? null;
        return;
    }
    row.affected_cells_proof_registration_next_retry_at_ms = null;
    row.affected_cells_proof_registration_error_message = input.message ?? null;
}

function applyFloorCensusResultToRow(
    row: EarthquakeEventRow,
    input: FloorCensusStateUpdate,
    nowMs: number,
    expectedAttempt?: number,
): void {
    row.floor_census_status = input.status;
    row.floor_census_attempt = expectedAttempt ?? row.runner_attempt;
    row.floor_census_digest = input.digest ?? null;
    row.floor_census_counts_json =
        input.counts === undefined
            ? null
            : JSON.stringify(input.counts.map((count) => count.toString()));
    row.floor_census_error_message = input.message ?? null;
    row.floor_census_updated_at_ms = nowMs;
    if (input.status === "failed") {
        row.floor_census_retry_count += 1;
    }
    row.updated_at_ms = nowMs;
}

function applyRunnerWorkflowProgress(
    row: EarthquakeEventRow,
    input: RunnerWorkflowProgressUpdate,
): void {
    row.runner_phase = input.phase;
    row.updated_at_ms = input.nowMs;
    if (input.instanceId !== undefined) {
        row.runner_instance_id = input.instanceId;
    }
    if (input.commandId !== undefined) {
        row.runner_command_id = input.commandId;
    }
    if (input.resultS3Key !== undefined) {
        row.runner_result_s3_key = input.resultS3Key;
    }
    if (input.lastPollAtMs !== undefined) {
        row.runner_last_poll_at_ms = input.lastPollAtMs;
    }
}

function finalizedPayloadMetadata(result: Extract<TeeCoreResult, { status: "finalized" }>): {
    eventUid: string;
    eventRevision: number;
    sourceUpdatedAtMs: number;
} {
    const validation = validateRelayerSubmitInput(result);
    if (!validation.ok) {
        throw new Error(`invalid finalized TEE result metadata: ${validation.message}`);
    }
    const payload = validation.value.payload as {
        event_uid: string;
        event_revision: number;
        verified_at_ms: number;
    };
    return {
        eventUid: payload.event_uid,
        eventRevision: payload.event_revision,
        sourceUpdatedAtMs:
            validation.value.evidence_manifest?.earthquake.source_updated_at_ms ??
            payload.verified_at_ms,
    };
}
