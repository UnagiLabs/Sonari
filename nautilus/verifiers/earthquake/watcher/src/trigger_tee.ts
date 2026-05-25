import {
    BCS_ENUMS,
    type DisasterOraclePayloadV1,
    type DisasterVerifierRequest,
    ERROR_CODES,
    type OracleErrorCode,
    type TeeCoreResult,
} from "@sonari/oracle-shared";

export interface RunnerAdapter {
    run(request: DisasterVerifierRequest): Promise<TeeCoreResult>;
}

export interface RunnerLifecycleAdapter {
    start(): Promise<{ runner_id: string }>;
    process(
        runnerId: string,
        request: DisasterVerifierRequest,
        signal?: AbortSignal,
    ): Promise<TeeCoreResult>;
    stop(runnerId: string): Promise<void>;
}

export class RunnerProcessError extends Error {
    constructor(
        message: string,
        readonly errorCode: OracleErrorCode = "AWS_RUNNER_PROCESS_FAILED",
    ) {
        super(message);
        this.name = "RunnerProcessError";
    }
}

export class RunnerStartError extends Error {
    readonly errorCode = "AWS_RUNNER_START_FAILED" satisfies OracleErrorCode;

    constructor(message: string) {
        super(message);
        this.name = "RunnerStartError";
    }
}

export class RunnerContractError extends Error {
    readonly errorCode = "AWS_RUNNER_CONTRACT_INVALID" satisfies OracleErrorCode;

    constructor(message: string) {
        super(message);
        this.name = "RunnerContractError";
    }
}

type Fetcher = typeof fetch;

export class HttpRunnerAdapter implements RunnerAdapter {
    private readonly sidecarUrl: string;

    constructor(
        sidecarUrl: string,
        private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
    ) {
        this.sidecarUrl = stripTrailingSlash(sidecarUrl);
    }

    async run(request: DisasterVerifierRequest): Promise<TeeCoreResult> {
        const sidecarRequest = new Request(`${this.sidecarUrl}/process_data`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payload: request }),
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

export interface AwsRunnerLifecycleAdapterOptions {
    baseUrl: string;
    token: string;
    fetcher?: Fetcher;
}

export class AwsRunnerLifecycleAdapter implements RunnerLifecycleAdapter {
    private readonly baseUrl: string;
    private readonly fetcher: Fetcher;
    private readonly token: string;

    constructor(options: AwsRunnerLifecycleAdapterOptions) {
        this.baseUrl = stripTrailingSlash(options.baseUrl);
        this.token = options.token;
        this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    }

    async start(): Promise<{ runner_id: string }> {
        const body = await this.postJson("/start", {});
        if (isRecord(body) && body.ok === true && typeof body.runner_id === "string") {
            return { runner_id: body.runner_id };
        }
        if (isRecord(body) && body.ok === false && typeof body.message === "string") {
            throw new RunnerStartError(body.message);
        }
        throw new RunnerContractError(
            "AWS runner start response did not match the runner contract",
        );
    }

    async process(
        runnerId: string,
        request: DisasterVerifierRequest,
        signal?: AbortSignal,
    ): Promise<TeeCoreResult> {
        const body = await this.postJson("/process", { payload: request }, signal, runnerId);
        if (isRecord(body) && body.ok === true && isRecord(body.result)) {
            return body.result as unknown as TeeCoreResult;
        }

        if (isRecord(body) && body.ok === false) {
            const errorCode =
                typeof body.error_code === "string" && isOracleErrorCode(body.error_code)
                    ? body.error_code
                    : "AWS_RUNNER_PROCESS_FAILED";
            throw new RunnerProcessError(
                typeof body.message === "string" ? body.message : "AWS runner process failed",
                errorCode,
            );
        }

        throw new RunnerContractError(
            "AWS runner process response did not match the runner contract",
        );
    }

    async stop(runnerId: string): Promise<void> {
        const body = await this.postJson("/stop", { runner_id: runnerId });
        if (isRecord(body) && body.ok === true) {
            return;
        }
        if (isRecord(body) && body.ok === false && typeof body.message === "string") {
            throw new Error(body.message);
        }
        throw new Error(
            "AWS_RUNNER_STOP_FAILED: AWS runner stop response did not match the runner contract",
        );
    }

    private async postJson(
        pathname: "/start" | "/process" | "/stop",
        body: unknown,
        signal?: AbortSignal,
        runnerId?: string,
    ): Promise<unknown> {
        const headers = new Headers({
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
        });
        if (runnerId !== undefined) {
            headers.set("x-runner-id", runnerId);
        }
        const init: RequestInit = {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        };
        if (signal !== undefined) {
            init.signal = signal;
        }
        const response = await this.fetcher(new Request(`${this.baseUrl}${pathname}`, init));
        const json = await readJsonResponse(response);
        if (response.ok) {
            return json;
        }
        if (isRecord(json) && json.ok === false) {
            return json;
        }
        if (isRecord(json) && typeof json.message === "string") {
            throw new Error(json.message);
        }
        throw new Error(`AWS runner request failed: ${response.status}`);
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
    readonly requests: DisasterVerifierRequest[] = [];

    async run(request: DisasterVerifierRequest): Promise<TeeCoreResult> {
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
                    error_code: "SHAKEMAP_PRODUCT_MISSING",
                };
            case "us7000pending-mmi":
                return {
                    status: "pending_mmi",
                    source_event_id: request.source_event_id,
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
                    error_code: "SHAKEMAP_PRODUCT_MISSING",
                };
        }
    }
}

export class MockRunnerLifecycleAdapter implements RunnerLifecycleAdapter {
    private nextRunnerId = 1;
    readonly starts: string[] = [];
    readonly requests: DisasterVerifierRequest[] = [];
    readonly stops: string[] = [];

    constructor(private readonly runner = new MockRunnerAdapter()) {}

    async start(): Promise<{ runner_id: string }> {
        const runnerId = `mock-runner-${this.nextRunnerId}`;
        this.nextRunnerId += 1;
        this.starts.push(runnerId);
        return { runner_id: runnerId };
    }

    async process(
        _runnerId: string,
        request: DisasterVerifierRequest,
        _signal?: AbortSignal,
    ): Promise<TeeCoreResult> {
        this.requests.push(structuredClone(request));
        return this.runner.run(request);
    }

    async stop(runnerId: string): Promise<void> {
        this.stops.push(runnerId);
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

function isOracleErrorCode(input: string): input is OracleErrorCode {
    return (ERROR_CODES as readonly string[]).includes(input);
}
