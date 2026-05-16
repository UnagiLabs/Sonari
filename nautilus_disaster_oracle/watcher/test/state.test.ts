import { describe, expect, it } from "vitest";
import { FINALIZATION_WINDOW_MS } from "../src/constants.js";
import { D1StateRepository, type EarthquakeEventRow } from "../src/state.js";
import type { UsgsEarthquakeCandidate } from "../src/usgs.js";

const baseNow = 1_800_000_000_000;

function candidate(
    source_event_id: string,
    patch: Partial<UsgsEarthquakeCandidate> = {},
): UsgsEarthquakeCandidate {
    return {
        source_event_id,
        occurred_at_ms: baseNow - 25 * 60 * 60 * 1_000,
        source_updated_at_ms: baseNow - 60 * 60 * 1_000,
        ...patch,
    };
}

function row(patch: Partial<EarthquakeEventRow> = {}): EarthquakeEventRow {
    return {
        source_event_id: "us7000sonari",
        event_uid: null,
        status: "new",
        retry_count: 0,
        next_retry_at_ms: null,
        finalization_deadline_at_ms: baseNow + FINALIZATION_WINDOW_MS,
        latest_revision: 0,
        last_seen_at_ms: baseNow - 1_000,
        source_updated_at_ms: baseNow - 2_000,
        error_code: null,
        created_at_ms: baseNow - 1_000,
        updated_at_ms: baseNow - 1_000,
        ...patch,
    };
}

describe("D1StateRepository", () => {
    it("upserts new candidates with one atomic insert statement and no pre-read", async () => {
        const db = new FakeD1Database();
        const repository = new D1StateRepository(db.binding);

        await repository.upsertCandidate(candidate("us7000sonari"), baseNow);

        expect(db.statements).toHaveLength(1);
        expect(normalizeSql(db.statements[0])).toContain(
            "INSERT INTO earthquake_events ( source_event_id",
        );
        expect(normalizeSql(db.statements[0])).toContain("ON CONFLICT(source_event_id) DO UPDATE");
        expect(normalizeSql(db.statements[0])).not.toContain("SELECT");
        expect(db.rows.get("us7000sonari")).toMatchObject({
            source_event_id: "us7000sonari",
            status: "new",
            retry_count: 0,
            last_seen_at_ms: baseNow,
            source_updated_at_ms: baseNow - 60 * 60 * 1_000,
            created_at_ms: baseNow,
            updated_at_ms: baseNow,
        });
    });

    it("keeps the maximum source update time when rescanning non-terminal rows", async () => {
        const db = new FakeD1Database([
            row({
                source_event_id: "us7000sonari",
                status: "pending_mmi",
                source_updated_at_ms: baseNow - 10_000,
                latest_revision: 2,
                event_uid: "pending-uid",
            }),
        ]);
        const repository = new D1StateRepository(db.binding);

        await repository.upsertCandidate(
            candidate("us7000sonari", { source_updated_at_ms: baseNow + 5_000 }),
            baseNow + 10_000,
        );

        expect(db.rows.get("us7000sonari")).toMatchObject({
            status: "pending_mmi",
            event_uid: "pending-uid",
            latest_revision: 2,
            last_seen_at_ms: baseNow + 10_000,
            source_updated_at_ms: baseNow + 5_000,
            updated_at_ms: baseNow + 10_000,
        });
    });

    it("protects finalized metadata when rescanning terminal rows", async () => {
        const db = new FakeD1Database([
            row({
                source_event_id: "us7000sonari",
                status: "finalized",
                event_uid: "finalized-uid",
                latest_revision: 7,
                source_updated_at_ms: baseNow - 10_000,
            }),
        ]);
        const repository = new D1StateRepository(db.binding);

        await repository.upsertCandidate(
            candidate("us7000sonari", { source_updated_at_ms: baseNow + 5_000 }),
            baseNow + 10_000,
        );

        expect(db.rows.get("us7000sonari")).toMatchObject({
            status: "finalized",
            event_uid: "finalized-uid",
            latest_revision: 7,
            last_seen_at_ms: baseNow + 10_000,
            source_updated_at_ms: baseNow - 10_000,
            updated_at_ms: baseNow + 10_000,
        });
    });
});

class FakeD1Database {
    readonly statements: string[] = [];
    readonly rows = new Map<string, EarthquakeEventRow>();

    constructor(rows: EarthquakeEventRow[] = []) {
        for (const row of rows) {
            this.rows.set(row.source_event_id, { ...row });
        }
    }

    get binding(): D1Database {
        return {
            prepare: (sql: string) => {
                this.statements.push(sql);
                return new FakeD1PreparedStatement(this, sql) as unknown as D1PreparedStatement;
            },
        } as D1Database;
    }
}

class FakeD1PreparedStatement {
    constructor(
        private readonly db: FakeD1Database,
        private readonly sql: string,
        private readonly bindings: unknown[] = [],
    ) {}

    bind(...bindings: unknown[]): D1PreparedStatement {
        return new FakeD1PreparedStatement(
            this.db,
            this.sql,
            bindings,
        ) as unknown as D1PreparedStatement;
    }

    async first<T>(): Promise<T | null> {
        const sourceEventId = String(this.bindings[0]);
        const row = this.db.rows.get(sourceEventId);
        return row === undefined ? null : ({ ...row } as T);
    }

    async all<T>(): Promise<D1Result<T>> {
        return { results: [], success: true, meta: {} } as unknown as D1Result<T>;
    }

    async run(): Promise<D1Result> {
        const normalizedSql = normalizeSql(this.sql);
        if (normalizedSql.startsWith("INSERT INTO earthquake_events")) {
            this.runUpsert();
            return changed();
        }
        if (
            normalizedSql.startsWith(
                "UPDATE earthquake_events SET last_seen_at_ms = ?, updated_at_ms = ?",
            )
        ) {
            const [lastSeenAtMs, updatedAtMs, sourceEventId] = this.bindings;
            this.patch(String(sourceEventId), {
                last_seen_at_ms: Number(lastSeenAtMs),
                updated_at_ms: Number(updatedAtMs),
            });
            return changed();
        }
        if (
            normalizedSql.startsWith(
                "UPDATE earthquake_events SET last_seen_at_ms = ?, source_updated_at_ms = ?, updated_at_ms = ?",
            )
        ) {
            const [lastSeenAtMs, sourceUpdatedAtMs, updatedAtMs, sourceEventId] = this.bindings;
            this.patch(String(sourceEventId), {
                last_seen_at_ms: Number(lastSeenAtMs),
                source_updated_at_ms: Number(sourceUpdatedAtMs),
                updated_at_ms: Number(updatedAtMs),
            });
            return changed();
        }
        throw new Error(`Unsupported fake D1 statement: ${normalizedSql}`);
    }

    private runUpsert(): void {
        const [
            sourceEventId,
            finalizationDeadlineAtMs,
            lastSeenAtMs,
            sourceUpdatedAtMs,
            createdAtMs,
            updatedAtMs,
        ] = this.bindings;
        const id = String(sourceEventId);
        const existing = this.db.rows.get(id);
        if (existing === undefined) {
            this.db.rows.set(id, {
                source_event_id: id,
                event_uid: null,
                status: "new",
                retry_count: 0,
                next_retry_at_ms: null,
                finalization_deadline_at_ms: Number(finalizationDeadlineAtMs),
                latest_revision: 0,
                last_seen_at_ms: Number(lastSeenAtMs),
                source_updated_at_ms: Number(sourceUpdatedAtMs),
                error_code: null,
                created_at_ms: Number(createdAtMs),
                updated_at_ms: Number(updatedAtMs),
            });
            return;
        }

        const nextSourceUpdatedAtMs =
            existing.status === "finalized" ||
            existing.status === "submitted" ||
            existing.status === "rejected"
                ? existing.source_updated_at_ms
                : Math.max(existing.source_updated_at_ms ?? 0, Number(sourceUpdatedAtMs));
        this.db.rows.set(id, {
            ...existing,
            last_seen_at_ms: Number(lastSeenAtMs),
            source_updated_at_ms: nextSourceUpdatedAtMs,
            updated_at_ms: Number(updatedAtMs),
        });
    }

    private patch(sourceEventId: string, patch: Partial<EarthquakeEventRow>): void {
        const row = this.db.rows.get(sourceEventId);
        if (row === undefined) {
            throw new Error(`Unknown fake D1 row: ${sourceEventId}`);
        }
        this.db.rows.set(sourceEventId, { ...row, ...patch });
    }
}

function normalizeSql(sql: string | undefined): string {
    return (sql ?? "").replace(/\s+/g, " ").trim();
}

function changed(): D1Result {
    return { meta: { changes: 1, rows_written: 1 } } as D1Result;
}
