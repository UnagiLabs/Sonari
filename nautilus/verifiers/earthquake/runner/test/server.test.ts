import {
    BCS_ENUMS,
    DEFAULT_ORACLE_CONTRACT,
    type EnclaveVerificationMetadata,
    type TeeCoreResult,
} from "@sonari/earthquake-shared";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    createRunnerServer,
    EnclaveCommandTeeAdapter,
    type TeeProcessAdapter,
} from "../src/index.js";

const request = {
    source_event_id: "us7000sonari",
    hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
    primary_source: BCS_ENUMS.primarySource.USGS,
    geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
};

const finalized: Extract<TeeCoreResult, { status: "finalized" }> = {
    status: "finalized",
    payload: {
        event_uid: "us7000sonari",
        event_revision: 1,
        source_updated_at_ms: 1_704_151_200_000,
        status: BCS_ENUMS.onchainStatus.FINALIZED,
    },
    payload_bcs_hex: "0x01",
    signature: `0x${"11".repeat(64)}`,
    public_key: `0x${"22".repeat(32)}`,
};

const registrationMetadata: EnclaveVerificationMetadata = {
    verifier_config_key: 1,
    verifier_config_version: 3,
    enclave_instance_public_key: finalized.public_key,
};

const servers: Awaited<ReturnType<typeof listen>>[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("runner HTTP service", () => {
    it("requires bearer auth before health or process endpoints", async () => {
        const server = await listen(new RecordingTeeAdapter());
        const response = await fetch(`${server.url}/health`);

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error_code: "AWS_RUNNER_PROCESS_FAILED",
        });
    });

    it("validates /process payloads against the WorkerToTeeRequest contract", async () => {
        const server = await listen(new RecordingTeeAdapter());
        const runnerId = await startRunner(server.url);
        const response = await fetch(`${server.url}/process`, {
            method: "POST",
            headers: authHeaders(runnerId),
            body: JSON.stringify({
                payload: {
                    ...request,
                    affected_cells_root: "0xdeadbeef",
                },
            }),
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
        });
    });

    it("rejects /process requests without a started runner id", async () => {
        const server = await listen(new RecordingTeeAdapter());
        const response = await fetch(`${server.url}/process`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ payload: request }),
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
        });
    });

    it("rejects /process requests for unknown runner ids", async () => {
        const server = await listen(new RecordingTeeAdapter());
        const response = await fetch(`${server.url}/process`, {
            method: "POST",
            headers: authHeaders("runner-missing"),
            body: JSON.stringify({ payload: request }),
        });

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error_code: "AWS_RUNNER_PROCESS_FAILED",
        });
    });

    it("processes valid requests through the configured TEE adapter", async () => {
        const tee = new RecordingTeeAdapter();
        const server = await listen(tee);
        const runnerId = await startRunner(server.url);
        const response = await fetch(`${server.url}/process`, {
            method: "POST",
            headers: authHeaders(runnerId),
            body: JSON.stringify({ payload: request }),
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true, result: finalized });
        expect(tee.requests).toEqual([request]);
    });

    it("exposes Nautilus-style health_check, get_attestation, and process_data responsibilities", async () => {
        const tee = new RecordingTeeAdapter();
        const server = await listen(tee);
        const runnerId = await startRunner(server.url);

        const health = await fetch(`${server.url}/health_check`, { headers: authHeaders() });
        const attestation = await fetch(`${server.url}/get_attestation`, {
            method: "POST",
            headers: authHeaders(runnerId),
            body: JSON.stringify({}),
        });
        const processed = await fetch(`${server.url}/process_data`, {
            method: "POST",
            headers: authHeaders(runnerId),
            body: JSON.stringify({
                payload: request,
                registration_metadata: registrationMetadata,
            }),
        });

        expect(health.status).toBe(200);
        await expect(health.json()).resolves.toEqual({
            ok: true,
            result: { status: "healthy", external_sources_reachable: true },
        });
        expect(attestation.status).toBe(200);
        await expect(attestation.json()).resolves.toEqual({
            ok: true,
            result: {
                attestation_document_hex: `0x${"aa".repeat(96)}`,
                public_key: finalized.public_key,
            },
        });
        expect(processed.status).toBe(200);
        await expect(processed.json()).resolves.toEqual({
            ok: true,
            result: { ...finalized, ...registrationMetadata },
        });
        expect(tee.requests).toEqual([request]);
        expect(tee.registrations).toEqual([registrationMetadata]);
    });

    it("fails closed when process_data registration metadata is missing or mismatched", async () => {
        const tee = new RecordingTeeAdapter();
        const server = await listen(tee);
        const runnerId = await startRunner(server.url);

        const missing = await fetch(`${server.url}/process_data`, {
            method: "POST",
            headers: authHeaders(runnerId),
            body: JSON.stringify({ payload: request }),
        });
        const mismatch = await fetch(`${server.url}/process_data`, {
            method: "POST",
            headers: authHeaders(runnerId),
            body: JSON.stringify({
                payload: request,
                registration_metadata: {
                    ...registrationMetadata,
                    enclave_instance_public_key: `0x${"33".repeat(32)}`,
                },
            }),
        });

        expect(missing.status).toBe(400);
        await expect(missing.json()).resolves.toMatchObject({
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
        });
        expect(mismatch.status).toBe(500);
        await expect(mismatch.json()).resolves.toMatchObject({
            ok: false,
            error_code: "AWS_RUNNER_PROCESS_FAILED",
            message: expect.stringContaining("registration public key"),
        });
        expect(tee.requests).toEqual([request]);
    });

    it("enforces request body size limits", async () => {
        const server = await listen(new RecordingTeeAdapter(), 16);
        const runnerId = await startRunner(server.url);
        const response = await fetch(`${server.url}/process`, {
            method: "POST",
            headers: authHeaders(runnerId),
            body: JSON.stringify({ payload: request }),
        });

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
        });
    });

    it("aborts an active process when /stop is called for the runner id", async () => {
        const tee = new BlockingTeeAdapter();
        const server = await listen(tee);
        const runnerId = await startRunner(server.url);
        const processPromise = fetch(`${server.url}/process`, {
            method: "POST",
            headers: authHeaders(runnerId),
            body: JSON.stringify({ payload: request }),
        });
        await tee.started;

        const stopResponse = await fetch(`${server.url}/stop`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ runner_id: runnerId }),
        });

        const wasAborted = tee.signal?.aborted === true;
        tee.complete();
        await processPromise;

        expect(stopResponse.status).toBe(200);
        expect(wasAborted).toBe(true);
    });

    it("rejects /stop requests with invalid bodies", async () => {
        const server = await listen(new RecordingTeeAdapter());
        const response = await fetch(`${server.url}/stop`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({}),
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
        });
    });

    it("rejects /stop requests for unknown runner ids", async () => {
        const server = await listen(new RecordingTeeAdapter());
        const response = await fetch(`${server.url}/stop`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ runner_id: "runner-missing" }),
        });

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error_code: "AWS_RUNNER_PROCESS_FAILED",
        });
    });
});

describe("TEE process adapters", () => {
    it("terminates enclave command child processes when aborted", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "sonari-runner-test-"));
        const scriptPath = path.join(dir, "wait-for-abort.mjs");
        const readyPath = path.join(dir, "sigterm-ready");
        const markerPath = path.join(dir, "sigterm-marker");
        await writeFile(
            scriptPath,
            `
import { writeFileSync } from "node:fs";

process.stdin.resume();
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(markerPath)}, "terminated");
  setInterval(() => {}, 1_000);
});
writeFileSync(${JSON.stringify(readyPath)}, "ready");
setTimeout(() => {
  process.stdout.write(${JSON.stringify(JSON.stringify(finalized))});
  process.exit(0);
}, 1_000);
`,
        );
        await chmod(scriptPath, 0o700);

        try {
            const adapter = new EnclaveCommandTeeAdapter({
                command: process.execPath,
                args: [scriptPath],
            });
            const controller = new AbortController();
            const processing = (
                adapter as {
                    process(input: typeof request, signal: AbortSignal): Promise<TeeCoreResult>;
                }
            ).process(request, controller.signal);

            await expect(waitForFile(readyPath)).resolves.toBe("ready");
            controller.abort();

            await expect(processing).rejects.toThrow(/aborted/i);
            await expect(waitForFile(markerPath)).resolves.toBe("terminated");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

class RecordingTeeAdapter implements TeeProcessAdapter {
    readonly requests: typeof request[] = [];
    readonly registrations: EnclaveVerificationMetadata[] = [];

    async healthCheck(): Promise<{ status: "healthy"; external_sources_reachable: boolean }> {
        return { status: "healthy", external_sources_reachable: true };
    }

    async getAttestation(): Promise<{ attestation_document_hex: string; public_key: string }> {
        return {
            attestation_document_hex: `0x${"aa".repeat(96)}`,
            public_key: finalized.public_key,
        };
    }

    async process(
        input: typeof request,
        _signal?: AbortSignal,
        registration?: EnclaveVerificationMetadata,
    ): Promise<TeeCoreResult> {
        this.requests.push(structuredClone(input));
        if (registration !== undefined) {
            this.registrations.push(structuredClone(registration));
        }
        return finalized;
    }
}

class BlockingTeeAdapter implements TeeProcessAdapter {
    signal: AbortSignal | undefined;
    readonly started: Promise<void>;
    private resolveStarted!: () => void;
    private resolveProcess: ((value: TeeCoreResult) => void) | undefined;

    constructor() {
        this.started = new Promise((resolve) => {
            this.resolveStarted = resolve;
        });
    }

    process(_input: typeof request, signal?: AbortSignal): Promise<TeeCoreResult> {
        this.signal = signal;
        this.resolveStarted();
        return new Promise((resolve) => {
            this.resolveProcess = resolve;
        });
    }

    complete(): void {
        this.resolveProcess?.(finalized);
    }
}

function authHeaders(runnerId?: string): Headers {
    const headers = new Headers({
        authorization: "Bearer runner-token",
        "content-type": "application/json",
    });
    if (runnerId !== undefined) {
        headers.set("x-runner-id", runnerId);
    }
    return headers;
}

async function listen(tee: TeeProcessAdapter, bodyLimitBytes?: number): Promise<{
    url: string;
    close: () => Promise<void>;
}> {
    const options: Parameters<typeof createRunnerServer>[0] = {
        ["token"]: "runner-token",
        tee,
    };
    if (bodyLimitBytes !== undefined) {
        options.bodyLimitBytes = bodyLimitBytes;
    }
    const server = createRunnerServer(options);
    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("test server did not listen on a TCP port");
    }
    const handle = {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            }),
    };
    servers.push(handle);
    return handle;
}

async function startRunner(baseUrl: string): Promise<string> {
    const response = await fetch(`${baseUrl}/start`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
    });
    const body = (await response.json()) as { runner_id?: unknown };
    if (typeof body.runner_id !== "string") {
        throw new Error("runner did not start");
    }
    return body.runner_id;
}

async function waitForFile(filePath: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            return await readFile(filePath, "utf8");
        } catch (error) {
            if (!isNotFound(error)) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
    throw new Error(`file was not written: ${filePath}`);
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
