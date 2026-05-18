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

export type RelayerMode = "preview" | "dry_run" | "submit";
export type RelayerStatus = "succeeded" | "failed";

export type RelayerErrorCode = Extract<OracleErrorCode, "RELAYER_SUBMIT_FAILED" | "MOVE_REJECTED">;

export interface RelayerSuccess {
    mode: RelayerMode;
    request: RelayerRequestPreview;
    digest?: string;
}

export type RelayerRunResult =
    | { ok: true; value: RelayerSuccess }
    | { ok: false; error_code: RelayerErrorCode; message: string };

export interface RelayerAdapter {
    readonly mode: RelayerMode;
    relay(input: TeeCoreResult): Promise<RelayerRunResult>;
}

export interface HttpRelayerPreviewConfig {
    sidecarUrl: string;
    target: string;
    registry: string;
    mode?: RelayerMode;
    grpcUrl?: string;
    senderAddress?: string;
}

type Fetcher = typeof fetch;

export class HttpRelayerAdapter implements RelayerAdapter {
    private readonly sidecarUrl: string;

    constructor(
        config: HttpRelayerPreviewConfig,
        private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
    ) {
        this.sidecarUrl = stripTrailingSlash(config.sidecarUrl);
        this.target = config.target;
        this.registry = config.registry;
        this.mode = config.mode ?? "preview";
        this.grpcUrl = config.grpcUrl;
        this.senderAddress = config.senderAddress;
    }

    private readonly target: string;
    private readonly registry: string;
    readonly mode: RelayerMode;
    private readonly grpcUrl: string | undefined;
    private readonly senderAddress: string | undefined;

    async relay(input: TeeCoreResult): Promise<RelayerRunResult> {
        const validation = validateRelayerSubmitInput(input);
        if (!validation.ok) {
            return {
                ok: false,
                error_code: "RELAYER_SUBMIT_FAILED",
                message: validation.message,
            };
        }

        try {
            const sidecarRequest = new Request(`${this.sidecarUrl}/relayer/${this.mode}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    input: validation.value satisfies SignedFinalizedPayload,
                    target: this.target,
                    registry: this.registry,
                    grpcUrl: this.grpcUrl,
                    senderAddress: this.senderAddress,
                }),
            });
            const response = await this.fetcher(sidecarRequest);
            const body = await readJsonResponse(response);
            if (isRelayerSidecarResult(body)) {
                if (body.ok) {
                    const request = readRelayerRequest(body.value);
                    const digest = readRelayerDigest(body.value);
                    const value: RelayerSuccess = {
                        mode: this.mode,
                        request,
                    };
                    if (digest !== undefined) {
                        value.digest = digest;
                    }
                    return {
                        ok: true,
                        value,
                    };
                }
                return body;
            }
            return relayerSubmitFailed(`Invalid relayer sidecar response: ${response.status}`);
        } catch (error) {
            return relayerSubmitFailed(errorMessage(error));
        }
    }
}

export class StaticFailingRelayerAdapter implements RelayerAdapter {
    constructor(
        readonly mode: RelayerMode,
        private readonly errorCode: RelayerErrorCode,
        private readonly message: string,
    ) {}

    async relay(_input: TeeCoreResult): Promise<RelayerRunResult> {
        return {
            ok: false,
            error_code: this.errorCode,
            message: this.message,
        };
    }
}

type RelayerSidecarResult =
    | {
          ok: true;
          value: RelayerRequestPreview | { request: RelayerRequestPreview; digest?: string };
      }
    | { ok: false; error_code: RelayerErrorCode; message: string };

function isRelayerSidecarResult(input: unknown): input is RelayerSidecarResult {
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

function relayerSubmitFailed(message: string): RelayerRunResult {
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

function readOptionalString(input: unknown): string | undefined {
    return typeof input === "string" && input.length > 0 ? input : undefined;
}

function readRelayerRequest(
    input: RelayerRequestPreview | { request: RelayerRequestPreview; digest?: string },
): RelayerRequestPreview {
    return "request" in input ? input.request : input;
}

function readRelayerDigest(
    input: RelayerRequestPreview | { request: RelayerRequestPreview; digest?: string },
): string | undefined {
    return "request" in input ? readOptionalString(input.digest) : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
