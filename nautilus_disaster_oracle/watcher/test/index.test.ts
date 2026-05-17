import {
    BCS_ENUMS,
    DEFAULT_ORACLE_CONTRACT,
    validateWorkerToTeeRequest,
} from "@sonari/oracle-shared";
import { describe, expect, it } from "vitest";
import type {
    RelayerPreviewAdapter,
    RelayerRequestPreview,
    RunnerAdapter,
    UsgsEarthquakeCandidate,
    WorkerEnv,
} from "../src/index.js";
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
} from "../src/index.js";
import type { EarthquakeEventRow, StateRepository } from "../src/state.js";

const baseNow = 1_800_000_000_000;

function candidate(
    source_event_id: string,
    patch: Partial<UsgsEarthquakeCandidate> = {},
): UsgsEarthquakeCandidate {
    return {
        source_event_id,
        occurred_at_ms: baseNow - 25 * HOUR_MS,
        source_updated_at_ms: baseNow - HOUR_MS,
        magnitude: 6,
        summary_mmi: null,
        alert: null,
        tsunami: false,
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

    it("stores below-threshold candidates but excludes them from runner selection", async () => {
        const repository = new InMemoryStateRepository();
        const runner = new MockRunnerAdapter();

        await scanCandidates(
            repository,
            [
                candidate("us7000small", {
                    magnitude: 5.4,
                    summary_mmi: null,
                    alert: "green",
                    tsunami: false,
                }),
            ],
            baseNow,
        );
        const summary = await processDueEvents(repository, runner, baseNow);

        expect(summary.processed).toBe(0);
        expect(runner.requests).toHaveLength(0);
        expect(await repository.get("us7000small")).toMatchObject({
            status: "ignored_small",
            error_code: "WATCHER_BELOW_AUTO_THRESHOLD",
            next_retry_at_ms: null,
        });
    });

    it("promotes ignored_small candidates to new when later scans become eligible", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(
            repository,
            [
                candidate("us7000promoted", {
                    magnitude: 5.4,
                    summary_mmi: null,
                    alert: null,
                    tsunami: false,
                }),
            ],
            baseNow,
        );
        await scanCandidates(
            repository,
            [
                candidate("us7000promoted", {
                    magnitude: 5.5,
                    summary_mmi: null,
                    alert: null,
                    tsunami: false,
                }),
            ],
            baseNow + 1_000,
        );

        expect(await repository.get("us7000promoted")).toMatchObject({
            status: "new",
            error_code: null,
            next_retry_at_ms: null,
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
        expect(row).not.toBeNull();
        expect(row?.next_retry_at_ms).toBeGreaterThan(baseNow);
        expect(row?.next_retry_at_ms).toBeLessThanOrEqual(row?.finalization_deadline_at_ms ?? 0);
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

    it("runs relayer preview once for finalized runner results", async () => {
        const repository = new InMemoryStateRepository();
        const relayerPreview = new RecordingRelayerPreviewAdapter();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        const summary = await processDueEvents(
            repository,
            new MockRunnerAdapter(),
            baseNow,
            undefined,
            relayerPreview,
        );

        expect(summary.processed).toBe(1);
        expect(relayerPreview.inputs).toHaveLength(1);
        expect(relayerPreview.inputs[0]).toMatchObject({
            status: "finalized",
            payload: { event_uid: "us7000sonari" },
        });
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            relayer_preview_status: "succeeded",
            relayer_request_json: JSON.stringify(relayerPreview.preview),
            relayer_error_code: null,
            relayer_error_message: null,
            relayer_preview_updated_at_ms: baseNow,
        });
    });

    it.each(["us7000pending-source", "us7000pending-mmi", "us7000cancelled"] as const)(
        "does not run relayer preview for non-finalized result %s",
        async (sourceEventId) => {
            const repository = new InMemoryStateRepository();
            const relayerPreview = new RecordingRelayerPreviewAdapter();

            await scanCandidates(repository, [candidate(sourceEventId)], baseNow);
            await processDueEvents(
                repository,
                new MockRunnerAdapter(),
                baseNow,
                undefined,
                relayerPreview,
            );

            expect(relayerPreview.inputs).toHaveLength(0);
            expect(await repository.get(sourceEventId)).toMatchObject({
                relayer_preview_status: null,
                relayer_request_json: null,
                relayer_error_code: null,
                relayer_error_message: null,
                relayer_preview_updated_at_ms: null,
            });
        },
    );

    it("records relayer preview failure without making finalized rows due again", async () => {
        const repository = new InMemoryStateRepository();
        const relayerPreview = new RecordingRelayerPreviewAdapter({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "preview unavailable",
        });

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processDueEvents(
            repository,
            new MockRunnerAdapter(),
            baseNow,
            undefined,
            relayerPreview,
        );

        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            retry_count: 0,
            next_retry_at_ms: null,
            error_code: null,
            relayer_preview_status: "failed",
            relayer_request_json: null,
            relayer_error_code: "RELAYER_SUBMIT_FAILED",
            relayer_error_message: "preview unavailable",
            relayer_preview_updated_at_ms: baseNow,
        });
        await expect(repository.listDue(baseNow + FAILED_RETRY_BACKOFF_MS, 10)).resolves.toEqual(
            [],
        );
    });

    it("does not overwrite finalized payload metadata during later scans", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processDueEvents(repository, new MockRunnerAdapter(), baseNow);
        await scanCandidates(
            repository,
            [
                candidate("us7000sonari", {
                    source_updated_at_ms: 1_900_000_000_000,
                }),
            ],
            baseNow + HOUR_MS,
        );

        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "finalized",
            event_uid: "us7000sonari",
            latest_revision: 3,
            source_updated_at_ms: 1_700_000_010_000,
            last_seen_at_ms: baseNow + HOUR_MS,
            updated_at_ms: baseNow + HOUR_MS,
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
        await repository.claimForProcessing(
            "us7000sonari",
            baseNow - PROCESSING_STALE_AFTER_MS - 1,
        );
        const summary = await processDueEvents(repository, new MockRunnerAdapter(), baseNow);

        expect(summary.recovered).toBe(1);
        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_TIMEOUT",
            retry_count: 1,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
        });
    });

    it("claims due rows atomically before invoking the runner", async () => {
        const repository = new InMemoryStateRepository();

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await expect(repository.claimForProcessing("us7000sonari", baseNow)).resolves.toBe(true);
        await expect(repository.claimForProcessing("us7000sonari", baseNow)).resolves.toBe(false);
    });

    it("skips runner execution when a due row was already claimed", async () => {
        const row: EarthquakeEventRow = {
            source_event_id: "us7000sonari",
            event_uid: null,
            status: "new",
            retry_count: 0,
            next_retry_at_ms: null,
            finalization_deadline_at_ms: baseNow + FINALIZATION_WINDOW_MS,
            latest_revision: 0,
            last_seen_at_ms: baseNow,
            source_updated_at_ms: baseNow,
            error_code: null,
            created_at_ms: baseNow,
            updated_at_ms: baseNow,
        };
        const repository: StateRepository = {
            upsertCandidate: async () => {},
            get: async () => row,
            listDue: async () => [row],
            claimForProcessing: async () => false,
            deferUntil: async () => {},
            markRejected: async () => {},
            markFailed: async () => {},
            applyRunnerResult: async () => {},
            recoverStaleProcessing: async () => 0,
        };
        const runner = new MockRunnerAdapter();

        const summary = await processDueEvents(repository, runner, baseNow);

        expect(summary.processed).toBe(0);
        expect(runner.requests).toHaveLength(0);
    });

    it("does not pass ignored_small rows to the runner even if listed by a repository", async () => {
        const row: EarthquakeEventRow = {
            source_event_id: "us7000small",
            event_uid: null,
            status: "ignored_small",
            retry_count: 0,
            next_retry_at_ms: null,
            finalization_deadline_at_ms: baseNow + FINALIZATION_WINDOW_MS,
            latest_revision: 0,
            last_seen_at_ms: baseNow,
            source_updated_at_ms: baseNow,
            error_code: "WATCHER_BELOW_AUTO_THRESHOLD",
            created_at_ms: baseNow,
            updated_at_ms: baseNow,
        };
        const repository: StateRepository = {
            upsertCandidate: async () => {},
            get: async () => row,
            listDue: async () => [row],
            claimForProcessing: async () => {
                throw new Error("ignored_small should not be claimed");
            },
            deferUntil: async () => {},
            markRejected: async () => {},
            markFailed: async () => {},
            applyRunnerResult: async () => {},
            recoverStaleProcessing: async () => 0,
        };
        const runner = new MockRunnerAdapter();

        const summary = await processDueEvents(repository, runner, baseNow);

        expect(summary.processed).toBe(0);
        expect(runner.requests).toHaveLength(0);
    });

    it("clamps pending runner retries to the finalization deadline", async () => {
        const repository = new InMemoryStateRepository();
        const runner: RunnerAdapter = {
            run: async (_request, context) => ({
                status: "pending_source",
                source_event_id: "us7000pending-source",
                next_retry_at_ms: context.finalizationDeadlineAtMs + HOUR_MS,
                error_code: "SHAKEMAP_PRODUCT_MISSING",
            }),
        };

        await scanCandidates(repository, [candidate("us7000pending-source")], baseNow);
        await processDueEvents(repository, runner, baseNow);

        const row = await repository.get("us7000pending-source");
        expect(row).toMatchObject({ status: "pending_source" });
        expect(row?.next_retry_at_ms).toBe(row?.finalization_deadline_at_ms);
    });

    it("fails malformed finalized payload metadata without storing finalized metadata", async () => {
        const repository = new InMemoryStateRepository();
        const runner: RunnerAdapter = {
            run: async () => ({
                status: "finalized",
                payload: {
                    event_uid: "",
                    event_revision: Number.MAX_SAFE_INTEGER + 1,
                    source_updated_at_ms: "bad",
                },
                payload_bcs_hex: "0x01",
                signature: "0xsig",
                public_key: "0xpub",
            }),
        };

        await scanCandidates(repository, [candidate("us7000sonari")], baseNow);
        await processDueEvents(repository, runner, baseNow);

        expect(await repository.get("us7000sonari")).toMatchObject({
            status: "failed",
            error_code: "BCS_SERIALIZATION_FAILED",
            event_uid: null,
            latest_revision: 0,
            source_updated_at_ms: baseNow - HOUR_MS,
            next_retry_at_ms: baseNow + FAILED_RETRY_BACKOFF_MS,
        });
    });
});

class RecordingRelayerPreviewAdapter implements RelayerPreviewAdapter {
    readonly inputs: unknown[] = [];
    readonly preview: RelayerRequestPreview = {
        target: "0x123::disaster_oracle::submit_payload_v1",
        registry: "0x456",
        arguments: ["0x456", [1], [2], [3]],
        submitRequest: {
            target: "0x123::disaster_oracle::submit_payload_v1",
            registry: "0x456",
            arguments: ["0x456", [1], [2], [3]],
        },
    };

    constructor(
        private readonly result:
            | { ok: true; value: RelayerRequestPreview }
            | { ok: false; error_code: "RELAYER_SUBMIT_FAILED" | "MOVE_REJECTED"; message: string } = {
            ok: true,
            value: {
                target: "0x123::disaster_oracle::submit_payload_v1",
                registry: "0x456",
                arguments: ["0x456", [1], [2], [3]],
                submitRequest: {
                    target: "0x123::disaster_oracle::submit_payload_v1",
                    registry: "0x456",
                    arguments: ["0x456", [1], [2], [3]],
                },
            },
        },
    ) {}

    async previewRelayerRequest(input: unknown) {
        this.inputs.push(structuredClone(input));
        return this.result;
    }
}

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

    it("accepts a valid manual earthquake and processes only that event", async () => {
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
        await expect(response.json()).resolves.toMatchObject({
            accepted: true,
            source_event_id: "us7000sonari",
            summary: {
                processed: 1,
                deferred: 0,
                recovered: 0,
                failed: 0,
                rejected: 0,
            },
            event: {
                source_event_id: "us7000sonari",
                status: "finalized",
                event_uid: "us7000sonari",
            },
        });
        expect(await repository.get("us7000sonari")).toMatchObject({
            source_event_id: "us7000sonari",
            status: "finalized",
            event_uid: "us7000sonari",
        });
    });

    it("manual submit bypasses auto-screening for an existing ignored_small candidate", async () => {
        const repository = new InMemoryStateRepository();
        const runner: RunnerAdapter = {
            run: async (request) => ({
                status: "finalized",
                payload: {
                    event_uid: request.source_event_id,
                    event_revision: 1,
                    source_updated_at_ms: baseNow - HOUR_MS,
                },
                payload_bcs_hex: "0x01",
                signature: "0xsig",
                public_key: "0xpub",
            }),
        };
        const app = createWorkerApp({ now: () => baseNow, runner });

        await scanCandidates(
            repository,
            [
                candidate("us7000manual-small", {
                    magnitude: null,
                    summary_mmi: null,
                    alert: null,
                    tsunami: false,
                }),
            ],
            baseNow - 1_000,
        );

        const response = await app.fetch(
            new Request("https://watcher.test/manual/earthquakes", {
                method: "POST",
                headers: { authorization: "Bearer secret-token" },
                body: JSON.stringify({
                    source_event_id: "us7000manual-small",
                    occurred_at_ms: baseNow - 25 * HOUR_MS,
                    source_updated_at_ms: baseNow - HOUR_MS,
                }),
            }),
            env(repository),
        );

        expect(response.status).toBe(202);
        expect(await repository.get("us7000manual-small")).toMatchObject({
            status: "finalized",
            event_uid: "us7000manual-small",
        });
    });
});

describe("health endpoint", () => {
    it("does not require the D1 binding", async () => {
        const app = createWorkerApp();
        const response = await app.fetch(
            new Request("https://watcher.test/health"),
            {} as WorkerEnv,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            ok: true,
            service: "sonari-oracle-watcher",
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
        for (const forbidden of [
            "payload",
            "signature",
            "hash",
            "affected_cells_root",
            "raw_data_hash",
            "magnitude",
            "summary_mmi",
            "alert",
            "tsunami",
        ]) {
            expect(runner.requests[0]).not.toHaveProperty(forbidden);
        }
    });
});
