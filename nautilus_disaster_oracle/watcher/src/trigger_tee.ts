import {
    BCS_ENUMS,
    type DisasterOraclePayloadV1,
    type TeeCoreResult,
    type WorkerToTeeRequest,
} from "@sonari/oracle-shared";
import { HOUR_MS } from "./constants.js";

export interface RunnerContext {
    nowMs: number;
    finalizationDeadlineAtMs: number;
}

export interface RunnerAdapter {
    run(request: WorkerToTeeRequest, context: RunnerContext): Promise<TeeCoreResult>;
}

type Fetcher = typeof fetch;

export class HttpRunnerAdapter implements RunnerAdapter {
    private readonly sidecarUrl: string;

    constructor(
        sidecarUrl: string,
        private readonly fetcher: Fetcher = fetch,
    ) {
        this.sidecarUrl = stripTrailingSlash(sidecarUrl);
    }

    async run(request: WorkerToTeeRequest, context: RunnerContext): Promise<TeeCoreResult> {
        const sidecarRequest = new Request(`${this.sidecarUrl}/oracle/run`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ request, context }),
        });
        const response = await this.fetcher(sidecarRequest);
        const body = await readJsonResponse(response);
        if (response.ok && isRecord(body) && body.ok === true && isRecord(body.result)) {
            return body.result as unknown as TeeCoreResult;
        }

        if (isRecord(body) && typeof body.message === "string") {
            throw new Error(body.message);
        }

        throw new Error(`Oracle sidecar request failed: ${response.status}`);
    }
}

const finalizedPayload: DisasterOraclePayloadV1 = {
    intent: BCS_ENUMS.intent.SONARI_EARTHQUAKE_ORACLE,
    oracle_version: 1,
    event_uid: "us7000sonari",
    hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
    status: BCS_ENUMS.onchainStatus.FINALIZED,
    event_revision: 3,
    occurred_at_ms: 1_700_000_000_000,
    observed_at_ms: 1_700_000_010_000,
    source_updated_at_ms: 1_700_000_010_000,
    primary_source: BCS_ENUMS.primarySource.USGS,
    severity_band: 2,
    source_set_hash: `0x${"11".repeat(32)}`,
    raw_data_hash: `0x${"22".repeat(32)}`,
    raw_data_uri: "ipfs://sonari/examples/us7000sonari/raw_data_manifest.json",
    affected_cells_root: `0x${"33".repeat(32)}`,
    affected_cells_uri: "ipfs://sonari/examples/us7000sonari/affected_cells.json",
    affected_cells_data_hash: `0x${"44".repeat(32)}`,
    geo_resolution: 7,
    cells_generation_method: BCS_ENUMS.cellsGenerationMethod.SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
    cell_metric: BCS_ENUMS.cellMetric.USGS_MMI,
    cell_aggregation: BCS_ENUMS.cellAggregation.GRID_POINT_P90,
    intensity_scale: BCS_ENUMS.intensityScale.MMI_X100,
    max_cell_band: 2,
    affected_cell_count: 1,
    min_claim_band: 1,
    freshness_deadline_ms: 1_700_021_610_000,
};

export class MockRunnerAdapter implements RunnerAdapter {
    readonly requests: WorkerToTeeRequest[] = [];

    async run(request: WorkerToTeeRequest, context: RunnerContext): Promise<TeeCoreResult> {
        this.requests.push(structuredClone(request));

        switch (request.source_event_id) {
            case "us7000sonari":
                return {
                    status: "finalized",
                    payload: finalizedPayload,
                    payload_bcs_hex: "0x01",
                    signature: "0xsig",
                    public_key: "0xpub",
                };
            case "us7000pending-source":
                return {
                    status: "pending_source",
                    source_event_id: request.source_event_id,
                    next_retry_at_ms: Math.min(
                        context.nowMs + HOUR_MS,
                        context.finalizationDeadlineAtMs,
                    ),
                    error_code: "SHAKEMAP_PRODUCT_MISSING",
                };
            case "us7000pending-mmi":
                return {
                    status: "pending_mmi",
                    source_event_id: request.source_event_id,
                    next_retry_at_ms: Math.min(
                        context.nowMs + HOUR_MS,
                        context.finalizationDeadlineAtMs,
                    ),
                    error_code: "MMI_NOT_AVAILABLE",
                };
            case "us7000cancelled":
                return {
                    status: "rejected",
                    source_event_id: request.source_event_id,
                    error_code: "SHAKEMAP_CANCELLED",
                };
            case "us7000no-affected":
                return {
                    status: "rejected",
                    source_event_id: request.source_event_id,
                    error_code: "NO_AFFECTED_CELLS",
                };
            default:
                return {
                    status: "pending_source",
                    source_event_id: request.source_event_id,
                    next_retry_at_ms: Math.min(
                        context.nowMs + HOUR_MS,
                        context.finalizationDeadlineAtMs,
                    ),
                    error_code: "SHAKEMAP_PRODUCT_MISSING",
                };
        }
    }
}

async function readJsonResponse(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

function stripTrailingSlash(input: string): string {
    return input.endsWith("/") ? input.slice(0, -1) : input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
