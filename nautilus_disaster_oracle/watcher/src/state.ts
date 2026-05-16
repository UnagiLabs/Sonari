import type { OffchainStatus, OracleErrorCode, TeeCoreResult } from "@sonari/oracle-shared";
import { FAILED_RETRY_BACKOFF_MS, FINALIZATION_WINDOW_MS } from "./constants.js";
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
    created_at_ms: number;
    updated_at_ms: number;
}

export interface StateRepository {
    upsertCandidate(candidate: UsgsEarthquakeCandidate, nowMs: number): Promise<void>;
    get(sourceEventId: string): Promise<EarthquakeEventRow | null>;
    listDue(nowMs: number, limit: number): Promise<EarthquakeEventRow[]>;
    claimForProcessing(sourceEventId: string, nowMs: number): Promise<boolean>;
    deferUntil(sourceEventId: string, nextRetryAtMs: number, nowMs: number): Promise<void>;
    markRejected(
        sourceEventId: string,
        errorCode: Extract<OracleErrorCode, "REJECTED_AUTO_TRIGGER">,
        nowMs: number,
    ): Promise<void>;
    markFailed(
        sourceEventId: string,
        errorCode: Extract<OracleErrorCode, "AWS_RUNNER_TIMEOUT" | "BCS_SERIALIZATION_FAILED">,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<void>;
    applyRunnerResult(sourceEventId: string, result: TeeCoreResult, nowMs: number): Promise<void>;
    recoverStaleProcessing(
        staleBeforeMs: number,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<number>;
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
  created_at_ms,
  updated_at_ms
`;

export class D1StateRepository implements StateRepository {
    constructor(private readonly db: D1Database) {}

    async upsertCandidate(candidate: UsgsEarthquakeCandidate, nowMs: number): Promise<void> {
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
                ) VALUES (?, NULL, 'new', 0, NULL, ?, 0, ?, ?, NULL, ?, ?)
                ON CONFLICT(source_event_id) DO UPDATE SET
                  last_seen_at_ms = excluded.last_seen_at_ms,
                  source_updated_at_ms = CASE
                    WHEN earthquake_events.status IN ('finalized', 'submitted', 'rejected')
                      THEN earthquake_events.source_updated_at_ms
                    ELSE MAX(
                      COALESCE(earthquake_events.source_updated_at_ms, 0),
                      excluded.source_updated_at_ms
                    )
                  END,
                  updated_at_ms = excluded.updated_at_ms`,
            )
            .bind(
                candidate.source_event_id,
                candidate.occurred_at_ms + FINALIZATION_WINDOW_MS,
                nowMs,
                candidate.source_updated_at_ms,
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

    async claimForProcessing(sourceEventId: string, nowMs: number): Promise<boolean> {
        const placeholders = DUE_STATUSES.map(() => "?").join(", ");
        const result = await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET status = 'processing',
                     next_retry_at_ms = NULL,
                     error_code = NULL,
                     updated_at_ms = ?
                 WHERE source_event_id = ?
                   AND status IN (${placeholders})
                   AND (next_retry_at_ms IS NULL OR next_retry_at_ms <= ?)`,
            )
            .bind(nowMs, sourceEventId, ...DUE_STATUSES, nowMs)
            .run();
        return d1RowsChanged(result);
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
        errorCode: Extract<OracleErrorCode, "AWS_RUNNER_TIMEOUT" | "BCS_SERIALIZATION_FAILED">,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<void> {
        await this.db
            .prepare(
                `UPDATE earthquake_events
                 SET status = 'failed',
                     retry_count = retry_count + 1,
                     next_retry_at_ms = ?,
                     error_code = ?,
                     updated_at_ms = ?
                 WHERE source_event_id = ?`,
            )
            .bind(nextRetryAtMs, errorCode, nowMs, sourceEventId)
            .run();
    }

    async applyRunnerResult(
        sourceEventId: string,
        result: TeeCoreResult,
        nowMs: number,
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
                         updated_at_ms = ?
                     WHERE source_event_id = ?`,
                )
                .bind(
                    payload.event_uid,
                    payload.event_revision,
                    payload.source_updated_at_ms,
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
            .bind(result.status, result.next_retry_at_ms, result.error_code, nowMs, sourceEventId)
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
}

export class InMemoryStateRepository implements StateRepository {
    private readonly rows = new Map<string, EarthquakeEventRow>();

    async upsertCandidate(candidate: UsgsEarthquakeCandidate, nowMs: number): Promise<void> {
        const existing = this.rows.get(candidate.source_event_id);
        if (existing === undefined) {
            this.rows.set(candidate.source_event_id, {
                source_event_id: candidate.source_event_id,
                event_uid: null,
                status: "new",
                retry_count: 0,
                next_retry_at_ms: null,
                finalization_deadline_at_ms: candidate.occurred_at_ms + FINALIZATION_WINDOW_MS,
                latest_revision: 0,
                last_seen_at_ms: nowMs,
                source_updated_at_ms: candidate.source_updated_at_ms,
                error_code: null,
                created_at_ms: nowMs,
                updated_at_ms: nowMs,
            });
            return;
        }

        this.rows.set(candidate.source_event_id, {
            ...existing,
            last_seen_at_ms: nowMs,
            source_updated_at_ms: TERMINAL_STATUSES.has(existing.status)
                ? existing.source_updated_at_ms
                : Math.max(existing.source_updated_at_ms ?? 0, candidate.source_updated_at_ms),
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

    async claimForProcessing(sourceEventId: string, nowMs: number): Promise<boolean> {
        const row = this.require(sourceEventId);
        if (
            !DUE_STATUSES.includes(row.status) ||
            (row.next_retry_at_ms !== null && row.next_retry_at_ms > nowMs)
        ) {
            return false;
        }

        this.patch(sourceEventId, {
            status: "processing",
            next_retry_at_ms: null,
            error_code: null,
            updated_at_ms: nowMs,
        });
        return true;
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
        errorCode: Extract<OracleErrorCode, "AWS_RUNNER_TIMEOUT" | "BCS_SERIALIZATION_FAILED">,
        nowMs: number,
        nextRetryAtMs: number,
    ): Promise<void> {
        const row = this.require(sourceEventId);
        this.patch(sourceEventId, {
            status: "failed",
            retry_count: row.retry_count + 1,
            next_retry_at_ms: nextRetryAtMs,
            error_code: errorCode,
            updated_at_ms: nowMs,
        });
    }

    async applyRunnerResult(
        sourceEventId: string,
        result: TeeCoreResult,
        nowMs: number,
    ): Promise<void> {
        if (result.status === "finalized") {
            this.patch(sourceEventId, {
                status: "finalized",
                next_retry_at_ms: null,
                error_code: null,
                event_uid: String(result.payload.event_uid),
                latest_revision: Number(result.payload.event_revision),
                source_updated_at_ms: Number(result.payload.source_updated_at_ms),
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
            next_retry_at_ms: result.next_retry_at_ms,
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

    private patch(sourceEventId: string, patch: Partial<EarthquakeEventRow>): void {
        const row = this.require(sourceEventId);
        if (TERMINAL_STATUSES.has(row.status) && patch.status !== undefined) {
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
