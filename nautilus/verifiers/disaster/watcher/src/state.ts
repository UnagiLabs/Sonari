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
    tee_result_json: string | null;
    payload_bcs_hex: string | null;
    signature: string | null;
    public_key: string | null;
    finalized_at_ms: number | null;
    created_at_ms: number;
    updated_at_ms: number;
}

export interface RunnerQueueJob {
    runner_job_id: string;
    source_event_id: string;
    attempt: number;
    enqueued_at_ms: number;
}

export interface StateRepository {
    upsertCandidate(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
        options?: UpsertCandidateOptions,
    ): Promise<void>;
    get(sourceEventId: string): Promise<EarthquakeEventRow | null>;
    listDue(nowMs: number, limit: number): Promise<EarthquakeEventRow[]>;
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

export interface UpsertCandidateOptions {
    bypassScreening?: boolean;
}

const DUE_STATUSES: OffchainStatus[] = ["new", "pending_source", "pending_mmi", "failed"];
const TERMINAL_STATUSES = new Set<OffchainStatus>(["finalized", "submitted", "rejected"]);

const SELECT_COLUMNS = `
  source_event_id,
  event_uid,
  status,
  retry_count,
  next_retry_at_ms,
  finalization_deadline_at_ms,
  latest_revision,
  last_seen_at_ms,
  source_updated_at_ms,
  error_code,
  relayer_mode,
  relayer_status,
  relayer_request_json,
  relayer_digest,
  relayer_error_code,
  relayer_error_message,
  relayer_updated_at_ms,
  relayer_submitted_at_ms,
  runner_job_id,
  runner_queued_at_ms,
  runner_attempt,
  runner_id,
  runner_started_at_ms,
  runner_stopped_at_ms,
  runner_timeout_at_ms,
  runner_error_message,
  runner_stop_error,
  tee_result_json,
  payload_bcs_hex,
  signature,
  public_key,
  finalized_at_ms,
  created_at_ms,
  updated_at_ms
`;

export class D1StateRepository implements StateRepository {
    constructor(private readonly db: D1Database) {}

    async upsertCandidate(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
        options: UpsertCandidateOptions = {},
    ): Promise<void> {
        const screening = options.bypassScreening
            ? { status: "new" as const, error_code: null }
            : screenUsgsCandidate(candidate);
        await this.db
            .prepare(
                `INSERT INTO earthquake_events (
                  source_event_id,
                  event_uid,
                  status,
                  retry_count,
                  next_retry_at_ms,
                  finalization_deadline_at_ms,
                  latest_revision,
                  last_seen_at_ms,
                  source_updated_at_ms,
                  error_code,
                  created_at_ms,
                  updated_at_ms
                ) VALUES (?, NULL, ?, 0, NULL, ?, 0, ?, ?, ?, ?, ?)
                ON CONFLICT(source_event_id) DO UPDATE SET
                  status = CASE
                    WHEN earthquake_events.status IN ('finalized', 'submitted', 'rejected')
                      THEN earthquake_events.status
                    WHEN earthquake_events.status = 'ignored_small' AND excluded.status = 'new'
                      THEN 'new'
                    ELSE earthquake_events.status
                  END,
                  next_retry_at_ms = CASE
                    WHEN earthquake_events.status = 'ignored_small'
                      THEN NULL
                    ELSE earthquake_events.next_retry_at_ms
                  END,
                  last_seen_at_ms = excluded.last_seen_at_ms,
                  source_updated_at_ms = CASE
                    WHEN earthquake_events.status IN ('finalized', 'submitted', 'rejected')
                      THEN earthquake_events.source_updated_at_ms
                    ELSE MAX(
                      COALESCE(earthquake_events.source_updated_at_ms, 0),
                      excluded.source_updated_at_ms
                    )
                  END,
                  error_code = CASE
                    WHEN earthquake_events.status IN ('finalized', 'submitted', 'rejected')
                      THEN earthquake_events.error_code
                    WHEN earthquake_events.status = 'ignored_small' AND excluded.status = 'new'
                      THEN NULL
                    WHEN earthquake_events.status = 'ignored_small' AND excluded.status = 'ignored_small'
                      THEN excluded.error_code
                    ELSE earthquake_events.error_code
                  END,
                  updated_at_ms = excluded.updated_at_ms`,
            )
            .bind(
                candidate.source_event_id,
                screening.status,
                candidate.occurred_at_ms + FINALIZATION_WINDOW_MS,
                nowMs,
                candidate.source_updated_at_ms,
                screening.error_code,
                nowMs,
                nowMs,
            )
            .run();
    }

    async get(sourceEventId: string): Promise<EarthquakeEventRow | null> {
        const row = await this.db
            .prepare(`SELECT ${SELECT_COLUMNS} FROM earthquake_events WHERE source_event_id = ?`)
            .bind(sourceEventId)
            .first<RawEarthquakeEventRow>();
        return row === null ? null : normalizeRow(row);
    }

    async listDue(nowMs: number, limit: number): Promise<EarthquakeEventRow[]> {
        const placeholders = DUE_STATUSES.map(() => "?").join(", ");
        const result = await this.db
            .prepare(
                `SELECT ${SELECT_COLUMNS}
                 FROM earthquake_events
                 WHERE status IN (${placeholders})
                   AND (next_retry_at_ms IS NULL OR next_retry_at_ms <= ?)
                 ORDER BY updated_at_ms ASC
                 LIMIT ?`,
            )
            .bind(...DUE_STATUSES, nowMs, limit)
            .all<RawEarthquakeEventRow>();
        return result.results.map(normalizeRow);
    }

    async enqueueRunnerJob(
        sourceEventId: string,
        attempt: number,
        runnerJobId: string,
        nowMs: number,
    ): Promise<RunnerQueueJob | null> {
        const placeholders = DUE_STATUSES.map(() => "?").join(", ");
        const result = await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET status = 'queued',
                     next_retry_at_ms = NULL,
                     error_code = NULL,
                     runner_job_id = ?,
                     runner_queued_at_ms = ?,
                     runner_attempt = ?,
                     runner_id = NULL,
                     runner_started_at_ms = NULL,
                     runner_stopped_at_ms = NULL,
                     runner_timeout_at_ms = NULL,
                     runner_error_message = NULL,
                     runner_stop_error = NULL,
                     tee_result_json = NULL,
                     payload_bcs_hex = NULL,
                     signature = NULL,
                     public_key = NULL,
                     finalized_at_ms = NULL,
                     updated_at_ms = ?
                 WHERE source_event_id = ?
                   AND status IN (${placeholders})
                   AND retry_count = ?
                   AND (next_retry_at_ms IS NULL OR next_retry_at_ms <= ?)`,
            )
            .bind(
                runnerJobId,
                nowMs,
                attempt,
                nowMs,
                sourceEventId,
                ...DUE_STATUSES,
                attempt - 1,
                nowMs,
            )
            .run();
        if (!d1RowsChanged(result)) {
            return null;
        }
        return {
            runner_job_id: runnerJobId,
            source_event_id: sourceEventId,
            attempt,
            enqueued_at_ms: nowMs,
        };
    }

    async claimQueuedForProcessing(
        job: RunnerQueueJob,
        nowMs: number,
        timeoutAtMs: number,
    ): Promise<boolean> {
        const result = await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET status = 'processing',
                     next_retry_at_ms = NULL,
                     error_code = NULL,
                     runner_timeout_at_ms = ?,
                     updated_at_ms = ?
                 WHERE source_event_id = ?
                   AND status = 'queued'
                   AND runner_job_id = ?
                   AND runner_attempt = ?
                   AND retry_count = ?`,
            )
            .bind(
                timeoutAtMs,
                nowMs,
                job.source_event_id,
                job.runner_job_id,
                job.attempt,
                job.attempt - 1,
            )
            .run();
        return d1RowsChanged(result);
    }

    async markQueueEnqueueFailed(
        sourceEventId: string,
        runnerJobId: string,
        nowMs: number,
        nextRetryAtMs: number,
        message: string,
    ): Promise<void> {
        await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET status = 'new',
                     next_retry_at_ms = ?,
                     runner_job_id = NULL,
                     runner_queued_at_ms = NULL,
                     runner_attempt = NULL,
                     runner_error_message = ?,
                     updated_at_ms = ?
                 WHERE source_event_id = ?
                   AND status = 'queued'
                   AND runner_job_id = ?`,
            )
            .bind(nextRetryAtMs, message, nowMs, sourceEventId, runnerJobId)
            .run();
    }

    async recordRunnerStarted(
        sourceEventId: string,
        runnerJobId: string,
        runnerId: string,
        nowMs: number,
        timeoutAtMs: number,
    ): Promise<void> {
        await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET runner_id = ?,
                     runner_started_at_ms = ?,
                     runner_timeout_at_ms = ?,
                     updated_at_ms = ?
                 WHERE source_event_id = ? AND runner_job_id = ?`,
            )
            .bind(runnerId, nowMs, timeoutAtMs, nowMs, sourceEventId, runnerJobId)
            .run();
    }

    async recordRunnerStopped(
        sourceEventId: string,
        runnerJobId: string,
        nowMs: number,
    ): Promise<void> {
        await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET runner_stopped_at_ms = ?,
                     runner_stop_error = NULL,
                     updated_at_ms = ?
                 WHERE source_event_id = ? AND runner_job_id = ?`,
            )
            .bind(nowMs, nowMs, sourceEventId, runnerJobId)
            .run();
    }

    async recordRunnerStopFailed(
        sourceEventId: string,
        runnerJobId: string,
        message: string,
        nowMs: number,
    ): Promise<void> {
        await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET runner_stop_error = ?,
                     updated_at_ms = ?
                 WHERE source_event_id = ? AND runner_job_id = ?`,
            )
            .bind(message, nowMs, sourceEventId, runnerJobId)
            .run();
    }

    async deferUntil(sourceEventId: string, nextRetryAtMs: number, nowMs: number): Promise<void> {
        await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET next_retry_at_ms = ?,
                     error_code = NULL,
                     updated_at_ms = ?
                 WHERE source_event_id = ?`,
            )
            .bind(nextRetryAtMs, nowMs, sourceEventId)
            .run();
    }

    async markRejected(
        sourceEventId: string,
        errorCode: Extract<OracleErrorCode, "REJECTED_AUTO_TRIGGER">,
        nowMs: number,
    ): Promise<void> {
        await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET status = 'rejected',
                     next_retry_at_ms = NULL,
                     error_code = ?,
                     updated_at_ms = ?
                 WHERE source_event_id = ?`,
            )
            .bind(errorCode, nowMs, sourceEventId)
            .run();
    }

    async markFailed(
        sourceEventId: string,
        errorCode: OracleErrorCode,
        nowMs: number,
        nextRetryAtMs: number,
        runnerErrorMessage?: string,
    ): Promise<void> {
        await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET status = 'failed',
                     retry_count = retry_count + 1,
                     next_retry_at_ms = ?,
                     error_code = ?,
                     runner_error_message = ?,
                     updated_at_ms = ?
                 WHERE source_event_id = ?`,
            )
            .bind(nextRetryAtMs, errorCode, runnerErrorMessage ?? null, nowMs, sourceEventId)
            .run();
    }

    async applyRunnerResult(
        sourceEventId: string,
        result: TeeCoreResult,
        nowMs: number,
        pendingNextRetryAtMs?: number,
    ): Promise<void> {
        if (result.status === "finalized") {
            const payload = result.payload as Record<string, unknown>;
            await this.db
                .prepare(
                    `UPDATE earthquake_events
                     SET status = 'finalized',
                         next_retry_at_ms = NULL,
                         error_code = NULL,
                         event_uid = ?,
                         latest_revision = ?,
                         source_updated_at_ms = ?,
                         tee_result_json = ?,
                         payload_bcs_hex = ?,
                         signature = ?,
                         public_key = ?,
                         finalized_at_ms = ?,
                         updated_at_ms = ?
                     WHERE source_event_id = ?`,
                )
                .bind(
                    payload.event_uid,
                    payload.event_revision,
                    payload.source_updated_at_ms,
                    JSON.stringify(result),
                    result.payload_bcs_hex,
                    result.signature,
                    result.public_key,
                    nowMs,
                    nowMs,
                    sourceEventId,
                )
                .run();
            return;
        }

        if (result.status === "rejected") {
            await this.db
                .prepare(
                    `UPDATE earthquake_events
                     SET status = 'rejected',
                         next_retry_at_ms = NULL,
                         error_code = ?,
                         updated_at_ms = ?
                     WHERE source_event_id = ?`,
                )
                .bind(result.error_code, nowMs, sourceEventId)
                .run();
            return;
        }

        await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET status = ?,
                     next_retry_at_ms = ?,
                     error_code = ?,
                     updated_at_ms = ?
                 WHERE source_event_id = ?`,
            )
            .bind(
                result.status,
                pendingNextRetryAtMs ?? null,
                result.error_code,
                nowMs,
                sourceEventId,
            )
            .run();
    }

    async recoverStaleProcessing(
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<number> {
        const staleRows = await this.db
            .prepare(
                `SELECT source_event_id
                 FROM earthquake_events
                 WHERE status = 'processing' AND updated_at_ms <= ?`,
            )
            .bind(staleBeforeMs)
            .all<{ source_event_id: string }>();

        for (const row of staleRows.results) {
            await this.markFailed(row.source_event_id, "AWS_RUNNER_TIMEOUT", nowMs, nextRetryAtMs);
        }

        return staleRows.results.length;
    }

    async recoverStaleQueued(
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<number> {
        const staleRows = await this.db
            .prepare(
                `SELECT source_event_id, runner_job_id
                 FROM earthquake_events
                 WHERE status = 'queued' AND runner_queued_at_ms <= ?`,
            )
            .bind(staleBeforeMs)
            .all<{ source_event_id: string; runner_job_id: string }>();

        for (const row of staleRows.results) {
            await this.markQueueEnqueueFailed(
                row.source_event_id,
                row.runner_job_id,
                nowMs,
                nextRetryAtMs,
                "queued runner job was not processed before stale timeout",
            );
        }

        return staleRows.results.length;
    }

    async markRelayerSucceeded(
        sourceEventId: string,
        success: RelayerSuccess,
        nowMs: number,
    ): Promise<void> {
        await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET status = CASE WHEN ? = 'submit' THEN 'submitted' ELSE status END,
                     relayer_mode = ?,
                     relayer_status = 'succeeded',
                     relayer_request_json = ?,
                     relayer_digest = ?,
                     relayer_error_code = NULL,
                     relayer_error_message = NULL,
                     relayer_updated_at_ms = ?,
                     relayer_submitted_at_ms = CASE WHEN ? = 'submit' THEN ? ELSE relayer_submitted_at_ms END
                 WHERE source_event_id = ?`,
            )
            .bind(
                success.mode,
                success.mode,
                JSON.stringify(success.request),
                success.digest ?? null,
                nowMs,
                success.mode,
                nowMs,
                sourceEventId,
            )
            .run();
    }

    async markRelayerFailed(
        sourceEventId: string,
        mode: RelayerMode,
        errorCode: RelayerErrorCode,
        message: string,
        nowMs: number,
    ): Promise<void> {
        await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET relayer_mode = ?,
                     relayer_status = 'failed',
                     relayer_request_json = NULL,
                     relayer_digest = NULL,
                     relayer_error_code = ?,
                     relayer_error_message = ?,
                     relayer_updated_at_ms = ?
                 WHERE source_event_id = ?`,
            )
            .bind(mode, errorCode, message, nowMs, sourceEventId)
            .run();
    }
}

export class InMemoryStateRepository implements StateRepository {
    private readonly rows = new Map<string, EarthquakeEventRow>();

    async upsertCandidate(
        candidate: UsgsEarthquakeCandidate,
        nowMs: number,
        options: UpsertCandidateOptions = {},
    ): Promise<void> {
        const screening = options.bypassScreening
            ? { status: "new" as const, error_code: null }
            : screenUsgsCandidate(candidate);
        const existing = this.rows.get(candidate.source_event_id);
        if (existing === undefined) {
            this.rows.set(candidate.source_event_id, {
                source_event_id: candidate.source_event_id,
                event_uid: null,
                status: screening.status,
                retry_count: 0,
                next_retry_at_ms: null,
                finalization_deadline_at_ms: candidate.occurred_at_ms + FINALIZATION_WINDOW_MS,
                latest_revision: 0,
                last_seen_at_ms: nowMs,
                source_updated_at_ms: candidate.source_updated_at_ms,
                error_code: screening.error_code,
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
                tee_result_json: null,
                payload_bcs_hex: null,
                signature: null,
                public_key: null,
                finalized_at_ms: null,
                created_at_ms: nowMs,
                updated_at_ms: nowMs,
            });
            return;
        }

        const promotedFromIgnoredSmall =
            existing.status === "ignored_small" && screening.status === "new";
        const refreshedIgnoredSmall =
            existing.status === "ignored_small" && screening.status === "ignored_small";
        this.rows.set(candidate.source_event_id, {
            ...existing,
            status: promotedFromIgnoredSmall ? "new" : existing.status,
            next_retry_at_ms:
                promotedFromIgnoredSmall || refreshedIgnoredSmall
                    ? null
                    : existing.next_retry_at_ms,
            last_seen_at_ms: nowMs,
            source_updated_at_ms: TERMINAL_STATUSES.has(existing.status)
                ? existing.source_updated_at_ms
                : Math.max(existing.source_updated_at_ms ?? 0, candidate.source_updated_at_ms),
            error_code: promotedFromIgnoredSmall
                ? null
                : refreshedIgnoredSmall
                  ? screening.error_code
                  : existing.error_code,
            updated_at_ms: nowMs,
        });
    }

    async get(sourceEventId: string): Promise<EarthquakeEventRow | null> {
        const row = this.rows.get(sourceEventId);
        return row === undefined ? null : cloneRow(row);
    }

    async listDue(nowMs: number, limit: number): Promise<EarthquakeEventRow[]> {
        return Array.from(this.rows.values())
            .filter(
                (row) =>
                    DUE_STATUSES.includes(row.status) &&
                    (row.next_retry_at_ms === null || row.next_retry_at_ms <= nowMs),
            )
            .sort((left, right) => left.updated_at_ms - right.updated_at_ms)
            .slice(0, limit)
            .map(cloneRow);
    }

    async enqueueRunnerJob(
        sourceEventId: string,
        attempt: number,
        runnerJobId: string,
        nowMs: number,
    ): Promise<RunnerQueueJob | null> {
        const row = this.require(sourceEventId);
        if (
            !DUE_STATUSES.includes(row.status) ||
            (row.next_retry_at_ms !== null && row.next_retry_at_ms > nowMs) ||
            row.retry_count !== attempt - 1
        ) {
            return null;
        }

        this.patch(sourceEventId, {
            status: "queued",
            next_retry_at_ms: null,
            error_code: null,
            runner_job_id: runnerJobId,
            runner_queued_at_ms: nowMs,
            runner_attempt: attempt,
            runner_id: null,
            runner_started_at_ms: null,
            runner_stopped_at_ms: null,
            runner_timeout_at_ms: null,
            runner_error_message: null,
            runner_stop_error: null,
            tee_result_json: null,
            payload_bcs_hex: null,
            signature: null,
            public_key: null,
            finalized_at_ms: null,
            updated_at_ms: nowMs,
        });
        return {
            runner_job_id: runnerJobId,
            source_event_id: sourceEventId,
            attempt,
            enqueued_at_ms: nowMs,
        };
    }

    async claimQueuedForProcessing(
        job: RunnerQueueJob,
        nowMs: number,
        timeoutAtMs: number,
    ): Promise<boolean> {
        const row = this.require(job.source_event_id);
        if (
            row.status !== "queued" ||
            row.runner_job_id !== job.runner_job_id ||
            row.runner_attempt !== job.attempt ||
            row.retry_count !== job.attempt - 1
        ) {
            return false;
        }

        this.patch(job.source_event_id, {
            status: "processing",
            next_retry_at_ms: null,
            error_code: null,
            runner_timeout_at_ms: timeoutAtMs,
            updated_at_ms: nowMs,
        });
        return true;
    }

    async markQueueEnqueueFailed(
        sourceEventId: string,
        runnerJobId: string,
        nowMs: number,
        nextRetryAtMs: number,
        message: string,
    ): Promise<void> {
        const row = this.require(sourceEventId);
        if (row.status !== "queued" || row.runner_job_id !== runnerJobId) {
            return;
        }

        this.patch(sourceEventId, {
            status: "new",
            next_retry_at_ms: nextRetryAtMs,
            runner_job_id: null,
            runner_queued_at_ms: null,
            runner_attempt: null,
            runner_error_message: message,
            updated_at_ms: nowMs,
        });
    }

    async claimForProcessing(sourceEventId: string, nowMs: number): Promise<boolean> {
        const row = this.require(sourceEventId);
        const job = await this.enqueueRunnerJob(
            sourceEventId,
            row.retry_count + 1,
            `${sourceEventId}:${row.retry_count + 1}`,
            nowMs,
        );
        if (job === null) {
            return false;
        }
        return this.claimQueuedForProcessing(job, nowMs, nowMs + FAILED_RETRY_BACKOFF_MS);
    }

    async recordRunnerStarted(
        sourceEventId: string,
        runnerJobId: string,
        runnerId: string,
        nowMs: number,
        timeoutAtMs: number,
    ): Promise<void> {
        const row = this.require(sourceEventId);
        if (row.runner_job_id !== runnerJobId) {
            return;
        }
        this.patch(sourceEventId, {
            runner_id: runnerId,
            runner_started_at_ms: nowMs,
            runner_timeout_at_ms: timeoutAtMs,
            updated_at_ms: nowMs,
        });
    }

    async recordRunnerStopped(
        sourceEventId: string,
        runnerJobId: string,
        nowMs: number,
    ): Promise<void> {
        const row = this.require(sourceEventId);
        if (row.runner_job_id !== runnerJobId) {
            return;
        }
        this.patch(sourceEventId, {
            runner_stopped_at_ms: nowMs,
            runner_stop_error: null,
            updated_at_ms: nowMs,
        });
    }

    async recordRunnerStopFailed(
        sourceEventId: string,
        runnerJobId: string,
        message: string,
        nowMs: number,
    ): Promise<void> {
        const row = this.require(sourceEventId);
        if (row.runner_job_id !== runnerJobId) {
            return;
        }
        this.patch(sourceEventId, {
            runner_stop_error: message,
            updated_at_ms: nowMs,
        });
    }

    async deferUntil(sourceEventId: string, nextRetryAtMs: number, nowMs: number): Promise<void> {
        this.patch(sourceEventId, {
            next_retry_at_ms: nextRetryAtMs,
            error_code: null,
            updated_at_ms: nowMs,
        });
    }

    async markRejected(
        sourceEventId: string,
        errorCode: Extract<OracleErrorCode, "REJECTED_AUTO_TRIGGER">,
        nowMs: number,
    ): Promise<void> {
        this.patch(sourceEventId, {
            status: "rejected",
            next_retry_at_ms: null,
            error_code: errorCode,
            updated_at_ms: nowMs,
        });
    }

    async markFailed(
        sourceEventId: string,
        errorCode: OracleErrorCode,
        nowMs: number,
        nextRetryAtMs: number,
        runnerErrorMessage?: string,
    ): Promise<void> {
        const row = this.require(sourceEventId);
        this.patch(sourceEventId, {
            status: "failed",
            retry_count: row.retry_count + 1,
            next_retry_at_ms: nextRetryAtMs,
            error_code: errorCode,
            runner_error_message: runnerErrorMessage ?? null,
            updated_at_ms: nowMs,
        });
    }

    async applyRunnerResult(
        sourceEventId: string,
        result: TeeCoreResult,
        nowMs: number,
        pendingNextRetryAtMs?: number,
    ): Promise<void> {
        if (result.status === "finalized") {
            this.patch(sourceEventId, {
                status: "finalized",
                next_retry_at_ms: null,
                error_code: null,
                event_uid: String(result.payload.event_uid),
                latest_revision: Number(result.payload.event_revision),
                source_updated_at_ms: Number(result.payload.source_updated_at_ms),
                tee_result_json: JSON.stringify(result),
                payload_bcs_hex: result.payload_bcs_hex,
                signature: result.signature,
                public_key: result.public_key,
                finalized_at_ms: nowMs,
                updated_at_ms: nowMs,
            });
            return;
        }

        if (result.status === "rejected") {
            this.patch(sourceEventId, {
                status: "rejected",
                next_retry_at_ms: null,
                error_code: result.error_code,
                updated_at_ms: nowMs,
            });
            return;
        }

        this.patch(sourceEventId, {
            status: result.status,
            next_retry_at_ms: pendingNextRetryAtMs ?? null,
            error_code: result.error_code,
            updated_at_ms: nowMs,
        });
    }

    async recoverStaleProcessing(
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs = nowMs + FAILED_RETRY_BACKOFF_MS,
    ): Promise<number> {
        const staleRows = Array.from(this.rows.values()).filter(
            (row) => row.status === "processing" && row.updated_at_ms <= staleBeforeMs,
        );

        for (const row of staleRows) {
            await this.markFailed(row.source_event_id, "AWS_RUNNER_TIMEOUT", nowMs, nextRetryAtMs);
        }

        return staleRows.length;
    }

    async recoverStaleQueued(
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs = nowMs + FAILED_RETRY_BACKOFF_MS,
    ): Promise<number> {
        const staleRows = Array.from(this.rows.values()).filter(
            (row) =>
                row.status === "queued" &&
                row.runner_queued_at_ms !== null &&
                row.runner_job_id !== null &&
                row.runner_queued_at_ms <= staleBeforeMs,
        );

        for (const row of staleRows) {
            await this.markQueueEnqueueFailed(
                row.source_event_id,
                row.runner_job_id ?? "",
                nowMs,
                nextRetryAtMs,
                "queued runner job was not processed before stale timeout",
            );
        }

        return staleRows.length;
    }

    async markRelayerSucceeded(
        sourceEventId: string,
        success: RelayerSuccess,
        nowMs: number,
    ): Promise<void> {
        const patch: Partial<EarthquakeEventRow> = {
            relayer_mode: success.mode,
            relayer_status: "succeeded",
            relayer_request_json: JSON.stringify(success.request),
            relayer_digest: success.digest ?? null,
            relayer_error_code: null,
            relayer_error_message: null,
            relayer_updated_at_ms: nowMs,
            relayer_submitted_at_ms: success.mode === "submit" ? nowMs : null,
        };
        if (success.mode === "submit") {
            patch.status = "submitted";
        }
        this.patch(sourceEventId, {
            ...patch,
        });
    }

    async markRelayerFailed(
        sourceEventId: string,
        mode: RelayerMode,
        errorCode: RelayerErrorCode,
        message: string,
        nowMs: number,
    ): Promise<void> {
        this.patch(sourceEventId, {
            relayer_mode: mode,
            relayer_status: "failed",
            relayer_request_json: null,
            relayer_digest: null,
            relayer_error_code: errorCode,
            relayer_error_message: message,
            relayer_updated_at_ms: nowMs,
        });
    }

    private patch(sourceEventId: string, patch: Partial<EarthquakeEventRow>): void {
        const row = this.require(sourceEventId);
        if (
            TERMINAL_STATUSES.has(row.status) &&
            patch.status !== undefined &&
            !(row.status === "finalized" && patch.status === "submitted")
        ) {
            return;
        }
        this.rows.set(sourceEventId, { ...row, ...patch });
    }

    private require(sourceEventId: string): EarthquakeEventRow {
        const row = this.rows.get(sourceEventId);
        if (row === undefined) {
            throw new Error(`Unknown earthquake event: ${sourceEventId}`);
        }
        return row;
    }
}

interface RawEarthquakeEventRow extends Record<string, unknown> {
    source_event_id: string;
    event_uid: string | null;
    status: string;
    retry_count: number;
    next_retry_at_ms: number | null;
    finalization_deadline_at_ms: number;
    latest_revision: number | null;
    last_seen_at_ms: number;
    source_updated_at_ms: number | null;
    error_code: string | null;
    relayer_mode: string | null;
    relayer_status: string | null;
    relayer_request_json: string | null;
    relayer_digest: string | null;
    relayer_error_code: string | null;
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
    tee_result_json: string | null;
    payload_bcs_hex: string | null;
    signature: string | null;
    public_key: string | null;
    finalized_at_ms: number | null;
    created_at_ms: number;
    updated_at_ms: number;
}

function normalizeRow(row: RawEarthquakeEventRow): EarthquakeEventRow {
    return {
        source_event_id: row.source_event_id,
        event_uid: row.event_uid,
        status: row.status as OffchainStatus,
        retry_count: row.retry_count,
        next_retry_at_ms: row.next_retry_at_ms,
        finalization_deadline_at_ms: row.finalization_deadline_at_ms,
        latest_revision: row.latest_revision ?? 0,
        last_seen_at_ms: row.last_seen_at_ms,
        source_updated_at_ms: row.source_updated_at_ms,
        error_code: row.error_code as OracleErrorCode | null,
        relayer_mode: row.relayer_mode as RelayerMode | null,
        relayer_status: row.relayer_status as RelayerStatus | null,
        relayer_request_json: row.relayer_request_json,
        relayer_digest: row.relayer_digest,
        relayer_error_code: row.relayer_error_code as RelayerErrorCode | null,
        relayer_error_message: row.relayer_error_message,
        relayer_updated_at_ms: row.relayer_updated_at_ms,
        relayer_submitted_at_ms: row.relayer_submitted_at_ms,
        runner_job_id: row.runner_job_id,
        runner_queued_at_ms: row.runner_queued_at_ms,
        runner_attempt: row.runner_attempt,
        runner_id: row.runner_id,
        runner_started_at_ms: row.runner_started_at_ms,
        runner_stopped_at_ms: row.runner_stopped_at_ms,
        runner_timeout_at_ms: row.runner_timeout_at_ms,
        runner_error_message: row.runner_error_message,
        runner_stop_error: row.runner_stop_error,
        tee_result_json: row.tee_result_json,
        payload_bcs_hex: row.payload_bcs_hex,
        signature: row.signature,
        public_key: row.public_key,
        finalized_at_ms: row.finalized_at_ms,
        created_at_ms: row.created_at_ms,
        updated_at_ms: row.updated_at_ms,
    };
}

function cloneRow(row: EarthquakeEventRow): EarthquakeEventRow {
    return { ...row };
}

function d1RowsChanged(result: D1Result): boolean {
    const meta = result.meta as { changes?: unknown; rows_written?: unknown } | undefined;
    if (meta?.changes !== undefined) {
        return Number(meta.changes) > 0;
    }
    return meta?.rows_written !== undefined && Number(meta.rows_written) > 0;
}
