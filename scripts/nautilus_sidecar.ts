import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    buildRelayerRequestPreview,
    dryRunRelayerSubmit,
} from "../nautilus_disaster_oracle/relayer/src/index.js";
import {
    validateRelayerSubmitInput,
    validateWorkerToTeeRequest,
} from "../nautilus_disaster_oracle/shared/src/index.js";
import { LocalOracleCoreRunnerAdapter, UsgsSourceClient } from "./nautilus_local_e2e.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8789;
const DEFAULT_CASE_ID = "usgs/finalized_minimal";
const DEFAULT_FIXTURES_DIR = "nautilus_disaster_oracle/fixtures";
const MAX_BODY_BYTES = 1024 * 1024;

export interface NautilusSidecarOptions {
    host?: string;
    port?: number;
    source?: "fixture" | "usgs-live";
    caseId?: string;
    fixturesDir?: string;
}

export function createNautilusSidecarServer(options: NautilusSidecarOptions = {}): Server {
    const caseId = options.caseId ?? DEFAULT_CASE_ID;
    const fixturesDir = resolveFromCwd(options.fixturesDir ?? DEFAULT_FIXTURES_DIR);
    const source = options.source ?? "fixture";
    const runner =
        source === "usgs-live"
            ? new LocalOracleCoreRunnerAdapter({ sourceClient: new UsgsSourceClient() })
            : new LocalOracleCoreRunnerAdapter({ caseId, fixturesDir });

    return createServer(async (request, response) => {
        try {
            if (request.method !== "POST") {
                writeJson(response, 405, { ok: false, error_code: "METHOD_NOT_ALLOWED" });
                return;
            }

            if (request.url === "/process_data") {
                await handleProcessData(request, response, runner);
                return;
            }

            if (request.url === "/relayer/preview") {
                await handleRelayer(request, response, "preview");
                return;
            }

            if (request.url === "/relayer/dry_run") {
                await handleRelayer(request, response, "dry_run");
                return;
            }

            if (request.url === "/relayer/submit") {
                await handleRelayer(request, response, "submit");
                return;
            }

            writeJson(response, 404, { ok: false, error_code: "NOT_FOUND" });
        } catch (error) {
            writeJson(response, 500, {
                ok: false,
                error_code: "SIDECAR_INTERNAL_ERROR",
                message: errorMessage(error),
            });
        }
    });
}

async function handleProcessData(
    request: IncomingMessage,
    response: ServerResponse,
    runner: LocalOracleCoreRunnerAdapter,
): Promise<void> {
    const body = await readJsonBody(request);
    if (!isRecord(body) || firstUnexpectedKey(body, ["payload"]) !== undefined) {
        writeJson(response, 400, {
            ok: false,
            error_code: "INVALID_PROCESS_DATA_REQUEST",
            message: "Nautilus sidecar accepts only payload",
        });
        return;
    }

    const requestValidation = validateWorkerToTeeRequest(body.payload);
    if (!requestValidation.ok) {
        writeJson(response, 400, {
            ok: false,
            error_code: "INVALID_PROCESS_DATA_REQUEST",
            message: requestValidation.message,
        });
        return;
    }

    const result = await runner.run(requestValidation.value);
    writeJson(response, 200, { ok: true, result });
}

async function handleRelayer(
    request: IncomingMessage,
    response: ServerResponse,
    mode: "preview" | "dry_run" | "submit",
): Promise<void> {
    const body = await readJsonBody(request);
    if (
        !isRecord(body) ||
        firstUnexpectedKey(body, ["input", "target", "registry", "grpcUrl", "senderAddress"]) !==
            undefined
    ) {
        writeJson(response, 400, {
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "Relayer accepts only input, target, registry, grpcUrl, and senderAddress",
        });
        return;
    }

    const inputValidation = validateRelayerSubmitInput(body.input);
    if (!inputValidation.ok) {
        writeJson(response, 400, {
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: inputValidation.message,
        });
        return;
    }

    const config = {
        target: typeof body.target === "string" ? body.target : "",
        registry: typeof body.registry === "string" ? body.registry : "",
    };

    if (mode === "preview") {
        const result = buildRelayerRequestPreview(inputValidation.value, config);
        writeJson(response, result.ok ? 200 : 400, result);
        return;
    }

    if (mode === "dry_run") {
        const result = await dryRunRelayerSubmit(inputValidation.value, {
            ...config,
            grpcUrl: typeof body.grpcUrl === "string" ? body.grpcUrl : "",
            senderAddress: typeof body.senderAddress === "string" ? body.senderAddress : "",
        });
        writeJson(response, result.ok ? 200 : 400, result);
        return;
    }

    writeJson(response, 400, {
        ok: false,
        error_code: "RELAYER_SUBMIT_FAILED",
        message: "submit signer is not configured in the local sidecar",
    });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > MAX_BODY_BYTES) {
            throw new Error("Sidecar request body is too large");
        }
        chunks.push(buffer);
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
}

function parseCliArgs(argv: readonly string[]): Required<NautilusSidecarOptions> {
    const options: Required<NautilusSidecarOptions> = {
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        source: "fixture",
        caseId: DEFAULT_CASE_ID,
        fixturesDir: DEFAULT_FIXTURES_DIR,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];
        switch (arg) {
            case "--host":
                options.host = requireCliValue(arg, value);
                index += 1;
                break;
            case "--port":
                options.port = parsePort(requireCliValue(arg, value));
                index += 1;
                break;
            case "--case":
                options.caseId = requireCliValue(arg, value);
                index += 1;
                break;
            case "--source": {
                const source = requireCliValue(arg, value);
                if (source !== "fixture" && source !== "usgs-live") {
                    throw new Error("--source must be fixture or usgs-live");
                }
                options.source = source;
                index += 1;
                break;
            }
            case "--fixtures-dir":
                options.fixturesDir = requireCliValue(arg, value);
                index += 1;
                break;
            default:
                throw new Error(`Unknown argument: ${String(arg)}`);
        }
    }

    return options;
}

function requireCliValue(flag: string, value: string | undefined): string {
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function parsePort(value: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
        throw new Error("--port must be an integer from 1 to 65535");
    }
    return parsed;
}

function firstUnexpectedKey(
    input: Record<string, unknown>,
    allowedKeys: readonly string[],
): string | undefined {
    return Object.keys(input).find((key) => !allowedKeys.includes(key));
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function resolveFromCwd(input: string): string {
    return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
    const options = parseCliArgs(process.argv.slice(2));
    const server = createNautilusSidecarServer(options);
    await new Promise<void>((resolve) => {
        server.listen(options.port, options.host, resolve);
    });
    process.stdout.write(`Nautilus sidecar listening on http://${options.host}:${options.port}\n`);
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
    });
}
