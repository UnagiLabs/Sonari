import {
    BCS_ENUMS,
    DEFAULT_ORACLE_CONTRACT,
    validateWorkerToTeeRequest,
} from "@sonari/oracle-shared";
import { describe, expect, it } from "vitest";
import type { RunnerAdapter, UsgsEarthquakeCandidate, WorkerEnv } from "./index.js";
import {
    buildWorkerToTeeRequest,
    createWorkerApp,
    DAY_MS,
    FAILED_RETRY_BACKOFF_MS,
    FINALIZATION_WINDOW_MS,
    HOUR_MS,
    InMemoryStateRepository,
    MockRunnerAdapter,
    PROCESSING_STALE_AFTER_MS,
    processDueEvents,
    scanCandidates,
} from "./index.js";

const baseNow = 1_800_000_000_000;

function candidate(
    source_event_id: string,
    patch: Partial<UsgsEarthquakeCandidate> = {},
): UsgsEarthquakeCandidate {
    return {
        source_event_id,
        occurred_at_ms: baseNow - 25 * HOUR_MS,
        source_updated_at_ms: baseNow - HOUR_MS,
        ...patch,
    };
}

function env(repository = new InMemoryStateRepository()): WorkerEnv {
    return {
        EARTHQUAKE_EVENTS: repository,
        MANUAL_SUBMIT_TOKEN: "secret-token",
    };
}

describe("watcher state transitions", () => {
    it("deduplicates scans by source_event_id before invoking the runner", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await scanCandidates(repository, [candidate("us7000sonari")], baseNow + 1_000);
        const summary = await processDueEvents(repository, runner, baseNow);

        expect(summary.processed).toBe(1);
        expect(runner.requests).toHaveLength(1);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            retry_count: 0,
        });
    });

    it("defers earthquakes younger than 24 hours without calling the runner", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();
        const occurredAt = baseNow - 23 * HOUR_MS;

        await scanCandidates(
            repository,
            [candidate("us7000sonari", { occurred_at_ms: occurredAt })],
            baseNow,
        );
        const summary = await processDueEvents(repository, runner, baseNow);

        expect(summary.deferred).toBe(1);
        expect(runner.requests).toHaveLength(0);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "new",
            next_retry_at_ms: occurredAt + DAY_MS,
        });
    });

    it("stores pending runner results with a retry before the 72 hour deadline", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();

        await scanCandidates(repository, [candidate("us7000pending-source")], baseNow);
        await processDueEvents(repository, runner, baseNow);

        const row = await repository.get("us7000pending-source");
        expect(row).toMatchObject({
            status: "pending_source",
            error_code: "SHAKEMAP_PRODUCT_MISSING",
        });
        expect(row?.next_retry_at_ms).toBeGreaterThan(baseNow);
        expect(row?.next_retry_at_ms).toBeLessThanOrEqual(row.finalization_deadline_at_ms);
    });

    it("auto-rejects pending results once the 72 hour deadline is exceeded", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();
        const occurredAt = baseNow - FINALIZATION_WINDOW_MS - 1;

        await scanCandidates(
            repository,
            [candidate("us7000pending-mmi", { occurred_at_ms: occurredAt })],
            baseNow,
        );
        await processDueEvents(repository, runner, baseNow);

        expect(await repository.get("us7000pending-mmi")).toMatchObject({
            status: "rejected",
            error_code: "REJECTED_AUTO_TRIGGER",
            next_retry_at_ms: null,
        });
    });

    it("persists finalized payload metadata returned by the runner", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processDueEvents(repository, new MockRunnerAdapter(), baseNow);

        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            next_retry_at_ms: null,
            error_code: null,
            event_uid: "us7000sonari",
            latest_revision: 3,
            source_updated_at_ms: 1_700_000_010_000,
        });
    });

    it("persists rejected runner errors", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(repository, [candidate("us7000cancelled")], baseNow);
        await processDueEvents(repository, new MockRunnerAdapter(), baseNow);

        expect(await repository.get("us7000cancelled")).toMatchObject({
            status: "rejected",
            error_code: "SHAKEMAP_CANCELLED",
            next_retry_at_ms: null,
        });
    });

    it("maps runner timeouts to failed rows with retry backoff", async () => {
        const repository = new InMemoryStateRepository();
        const runner: RunnerAdapter = {
            run: async () => {
                throw new Error("runner timed out");
            },
        };

        await scanCandidates(repository, [candidate("us7000timeout")], baseNow);
        await processDueEvents(repository, runner, baseNow);

        expect(await repository.get("us7000timeout")).toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_TIMEOUT",
            retry_count: 1,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
        });
    });

    it("recovers stale processing rows before picking due work", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await repository.markProcessing("us7000sonari", baseNow - PROCESSING_STALE_AFTER_MS - 1);
        const summary = await processDueEvents(repository, new MockRunnerAdapter(), baseNow);

        expect(summary.recovered).toBe(1);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_TIMEOUT",
            retry_count: 1,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
        });
    });
});

describe("manual submit API", () => {
    it("returns 503 when MANUAL_SUBMIT_TOKEN is not configured", async () => {
        const app = createWorkerApp();
        const response = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                body: JSON.stringify({ source_event_id: "us7000sonari" }),
            }),
            { EARTHQUAKE_EVENTS: new InMemoryStateRepository() },
        );

        expect(response.status).toBe(503);
    });

    it("returns 401 for a mismatched bearer token", async () => {
        const app = createWorkerApp();
        const response = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                headers: { authorization: "Bearer wrong" },
                body: JSON.stringify({ source_event_id: "us7000sonari" }),
            }),
            env(),
        );

        expect(response.status).toBe(401);
    });

    it("returns 400 for invalid JSON and empty ids", async () => {
        const app = createWorkerApp();

        const invalidJson = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                headers: { authorization: "Bearer secret-token" },
                body: "{",
            }),
            env(),
        );
        const emptyId = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                headers: { authorization: "Bearer secret-token" },
                body: JSON.stringify({ source_event_id: "" }),
            }),
            env(),
        );

        expect(invalidJson.status).toBe(400);
        expect(emptyId.status).toBe(400);
    });

    it("accepts a valid manual earthquake and stores it idempotently", async () => {
        const repository = new InMemoryStateRepository();
        const app = createWorkerApp({ now: () => baseNow });
        const response = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                headers: { authorization: "Bearer secret-token" },
                body: JSON.stringify({
                    source_event_id: "us7000sonari",
                    occurred_at_ms: baseNow - 25 * HOUR_MS,
                    source_updated_at_ms: baseNow - HOUR_MS,
                }),
            }),
            env(repository),
        );

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({ accepted: true });
        expect(await repository.get("us7000sonari")).toMatchObject({
            source_event_id: "us7000sonari",
            status: "new",
            source_updated_at_ms: baseNow - HOUR_MS,
        });
    });
});

describe("runner boundary", () => {
    it("builds only the minimal validator-approved WorkerToTeeRequest", () => {
        const request = buildWorkerToTeeRequest("us7000sonari");

        expect(Object.keys(request).sort()).toEqual([
            "geo_resolution",
            "hazard_type",
            "primary_source",
            "request_type",
            "source_event_id",
        ]);
        expect(request).toEqual({
            request_type: "DETECT_BY_EVENT_ID",
            hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
            primary_source: BCS_ENUMS.primarySource.USGS,
            source_event_id: "us7000sonari",
            geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
        });
        expect(validateWorkerToTeeRequest(request)).toEqual({ ok: true, value: request });
    });

    it("passes only validator-normalized values to the runner", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processDueEvents(repository, runner, baseNow);

        expect(runner.requests).toEqual([buildWorkerToTeeRequest("us7000sonari")]);
        for (const forbidden of ["payload", "signature", "affected_cells_root", "raw_data_hash"]) {
            expect(runner.requests[0]).not.toHaveProperty(forbidden);
        }
    });
});
