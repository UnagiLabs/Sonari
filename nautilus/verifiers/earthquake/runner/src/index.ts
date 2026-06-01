import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    buildRelayerRequestPreview,
    dryRunRelayerSubmit,
} from "@sonari/earthquake-relayer";
import {
    EARTHQUAKE_VERIFIER_CONFIG_KEY,
    type EnclaveVerificationMetadata,
    type OracleErrorCode,
    type TeeCoreResult,
    validateRelayerSubmitInput,
    validateWorkerToTeeRequest,
    type WorkerToTeeRequest,
} from "@sonari/earthquake-shared";

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const ABORT_KILL_GRACE_MS = 250;

export interface RunnerServiceOptions {
    token: string;
    tee: TeeProcessAdapter;
    bodyLimitBytes?: number;
}

export interface TeeProcessAdapter {
    healthCheck?(signal?: AbortSignal): Promise<EnclaveHealthCheckResult>;
    getAttestation?(signal?: AbortSignal): Promise<EnclaveAttestationResult>;
    process(
        request: WorkerToTeeRequest,
        signal?: AbortSignal,
        registrationMetadata?: EnclaveVerificationMetadata,
    ): Promise<TeeCoreResult>;
}

export interface EnclaveHealthCheckResult {
    status: "healthy";
    external_sources_reachable: boolean;
}

export interface EnclaveAttestationResult {
    attestation_document_hex: string;
    public_key: string;
}

export function createRunnerServer(options: RunnerServiceOptions): Server {
    const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
    const sessions = new Map<string, RunnerSession>();
    return createServer(async (request, response) => {
        try {
            if (!isAuthorized(request, options.token)) {
                writeJson(response, 401, {
                    ok: false,
                    error_code: "AWS_RUNNER_PROCESS_FAILED",
                    message: "unauthorized",
                });
                return;
            }

            if (request.method === "GET" && request.url === "/health") {
                writeJson(response, 200, { ok: true, service: "sonari-earthquake-runner" });
                return;
            }

            if (request.method === "GET" && request.url === "/health_check") {
                const result = await runHealthCheck(options.tee);
                writeJson(response, 200, { ok: true, result });
                return;
            }

            if (request.method !== "POST") {
                writeJson(response, 405, {
                    ok: false,
                    error_code: "AWS_RUNNER_PROCESS_FAILED",
                    message: "method not allowed",
                });
                return;
            }

            if (request.url === "/start") {
                const runnerId = `runner-${randomUUID()}`;
                sessions.set(runnerId, {});
                writeJson(response, 200, { ok: true, runner_id: runnerId });
                return;
            }

            if (request.url === "/stop") {
                await handleStop(request, response, sessions, bodyLimitBytes);
                return;
            }

            if (request.url === "/process") {
                await handleProcess(request, response, options.tee, sessions, bodyLimitBytes, {
                    requireRegistrationMetadata: false,
                });
                return;
            }

            if (request.url === "/get_attestation") {
                await handleGetAttestation(request, response, options.tee, sessions);
                return;
            }

            if (request.url === "/process_data") {
                await handleProcess(request, response, options.tee, sessions, bodyLimitBytes, {
                    requireRegistrationMetadata: true,
                });
                return;
            }

            if (request.url === "/relayer/preview") {
                await handleRelayer(request, response, "preview", bodyLimitBytes);
                return;
            }

            if (request.url === "/relayer/dry_run") {
                await handleRelayer(request, response, "dry_run", bodyLimitBytes);
                return;
            }

            writeJson(response, 404, {
                ok: false,
                error_code: "AWS_RUNNER_PROCESS_FAILED",
                message: "not found",
            });
        } catch (error) {
            writeJson(response, 500, errorResponse(error));
        }
    });
}

interface RunnerSession {
    activeProcess?: AbortController;
}

async function handleProcess(
    request: IncomingMessage,
    response: ServerResponse,
    tee: TeeProcessAdapter,
    sessions: Map<string, RunnerSession>,
    bodyLimitBytes: number,
    options: { requireRegistrationMetadata: boolean },
): Promise<void> {
    const sessionResult = readRunnerSession(request, response, sessions, "process");
    if (sessionResult === undefined) {
        return;
    }
    const { session } = sessionResult;

    if (session.activeProcess !== undefined) {
        writeJson(response, 409, {
            ok: false,
            error_code: "AWS_RUNNER_PROCESS_FAILED",
            message: "runner already has an active process",
        });
        return;
    }

    const body = await readJsonBody(request, bodyLimitBytes);
    const allowedKeys = options.requireRegistrationMetadata
        ? ["payload", "registration_metadata"]
        : ["payload"];
    if (!isRecord(body) || firstUnexpectedKey(body, allowedKeys) !== undefined) {
        writeJson(response, 400, {
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
            message: options.requireRegistrationMetadata
                ? "process_data accepts only payload and registration_metadata"
                : "process accepts only payload",
        });
        return;
    }

    const validation = validateWorkerToTeeRequest(body.payload);
    if (!validation.ok) {
        writeJson(response, 400, {
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
            message: validation.message,
        });
        return;
    }

    const registrationMetadata = options.requireRegistrationMetadata
        ? readRegistrationMetadata(body.registration_metadata)
        : undefined;
    if (options.requireRegistrationMetadata && registrationMetadata === undefined) {
        writeJson(response, 400, {
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
            message: "process_data requires registration metadata",
        });
        return;
    }

    if (sessions.get(sessionResult.runnerId) !== session) {
        writeJson(response, 404, {
            ok: false,
            error_code: "AWS_RUNNER_PROCESS_FAILED",
            message: "unknown runner_id",
        });
        return;
    }

    const abortController = new AbortController();
    session.activeProcess = abortController;
    try {
        const result = await tee.process(
            validation.value,
            abortController.signal,
            registrationMetadata,
        );
        writeJson(response, 200, {
            ok: true,
            result:
                registrationMetadata === undefined
                    ? result
                    : attachRegistrationMetadata(result, registrationMetadata),
        });
    } finally {
        if (session.activeProcess === abortController) {
            delete session.activeProcess;
        }
    }
}

async function handleGetAttestation(
    request: IncomingMessage,
    response: ServerResponse,
    tee: TeeProcessAdapter,
    sessions: Map<string, RunnerSession>,
): Promise<void> {
    const sessionResult = readRunnerSession(request, response, sessions, "get_attestation");
    if (sessionResult === undefined) {
        return;
    }
    const result =
        tee.getAttestation === undefined
            ? undefined
            : await tee.getAttestation(sessionResult.session.activeProcess?.signal);
    if (result === undefined) {
        throw new RunnerServiceError(
            "AWS_RUNNER_PROCESS_FAILED",
            "get_attestation is not configured",
        );
    }
    writeJson(response, 200, { ok: true, result });
}

function readRunnerSession(
    request: IncomingMessage,
    response: ServerResponse,
    sessions: Map<string, RunnerSession>,
    operation: string,
): { runnerId: string; session: RunnerSession } | undefined {
    const runnerId = singleHeaderValue(request.headers["x-runner-id"]);
    if (runnerId === undefined || runnerId.length === 0) {
        writeJson(response, 400, {
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
            message: `${operation} requires x-runner-id`,
        });
        return undefined;
    }

    const session = sessions.get(runnerId);
    if (session === undefined) {
        writeJson(response, 404, {
            ok: false,
            error_code: "AWS_RUNNER_PROCESS_FAILED",
            message: "unknown runner_id",
        });
        return undefined;
    }
    return { runnerId, session };
}

async function handleStop(
    request: IncomingMessage,
    response: ServerResponse,
    sessions: Map<string, RunnerSession>,
    bodyLimitBytes: number,
): Promise<void> {
    const body = await readJsonBody(request, bodyLimitBytes);
    if (
        !isRecord(body) ||
        firstUnexpectedKey(body, ["runner_id"]) !== undefined ||
        typeof body.runner_id !== "string" ||
        body.runner_id.length === 0
    ) {
        writeJson(response, 400, {
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
            message: "stop accepts only runner_id",
        });
        return;
    }

    const session = sessions.get(body.runner_id);
    if (session === undefined) {
        writeJson(response, 404, {
            ok: false,
            error_code: "AWS_RUNNER_PROCESS_FAILED",
            message: "unknown runner_id",
        });
        return;
    }

    session.activeProcess?.abort();
    sessions.delete(body.runner_id);
    writeJson(response, 200, { ok: true });
}

async function handleRelayer(
    request: IncomingMessage,
    response: ServerResponse,
    mode: "preview" | "dry_run",
    bodyLimitBytes: number,
): Promise<void> {
    const body = await readJsonBody(request, bodyLimitBytes);
    if (
        !isRecord(body) ||
        firstUnexpectedKey(body, [
            "input",
            "target",
            "registry",
            "verifierRegistry",
            "network",
            "grpcUrl",
            "senderAddress",
        ]) !== undefined
    ) {
        writeJson(response, 400, {
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "invalid relayer request",
        });
        return;
    }

    const input = validateRelayerSubmitInput(body.input);
    if (!input.ok) {
        writeJson(response, 400, {
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: input.message,
        });
        return;
    }

    const config = {
        target: typeof body.target === "string" ? body.target : "",
        registry: typeof body.registry === "string" ? body.registry : "",
        verifierRegistry: typeof body.verifierRegistry === "string" ? body.verifierRegistry : "",
    };
    const result =
        mode === "preview"
            ? buildRelayerRequestPreview(input.value, config)
            : await dryRunRelayerSubmit(input.value, {
                  ...config,
                  network: readSuiNetwork(body.network) ?? "testnet",
                  grpcUrl: typeof body.grpcUrl === "string" ? body.grpcUrl : "",
                  senderAddress: typeof body.senderAddress === "string" ? body.senderAddress : "",
              });

    writeJson(response, result.ok ? 200 : 400, result);
}

export interface RustCliTeeAdapterOptions {
    cargoManifestPath: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

export class RustCliTeeAdapter implements TeeProcessAdapter {
    constructor(private readonly options: RustCliTeeAdapterOptions) {}

    async healthCheck(_signal?: AbortSignal): Promise<EnclaveHealthCheckResult> {
        return { status: "healthy", external_sources_reachable: true };
    }

    async getAttestation(_signal?: AbortSignal): Promise<EnclaveAttestationResult> {
        throw new RunnerServiceError(
            "AWS_RUNNER_PROCESS_FAILED",
            "Rust CLI get_attestation is available only through a Nautilus/Nitro backend",
        );
    }

    async process(request: WorkerToTeeRequest, signal?: AbortSignal): Promise<TeeCoreResult> {
        const dir = await mkdtemp(path.join(tmpdir(), "sonari-runner-"));
        const inputPath = path.join(dir, "worker_request.json");
        try {
            await writeFile(inputPath, JSON.stringify(request));
            const options: Parameters<typeof execWithStdin>[2] = {
                stdin: "",
                maxBuffer: 10 * 1024 * 1024,
            };
            if (this.options.cwd !== undefined) {
                options.cwd = this.options.cwd;
            }
            if (this.options.env !== undefined) {
                options.env = this.options.env;
            }
            if (signal !== undefined) {
                options.signal = signal;
            }
            const stdout = await execWithStdin(
                "cargo",
                [
                    "run",
                    "--quiet",
                    "--manifest-path",
                    this.options.cargoManifestPath,
                    "--",
                    "production",
                    "--input",
                    inputPath,
                ],
                options,
            );
            return JSON.parse(stdout) as TeeCoreResult;
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
}

export interface EnclaveCommandTeeAdapterOptions {
    command: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

export class EnclaveCommandTeeAdapter implements TeeProcessAdapter {
    constructor(private readonly options: EnclaveCommandTeeAdapterOptions) {}

    async healthCheck(signal?: AbortSignal): Promise<EnclaveHealthCheckResult> {
        return this.runJsonCommand({ action: "health_check" }, signal) as Promise<EnclaveHealthCheckResult>;
    }

    async getAttestation(signal?: AbortSignal): Promise<EnclaveAttestationResult> {
        return this.runJsonCommand(
            { action: "get_attestation" },
            signal,
        ) as Promise<EnclaveAttestationResult>;
    }

    async process(
        request: WorkerToTeeRequest,
        signal?: AbortSignal,
        registrationMetadata?: EnclaveVerificationMetadata,
    ): Promise<TeeCoreResult> {
        const input =
            registrationMetadata === undefined
                ? request
                : {
                      action: "process_data",
                      payload: request,
                      registration_metadata: registrationMetadata,
                  };
        return this.runJsonCommand(input, signal) as Promise<TeeCoreResult>;
    }

    private async runJsonCommand(input: unknown, signal?: AbortSignal): Promise<unknown> {
        const options: Parameters<typeof execWithStdin>[2] = {
            maxBuffer: 10 * 1024 * 1024,
            stdin: JSON.stringify(input),
        };
        if (signal !== undefined) {
            options.signal = signal;
        }
        if (this.options.cwd !== undefined) {
            options.cwd = this.options.cwd;
        }
        if (this.options.env !== undefined) {
            options.env = this.options.env;
        }
        const stdout = await execWithStdin(this.options.command, this.options.args ?? [], options);
        return JSON.parse(stdout) as unknown;
    }
}

async function runHealthCheck(tee: TeeProcessAdapter): Promise<EnclaveHealthCheckResult> {
    if (tee.healthCheck === undefined) {
        return { status: "healthy", external_sources_reachable: true };
    }
    return tee.healthCheck();
}

function attachRegistrationMetadata(
    result: TeeCoreResult,
    metadata: EnclaveVerificationMetadata,
): TeeCoreResult {
    if (result.status !== "finalized") {
        return result;
    }
    if (normalizeHex(result.public_key) !== normalizeHex(metadata.enclave_instance_public_key)) {
        throw new RunnerServiceError(
            "AWS_RUNNER_PROCESS_FAILED",
            "registration public key does not match finalized result public_key",
        );
    }
    const existingConfigKey = result.verifier_config_key;
    const existingConfigVersion = result.verifier_config_version;
    const existingInstancePublicKey = result.enclave_instance_public_key;
    if (
        (existingConfigKey !== undefined && existingConfigKey !== metadata.verifier_config_key) ||
        (existingConfigVersion !== undefined &&
            existingConfigVersion !== metadata.verifier_config_version) ||
        (existingInstancePublicKey !== undefined &&
            normalizeHex(existingInstancePublicKey) !==
                normalizeHex(metadata.enclave_instance_public_key))
    ) {
        throw new RunnerServiceError(
            "AWS_RUNNER_PROCESS_FAILED",
            "finalized result enclave metadata does not match registration metadata",
        );
    }
    return { ...result, ...metadata };
}

function readRegistrationMetadata(input: unknown): EnclaveVerificationMetadata | undefined {
    if (!isRecord(input)) {
        return undefined;
    }
    if (
        input.verifier_config_key !== EARTHQUAKE_VERIFIER_CONFIG_KEY ||
        !isSafeIntegerInRange(input.verifier_config_version, 1, Number.MAX_SAFE_INTEGER) ||
        !isHexBytes(input.enclave_instance_public_key, 32)
    ) {
        return undefined;
    }
    return {
        verifier_config_key: input.verifier_config_key,
        verifier_config_version: input.verifier_config_version,
        enclave_instance_public_key: input.enclave_instance_public_key,
    };
}

function execWithStdin(
    command: string,
    args: readonly string[],
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        stdin: string;
        maxBuffer: number;
        signal?: AbortSignal;
    },
): Promise<string> {
    if (options.signal?.aborted === true) {
        return Promise.reject(new Error("process aborted"));
    }

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let killTimer: NodeJS.Timeout | undefined;
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            callback();
        };
        const cleanup = (): void => {
            if (killTimer !== undefined) {
                clearTimeout(killTimer);
                killTimer = undefined;
            }
            options.signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => {
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
                child.kill("SIGKILL");
            }, ABORT_KILL_GRACE_MS);
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > options.maxBuffer) {
                child.kill("SIGTERM");
                finish(() => reject(new Error("process stdout exceeded maxBuffer")));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr.push(chunk);
        });
        child.stdin.on("error", (error) => {
            if (options.signal?.aborted === true) {
                return;
            }
            finish(() => reject(error));
        });
        child.on("error", (error) => {
            finish(() => reject(error));
        });
        child.on("close", (code) => {
            if (options.signal?.aborted === true) {
                finish(() => reject(new Error("process aborted")));
                return;
            }
            if (code === 0) {
                finish(() => resolve(Buffer.concat(stdout).toString("utf8")));
                return;
            }
            finish(() =>
                reject(
                    new Error(
                        `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
                    ),
                ),
            );
        });
        child.stdin.end(options.stdin);
    });
}

async function readJsonBody(
    request: IncomingMessage,
    bodyLimitBytes: number,
): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > bodyLimitBytes) {
            throw new RunnerServiceError("AWS_RUNNER_CONTRACT_INVALID", "request body too large");
        }
        chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
    return token.length > 0 && request.headers.authorization === `Bearer ${token}`;
}

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
}

function errorResponse(error: unknown): { ok: false; error_code: OracleErrorCode; message: string } {
    if (error instanceof RunnerServiceError) {
        return { ok: false, error_code: error.errorCode, message: error.message };
    }
    return {
        ok: false,
        error_code: "AWS_RUNNER_PROCESS_FAILED",
        message: error instanceof Error ? error.message : String(error),
    };
}

class RunnerServiceError extends Error {
    constructor(
        readonly errorCode: OracleErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "RunnerServiceError";
    }
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

function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isHexBytes(value: unknown, expectedBytes: number): value is string {
    if (typeof value !== "string" || !/^(?:0x)?[0-9a-fA-F]+$/.test(value)) {
        return false;
    }
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    return hex.length === expectedBytes * 2;
}

function normalizeHex(value: string): string {
    return (value.startsWith("0x") ? value.slice(2) : value).toLowerCase();
}

function readSuiNetwork(input: unknown): "mainnet" | "testnet" | "devnet" | undefined {
    return input === "mainnet" || input === "testnet" || input === "devnet" ? input : undefined;
}
