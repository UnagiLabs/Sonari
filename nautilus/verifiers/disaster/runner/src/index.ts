import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
    buildRelayerRequestPreview,
    dryRunRelayerSubmit,
} from "@sonari/oracle-relayer";
import {
    type OracleErrorCode,
    type TeeCoreResult,
    validateRelayerSubmitInput,
    validateWorkerToTeeRequest,
    type WorkerToTeeRequest,
} from "@sonari/oracle-shared";

const execFileAsync = promisify(execFile);
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

export interface RunnerServiceOptions {
    token: string;
    tee: TeeProcessAdapter;
    bodyLimitBytes?: number;
}

export interface TeeProcessAdapter {
    process(request: WorkerToTeeRequest): Promise<TeeCoreResult>;
}

export function createRunnerServer(options: RunnerServiceOptions): Server {
    const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
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
                writeJson(response, 200, { ok: true, service: "sonari-disaster-runner" });
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
                writeJson(response, 200, { ok: true, runner_id: `runner-${Date.now()}` });
                return;
            }

            if (request.url === "/stop") {
                writeJson(response, 200, { ok: true });
                return;
            }

            if (request.url === "/process") {
                await handleProcess(request, response, options.tee, bodyLimitBytes);
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

async function handleProcess(
    request: IncomingMessage,
    response: ServerResponse,
    tee: TeeProcessAdapter,
    bodyLimitBytes: number,
): Promise<void> {
    const body = await readJsonBody(request, bodyLimitBytes);
    if (!isRecord(body) || firstUnexpectedKey(body, ["payload"]) !== undefined) {
        writeJson(response, 400, {
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
            message: "process accepts only payload",
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

    const result = await tee.process(validation.value);
    writeJson(response, 200, { ok: true, result });
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

    async process(request: WorkerToTeeRequest): Promise<TeeCoreResult> {
        const dir = await mkdtemp(path.join(tmpdir(), "sonari-runner-"));
        const inputPath = path.join(dir, "worker_request.json");
        try {
            await writeFile(inputPath, JSON.stringify(request));
            const { stdout } = await execFileAsync(
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
                {
                    cwd: this.options.cwd,
                    env: this.options.env,
                    maxBuffer: 10 * 1024 * 1024,
                },
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

    async process(request: WorkerToTeeRequest): Promise<TeeCoreResult> {
        const options: Parameters<typeof execWithStdin>[2] = {
            maxBuffer: 10 * 1024 * 1024,
            stdin: JSON.stringify(request),
        };
        if (this.options.cwd !== undefined) {
            options.cwd = this.options.cwd;
        }
        if (this.options.env !== undefined) {
            options.env = this.options.env;
        }
        const stdout = await execWithStdin(this.options.command, this.options.args ?? [], options);
        return JSON.parse(stdout) as TeeCoreResult;
    }
}

function execWithStdin(
    command: string,
    args: readonly string[],
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        stdin: string;
        maxBuffer: number;
    },
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        child.stdout.on("data", (chunk: Buffer) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > options.maxBuffer) {
                child.kill();
                reject(new Error("process stdout exceeded maxBuffer"));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr.push(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve(Buffer.concat(stdout).toString("utf8"));
                return;
            }
            reject(
                new Error(
                    `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
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
