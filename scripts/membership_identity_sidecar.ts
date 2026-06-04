import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8790;
const DEFAULT_MODE = "fixture";
const DEFAULT_WORLD_ID_STATUS = "verified";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;

export type MembershipIdentitySidecarMode = "fixture" | "production";
export type FixtureWorldIdStatus = "verified" | "rejected" | "pending-source";

export interface MembershipIdentitySidecarOptions {
    readonly host?: string;
    readonly port?: number;
    readonly mode?: MembershipIdentitySidecarMode;
    readonly worldIdStatus?: FixtureWorldIdStatus;
    readonly timeoutMs?: number;
    readonly runner?: MembershipIdentityTeeRunner;
}

export interface MembershipIdentityTeeRunnerConfig {
    readonly mode: MembershipIdentitySidecarMode;
    readonly worldIdStatus: FixtureWorldIdStatus;
    readonly timeoutMs: number;
}

export interface MembershipIdentityTeeRunResult {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly body: unknown;
}

export type MembershipIdentityTeeRunner = (
    request: unknown,
    config: MembershipIdentityTeeRunnerConfig,
) => Promise<MembershipIdentityTeeRunResult>;

class SidecarHttpError extends Error {
    constructor(
        readonly statusCode: number,
        readonly errorCode: string,
        message: string,
    ) {
        super(message);
    }
}

class TeeTimeoutError extends Error {}

export function createMembershipIdentitySidecarServer(
    options: MembershipIdentitySidecarOptions = {},
): Server {
    const config = normalizeOptions(options);
    const runner = options.runner ?? runMembershipTee;

    return createServer(async (request, response) => {
        try {
            if (request.method !== "POST") {
                writeJson(response, 405, { ok: false, error_code: "METHOD_NOT_ALLOWED" });
                return;
            }

            if (request.url !== "/identity/verify") {
                writeJson(response, 404, { ok: false, error_code: "NOT_FOUND" });
                return;
            }

            await handleIdentityVerify(request, response, runner, config);
        } catch (error) {
            if (error instanceof SidecarHttpError) {
                writeJson(response, error.statusCode, {
                    ok: false,
                    error_code: error.errorCode,
                    message: error.message,
                });
                return;
            }

            writeJson(response, 500, {
                ok: false,
                error_code: "IDENTITY_SIDECAR_INTERNAL_ERROR",
                message: errorMessage(error),
            });
        }
    });
}

async function handleIdentityVerify(
    request: IncomingMessage,
    response: ServerResponse,
    runner: MembershipIdentityTeeRunner,
    config: MembershipIdentityTeeRunnerConfig,
): Promise<void> {
    const body = await readJsonBody(request);
    if (!isRecord(body) || firstUnexpectedKey(body, ["request"]) !== undefined) {
        writeJson(response, 400, {
            ok: false,
            error_code: "INVALID_IDENTITY_VERIFY_REQUEST",
            message: "identity sidecar accepts only request",
        });
        return;
    }

    const result = await runWithTimeout(runner(body.request, config), config.timeoutMs);
    writeJson(
        response,
        result.statusCode,
        result.ok ? { ok: true, result: result.body } : result.body,
    );
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new TeeTimeoutError("membership-tee timed out")),
                    timeoutMs,
                );
            }),
        ]);
    } catch (error) {
        if (error instanceof TeeTimeoutError) {
            throw new SidecarHttpError(504, "IDENTITY_TEE_TIMEOUT", error.message);
        }
        throw error;
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

async function runMembershipTee(
    request: unknown,
    config: MembershipIdentityTeeRunnerConfig,
): Promise<MembershipIdentityTeeRunResult> {
    const args =
        config.mode === "production"
            ? ["run", "-q", "-p", "membership-tee", "--", "production"]
            : [
                  "run",
                  "-q",
                  "-p",
                  "membership-tee",
                  "--",
                  "fixture",
                  "--world-id-status",
                  config.worldIdStatus,
              ];
    const output = await runChildProcess("cargo", args, JSON.stringify(request), config.timeoutMs);

    if (!output.ok) {
        return {
            ok: false,
            statusCode: output.timedOut ? 504 : 400,
            body: {
                ok: false,
                error_code: output.timedOut ? "IDENTITY_TEE_TIMEOUT" : "IDENTITY_TEE_FAILED",
                message: output.timedOut
                    ? "membership-tee timed out"
                    : summarizeStderr(output.stderr),
            },
        };
    }

    return {
        ok: true,
        statusCode: 200,
        body: parseJsonOutput(output.stdout),
    };
}

interface ChildProcessOutput {
    readonly ok: boolean;
    readonly timedOut: boolean;
    readonly stdout: string;
    readonly stderr: string;
}

async function runChildProcess(
    command: string,
    args: readonly string[],
    stdin: string,
    timeoutMs: number,
): Promise<ChildProcessOutput> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, timeoutMs);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({
                ok: code === 0 && !timedOut,
                timedOut,
                stdout,
                stderr,
            });
        });
        child.stdin.end(stdin);
    });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > MAX_BODY_BYTES) {
            throw new SidecarHttpError(413, "REQUEST_BODY_TOO_LARGE", "request body is too large");
        }
        chunks.push(buffer);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
        throw new SidecarHttpError(400, "INVALID_JSON", errorMessage(error));
    }
}

function parseJsonOutput(stdout: string): unknown {
    try {
        return JSON.parse(stdout) as unknown;
    } catch (error) {
        throw new SidecarHttpError(502, "INVALID_IDENTITY_TEE_OUTPUT", errorMessage(error));
    }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
}

function normalizeOptions(
    options: MembershipIdentitySidecarOptions,
): MembershipIdentityTeeRunnerConfig {
    return {
        mode: options.mode ?? DEFAULT_MODE,
        worldIdStatus: options.worldIdStatus ?? DEFAULT_WORLD_ID_STATUS,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
}

function parseCliArgs(argv: readonly string[]): Required<MembershipIdentitySidecarOptions> {
    const options: {
        host: string;
        port: number;
        mode: MembershipIdentitySidecarMode;
        worldIdStatus: FixtureWorldIdStatus;
        timeoutMs: number;
        runner: MembershipIdentityTeeRunner;
    } = {
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        mode: DEFAULT_MODE,
        worldIdStatus: DEFAULT_WORLD_ID_STATUS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        runner: runMembershipTee,
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
            case "--mode":
                options.mode = parseMode(requireCliValue(arg, value));
                index += 1;
                break;
            case "--world-id-status":
                options.worldIdStatus = parseWorldIdStatus(requireCliValue(arg, value));
                index += 1;
                break;
            case "--timeout-ms":
                options.timeoutMs = parseTimeoutMs(requireCliValue(arg, value));
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

function parseMode(value: string): MembershipIdentitySidecarMode {
    if (value !== "fixture" && value !== "production") {
        throw new Error("--mode must be fixture or production");
    }
    return value;
}

function parseWorldIdStatus(value: string): FixtureWorldIdStatus {
    if (value !== "verified" && value !== "rejected" && value !== "pending-source") {
        throw new Error("--world-id-status must be verified, rejected, or pending-source");
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

function parseTimeoutMs(value: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error("--timeout-ms must be a positive integer");
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

function summarizeStderr(stderr: string): string {
    const trimmed = stderr.trim();
    if (trimmed.length === 0) {
        return "membership-tee failed without stderr";
    }
    return trimmed.length > 1_000 ? `${trimmed.slice(0, 1_000)}...` : trimmed;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
    const options = parseCliArgs(process.argv.slice(2));
    const server = createMembershipIdentitySidecarServer(options);
    await new Promise<void>((resolve) => {
        server.listen(options.port, options.host, resolve);
    });
    process.stdout.write(
        `Membership identity sidecar listening on http://${options.host}:${options.port}\n`,
    );
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
    });
}
