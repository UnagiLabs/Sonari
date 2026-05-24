import {
    BCS_ENUMS,
    DEFAULT_ORACLE_CONTRACT,
    type TeeCoreResult,
} from "@sonari/oracle-shared";
import { afterEach, describe, expect, it } from "vitest";
import { createRunnerServer, type TeeProcessAdapter } from "../src/index.js";

const request = {
    source_event_id: "us7000sonari",
    hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
    primary_source: BCS_ENUMS.primarySource.USGS,
    geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
};

const finalized: TeeCoreResult = {
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
        const response = await fetch(`${server.url}/process`, {
            method: "POST",
            headers: authHeaders(),
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

    it("processes valid requests through the configured TEE adapter", async () => {
        const tee = new RecordingTeeAdapter();
        const server = await listen(tee);
        const response = await fetch(`${server.url}/process`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ payload: request }),
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true, result: finalized });
        expect(tee.requests).toEqual([request]);
    });

    it("enforces request body size limits", async () => {
        const server = await listen(new RecordingTeeAdapter(), 16);
        const response = await fetch(`${server.url}/process`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ payload: request }),
        });

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error_code: "AWS_RUNNER_CONTRACT_INVALID",
        });
    });
});

class RecordingTeeAdapter implements TeeProcessAdapter {
    readonly requests: typeof request[] = [];

    async process(input: typeof request): Promise<TeeCoreResult> {
        this.requests.push(structuredClone(input));
        return finalized;
    }
}

function authHeaders(): Headers {
    return new Headers({
        authorization: "Bearer runner-token",
        "content-type": "application/json",
    });
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
