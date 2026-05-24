import { describe, expect, it } from "vitest";
import { BCS_ENUMS, type TeeCoreResult } from "@sonari/oracle-shared";
import {
    buildDisasterVerifierRequest,
    createManualHandler,
    createScheduledHandler,
    InMemoryStateRepository,
    type WorkflowStarter,
} from "../src/index.js";
import type { UsgsEarthquakeCandidate } from "../src/usgs.js";

const baseNow = 1_800_000_000_000;
const manualAuthToken = ["manual", "test", "token"].join("-");

function candidate(
    sourceEventId: string,
    patch: Partial<UsgsEarthquakeCandidate> = {},
): UsgsEarthquakeCandidate {
    return {
        source_event_id: sourceEventId,
        occurred_at_ms: baseNow - 25 * 60 * 60 * 1000,
        source_updated_at_ms: baseNow - 60 * 60 * 1000,
        magnitude: 5.6,
        summary_mmi: null,
        alert: null,
        tsunami: false,
        ...patch,
    };
}

class RecordingWorkflowStarter implements WorkflowStarter {
    readonly starts: Array<{ sourceEventId: string; executionName: string }> = [];

    async start(input: { sourceEventId: string; executionName: string }): Promise<void> {
        this.starts.push(input);
    }
}

describe("AWS Lambda watcher handlers", () => {
    it("stores recent USGS candidates and starts workflows only for eligible due events", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createScheduledHandler({
            repository,
            workflow,
            now: () => baseNow,
            fetchCandidates: async () => [
                candidate("us7000eligible"),
                candidate("us7000small", { magnitude: 5.1 }),
            ],
        });

        const result = await handler();

        expect(result).toEqual({ scanned: 2, workflow_started: 1 });
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000eligible",
                executionName: "disaster-us7000eligible-1",
                attempt: 1,
            },
        ]);
        await expect(repository.get("us7000small")).resolves.toMatchObject({
            status: "ignored_small",
            error_code: "WATCHER_BELOW_AUTO_THRESHOLD",
        });
    });

    it("rejects manual submissions without the configured bearer token", async () => {
        const handler = createManualHandler({
            repository: new InMemoryStateRepository(),
            workflow: new RecordingWorkflowStarter(),
            now: () => baseNow,
            token: manualAuthToken,
        });

        const response = await handler({
            headers: { authorization: "Bearer wrong" },
            body: JSON.stringify({ source_event_id: "us7000manual" }),
        });

        expect(response.statusCode).toBe(401);
    });

    it("accepts manual submissions and starts a workflow immediately", async () => {
        const repository = new InMemoryStateRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createManualHandler({
            repository,
            workflow,
            now: () => baseNow,
            token: manualAuthToken,
        });

        const response = await handler({
            headers: { authorization: `Bearer ${manualAuthToken}` },
            body: JSON.stringify({ source_event_id: "us7000manual" }),
        });

        expect(response.statusCode).toBe(200);
        expect(workflow.starts).toEqual([
            {
                sourceEventId: "us7000manual",
                executionName: "disaster-us7000manual-1",
                attempt: 1,
            },
        ]);
        await expect(repository.get("us7000manual")).resolves.toMatchObject({ status: "processing" });
    });

    it("builds the minimal TEE request without trusting summary fields", () => {
        expect(buildDisasterVerifierRequest("us7000sonari")).toEqual({
            source_event_id: "us7000sonari",
            hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
            primary_source: BCS_ENUMS.primarySource.USGS,
            geo_resolution: 7,
        });
    });
});

describe("DynamoDB-compatible repository behavior", () => {
    it("updates existing events idempotently and preserves terminal finalized rows", async () => {
        const repository = new InMemoryStateRepository();

        await repository.upsertCandidate(candidate("us7000sonari"), baseNow);
        await repository.applyRunnerResult("us7000sonari", finalizedResult(), baseNow + 1_000);
        await repository.upsertCandidate(
            candidate("us7000sonari", { source_updated_at_ms: baseNow + 2_000 }),
            baseNow + 2_000,
        );

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "finalized",
            source_updated_at_ms: baseNow + 2_000,
            payload_bcs_hex: "0x01",
        });
    });
});

function finalizedResult(): TeeCoreResult {
    return {
        status: "finalized",
        payload: {
            intent: BCS_ENUMS.intent.SONARI_EARTHQUAKE_ORACLE,
            oracle_version: 1,
            event_uid: "us7000sonari",
            hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
            status: BCS_ENUMS.onchainStatus.FINALIZED,
            event_revision: 1,
            occurred_at_ms: baseNow,
            observed_at_ms: baseNow,
            source_updated_at_ms: baseNow,
            primary_source: BCS_ENUMS.primarySource.USGS,
            severity_band: 2,
            source_set_hash: `0x${"11".repeat(32)}`,
            raw_data_hash: `0x${"22".repeat(32)}`,
            raw_data_uri: "walrus://raw",
            affected_cells_root: `0x${"33".repeat(32)}`,
            affected_cells_uri: "walrus://cells",
            affected_cells_data_hash: `0x${"44".repeat(32)}`,
            geo_resolution: 7,
            cells_generation_method:
                BCS_ENUMS.cellsGenerationMethod.SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
            cell_metric: BCS_ENUMS.cellMetric.USGS_MMI,
            cell_aggregation: BCS_ENUMS.cellAggregation.GRID_POINT_P90,
            intensity_scale: BCS_ENUMS.intensityScale.MMI_X100,
            max_cell_band: 2,
            affected_cell_count: 1,
            min_claim_band: 1,
            freshness_deadline_ms: baseNow + 60_000,
        },
        payload_bcs_hex: "0x01",
        signature: "0xsig",
        public_key: "0xpub",
    };
}
