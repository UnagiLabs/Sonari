import { BCS_ENUMS, DEFAULT_ORACLE_CONTRACT } from "@sonari/oracle-shared";
import { describe, expect, it } from "vitest";
import {
    AwsRunnerLifecycleAdapter,
    HttpRelayerAdapter,
    HttpRunnerAdapter,
    RunnerContractError,
    RunnerProcessError,
    RunnerStartError,
    type RelayerRequestPreview,
} from "../src/index.js";

const request = {
    source_event_id: "us7000sonari",
    hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
    primary_source: BCS_ENUMS.primarySource.USGS,
    geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
};

const finalized = {
    status: "finalized" as const,
    payload: {
        event_uid: "us7000sonari",
        event_revision: 3,
        source_updated_at_ms: 1_704_151_200_000,
        status: BCS_ENUMS.onchainStatus.FINALIZED,
    },
    payload_bcs_hex: "0x01",
    signature: `0x${"11".repeat(64)}`,
    public_key: `0x${"22".repeat(32)}`,
};

const preview: RelayerRequestPreview = {
    target: "0x123::disaster_oracle::submit_payload_v1",
    registry: "0x456",
    verifierRegistry: "0x654",
    clock: "0x0000000000000000000000000000000000000000000000000000000000000006",
    arguments: [
        "0x456",
        "0x654",
        "0x0000000000000000000000000000000000000000000000000000000000000006",
        [1],
        [2],
        [3],
    ],
    submitRequest: {
        target: "0x123::disaster_oracle::submit_payload_v1",
        registry: "0x456",
        verifierRegistry: "0x654",
        clock: "0x0000000000000000000000000000000000000000000000000000000000000006",
        arguments: [
            "0x456",
            "0x654",
            "0x0000000000000000000000000000000000000000000000000000000000000006",
            [1],
            [2],
            [3],
        ],
    },
};

describe("HTTP sidecar adapters", () => {
    it("sends only the Nautilus payload wrapper to /process_data", async () => {
        const calls: Request[] = [];
        const adapter = new HttpRunnerAdapter("http://127.0.0.1:8789", async (input) => {
            const outbound = input instanceof Request ? input : new Request(input);
            calls.push(outbound.clone());
            return Response.json({ ok: true, result: finalized });
        });

        await expect(adapter.run(request)).resolves.toEqual(finalized);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe("http://127.0.0.1:8789/process_data");
        await expect(calls[0]?.json()).resolves.toEqual({
            payload: request,
        });
    });

    it("throws sidecar oracle errors so processing uses the existing runner failure path", async () => {
        const adapter = new HttpRunnerAdapter("http://127.0.0.1:8789", async () =>
            Response.json(
                { ok: false, error_code: "RUST_ORACLE_FAILED", message: "cargo failed" },
                { status: 500 },
            ),
        );

        await expect(adapter.run(request)).rejects.toThrow(/cargo failed/);
    });

    it("uses the AWS runner lifecycle start/process/stop contract", async () => {
        const calls: Request[] = [];
        const runnerAuth = "test-runner-auth";
        const adapter = new AwsRunnerLifecycleAdapter({
            baseUrl: "https://runner.example",
            ["token"]: runnerAuth,
            fetcher: async (input) => {
                const outbound = input instanceof Request ? input : new Request(input);
                calls.push(outbound.clone());
                if (outbound.url.endsWith("/start")) {
                    return Response.json({ ok: true, runner_id: "runner-123" });
                }
                if (outbound.url.endsWith("/process")) {
                    return Response.json({ ok: true, result: finalized });
                }
                return Response.json({ ok: true });
            },
        });

        await expect(adapter.start()).resolves.toEqual({ runner_id: "runner-123" });
        await expect(adapter.process("runner-123", request)).resolves.toEqual(finalized);
        await expect(adapter.stop("runner-123")).resolves.toBeUndefined();

        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
            "/start",
            "/process",
            "/stop",
        ]);
        expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
            `Bearer ${runnerAuth}`,
            `Bearer ${runnerAuth}`,
            `Bearer ${runnerAuth}`,
        ]);
        expect(calls[1]?.headers.get("x-runner-id")).toBe("runner-123");
        await expect(calls[1]?.json()).resolves.toEqual({ payload: request });
        await expect(calls[2]?.json()).resolves.toEqual({ runner_id: "runner-123" });
    });

    it("maps AWS runner ok:false responses to RunnerProcessError with allowed error codes", async () => {
        const adapter = new AwsRunnerLifecycleAdapter({
            baseUrl: "https://runner.example",
            ["token"]: "test-runner-auth",
            fetcher: async () =>
                Response.json({
                    ok: false,
                    error_code: "BCS_SERIALIZATION_FAILED",
                    message: "bad bcs",
                }),
        });

        const error = await adapter.process("runner-123", request).catch((caught) => caught);

        expect(error).toBeInstanceOf(RunnerProcessError);
        expect(error).toMatchObject({
            errorCode: "BCS_SERIALIZATION_FAILED",
            message: "bad bcs",
        });
    });

    it("rejects AWS runner start ok:false responses even when runner_id is present", async () => {
        const adapter = new AwsRunnerLifecycleAdapter({
            baseUrl: "https://runner.example",
            ["token"]: "test-runner-auth",
            fetcher: async () =>
                Response.json({
                    ok: false,
                    runner_id: "runner-123",
                    message: "start failed",
            }),
        });

        const error = await adapter.start().catch((caught) => caught);

        expect(error).toBeInstanceOf(RunnerStartError);
        expect(error).toMatchObject({
            errorCode: "AWS_RUNNER_START_FAILED",
            message: "start failed",
        });
    });

    it("rejects AWS runner start responses that omit runner_id", async () => {
        const adapter = new AwsRunnerLifecycleAdapter({
            baseUrl: "https://runner.example",
            ["token"]: "test-runner-auth",
            fetcher: async () => Response.json({ ok: true }),
        });

        const error = await adapter.start().catch((caught) => caught);

        expect(error).toBeInstanceOf(RunnerContractError);
        expect(error).toMatchObject({
            errorCode: "AWS_RUNNER_CONTRACT_INVALID",
        });
    });

    it("maps AWS runner process ok:false error responses to RunnerProcessError regardless of HTTP status", async () => {
        const adapter = new AwsRunnerLifecycleAdapter({
            baseUrl: "https://runner.example",
            ["token"]: "test-runner-auth",
            fetcher: async () =>
                Response.json(
                    {
                        ok: false,
                        error_code: "BCS_SERIALIZATION_FAILED",
                        message: "bad bcs",
                    },
                    { status: 500 },
                ),
        });

        const error = await adapter.process("runner-123", request).catch((caught) => caught);

        expect(error).toBeInstanceOf(RunnerProcessError);
        expect(error).toMatchObject({
            errorCode: "BCS_SERIALIZATION_FAILED",
            message: "bad bcs",
        });
    });

    it("maps AWS runner process ok:false invalid error_code to process failure", async () => {
        const adapter = new AwsRunnerLifecycleAdapter({
            baseUrl: "https://runner.example",
            ["token"]: "test-runner-auth",
            fetcher: async () =>
                Response.json({
                    ok: false,
                    error_code: "NOT_A_SHARED_CODE",
                    message: "bad code",
                }),
        });

        const error = await adapter.process("runner-123", request).catch((caught) => caught);

        expect(error).toBeInstanceOf(RunnerProcessError);
        expect(error).toMatchObject({
            errorCode: "AWS_RUNNER_PROCESS_FAILED",
            message: "bad code",
        });
    });

    it("classifies invalid AWS runner process response shapes as contract invalid", async () => {
        const adapter = new AwsRunnerLifecycleAdapter({
            baseUrl: "https://runner.example",
            ["token"]: "test-runner-auth",
            fetcher: async () => Response.json({ ok: true, result: "not-an-object" }),
        });

        const error = await adapter.process("runner-123", request).catch((caught) => caught);

        expect(error).toBeInstanceOf(RunnerContractError);
        expect(error).toMatchObject({
            errorCode: "AWS_RUNNER_CONTRACT_INVALID",
        });
    });

    it("rejects AWS runner stop ok:false responses", async () => {
        const adapter = new AwsRunnerLifecycleAdapter({
            baseUrl: "https://runner.example",
            ["token"]: "test-runner-auth",
            fetcher: async () =>
                Response.json({
                    ok: false,
                    message: "stop failed",
                }),
        });

        await expect(adapter.stop("runner-123")).rejects.toThrow(/stop failed/);
    });

    it("rejects non-finalized relayer inputs before sending them to the sidecar", async () => {
        let calls = 0;
        const adapter = new HttpRelayerAdapter(
            {
                sidecarUrl: "http://127.0.0.1:8789",
                target: preview.target,
                registry: preview.registry,
                verifierRegistry: preview.verifierRegistry,
            },
            async () => {
                calls += 1;
                return Response.json({ ok: true, value: preview });
            },
        );

        await expect(
            adapter.relay({
                status: "pending_mmi",
                source_event_id: "us7000sonari",
                error_code: "MMI_NOT_AVAILABLE",
            }),
        ).resolves.toMatchObject({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
        });
        expect(calls).toBe(0);
    });

    it("sends finalized payloads to the relayer preview sidecar", async () => {
        const calls: Request[] = [];
        const adapter = new HttpRelayerAdapter(
            {
                sidecarUrl: "http://127.0.0.1:8789",
                target: preview.target,
                registry: preview.registry,
                verifierRegistry: preview.verifierRegistry,
            },
            async (input: RequestInfo | URL) => {
                const outbound = input instanceof Request ? input : new Request(input);
                calls.push(outbound.clone());
                return Response.json({ ok: true, value: preview });
            },
        );

        await expect(adapter.relay(finalized)).resolves.toEqual({
            ok: true,
            value: {
                mode: "preview",
                request: preview,
            },
        });
        await expect(calls[0]?.json()).resolves.toEqual({
            input: finalized,
            target: preview.target,
            registry: preview.registry,
            verifierRegistry: preview.verifierRegistry,
        });
    });

    it("can authenticate relayer dry-runs against the AWS runner service", async () => {
        const calls: Request[] = [];
        const adapter = new HttpRelayerAdapter(
            {
                sidecarUrl: "https://runner.example",
                bearerToken: "runner-token",
                mode: "dry_run",
                target: preview.target,
                registry: preview.registry,
                verifierRegistry: preview.verifierRegistry,
                grpcUrl: "https://sui.example",
                senderAddress: "0xabc",
            },
            async (input: RequestInfo | URL) => {
                const outbound = input instanceof Request ? input : new Request(input);
                calls.push(outbound.clone());
                return Response.json({ ok: true, value: { request: preview } });
            },
        );

        await expect(adapter.relay(finalized)).resolves.toMatchObject({
            ok: true,
            value: { mode: "dry_run" },
        });
        expect(calls[0]?.url).toBe("https://runner.example/relayer/dry_run");
        expect(calls[0]?.headers.get("authorization")).toBe("Bearer runner-token");
    });
});
