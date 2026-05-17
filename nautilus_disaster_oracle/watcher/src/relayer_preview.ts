import {
    type OracleErrorCode,
    type SignedFinalizedPayload,
    type TeeCoreResult,
    validateRelayerSubmitInput,
} from "@sonari/oracle-shared";

export interface RelayerRequestPreview {
    target: string;
    registry: string;
    arguments: [string, number[], number[], number[]];
    submitRequest: {
        target: string;
        registry: string;
        arguments: [string, number[], number[], number[]];
    };
}

export type RelayerPreviewErrorCode = Extract<
    OracleErrorCode,
    "RELAYER_SUBMIT_FAILED" | "MOVE_REJECTED"
>;

export type RelayerPreviewResult =
    | { ok: true; value: RelayerRequestPreview }
    | { ok: false; error_code: RelayerPreviewErrorCode; message: string };

export interface RelayerPreviewAdapter {
    previewRelayerRequest(input: TeeCoreResult): Promise<RelayerPreviewResult>;
}

export interface HttpRelayerPreviewConfig {
    sidecarUrl: string;
    target: string;
    registry: string;
}

type Fetcher = typeof fetch;

export class HttpRelayerPreviewAdapter implements RelayerPreviewAdapter {
    private readonly sidecarUrl: string;

    constructor(
        config: HttpRelayerPreviewConfig,
        private readonly fetcher: Fetcher = fetch,
    ) {
        this.sidecarUrl = stripTrailingSlash(config.sidecarUrl);
        this.target = config.target;
        this.registry = config.registry;
    }

    private readonly target: string;
    private readonly registry: string;

    async previewRelayerRequest(input: TeeCoreResult): Promise<RelayerPreviewResult> {
        const validation = validateRelayerSubmitInput(input);
        if (!validation.ok) {
            return {
                ok: false,
                error_code: "RELAYER_SUBMIT_FAILED",
                message: validation.message,
            };
        }

        try {
            const sidecarRequest = new Request(`${this.sidecarUrl}/relayer/preview`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    input: validation.value satisfies SignedFinalizedPayload,
                    target: this.target,
                    registry: this.registry,
                }),
            });
            const response = await this.fetcher(sidecarRequest);
            const body = await readJsonResponse(response);
            if (isRelayerPreviewResult(body)) {
                return body;
            }
            return relayerSubmitFailed(`Invalid relayer sidecar response: ${response.status}`);
        } catch (error) {
            return relayerSubmitFailed(errorMessage(error));
        }
    }
}

function isRelayerPreviewResult(input: unknown): input is RelayerPreviewResult {
    if (!isRecord(input) || typeof input.ok !== "boolean") {
        return false;
    }

    if (input.ok) {
        return isRecord(input.value);
    }

    return (
        (input.error_code === "RELAYER_SUBMIT_FAILED" || input.error_code === "MOVE_REJECTED") &&
        typeof input.message === "string"
    );
}

function relayerSubmitFailed(message: string): RelayerPreviewResult {
    return {
        ok: false,
        error_code: "RELAYER_SUBMIT_FAILED",
        message,
    };
}

async function readJsonResponse(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return {
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: `Relayer sidecar returned non-JSON response: ${response.status}`,
        };
    }
}

function stripTrailingSlash(input: string): string {
    return input.endsWith("/") ? input.slice(0, -1) : input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
