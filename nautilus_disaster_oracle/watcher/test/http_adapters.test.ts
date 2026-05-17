import { BCS_ENUMS, DEFAULT_ORACLE_CONTRACT } from "@sonari/oracle-shared";
import { describe, expect, it } from "vitest";
import {
    HttpRelayerPreviewAdapter,
    HttpRunnerAdapter,
    type RelayerRequestPreview,
} from "../src/index.js";

const request = {
    request_type: "DETECT_BY_EVENT_ID" as const,
    hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
    primary_source: BCS_ENUMS.primarySource.USGS,
    source_event_id: "us7000sonari",
    geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
};

const context = {
    nowMs: 1_800_000_000_000,
    finalizationDeadlineAtMs: 1_800_172_800_000,
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
    arguments: ["0x456", [1], [2], [3]],
    submitRequest: {
        target: "0x123::disaster_oracle::submit_payload_v1",
        registry: "0x456",
        arguments: ["0x456", [1], [2], [3]],
    },
};

describe("HTTP sidecar adapters", () => {
    it("sends WorkerToTeeRequest unchanged to the oracle sidecar", async () => {
        const calls: Request[] = [];
        const adapter = new HttpRunnerAdapter("http://127.0.0.1:8789", async (input) => {
            const outbound = input instanceof Request ? input : new Request(input);
            calls.push(outbound.clone());
            return Response.json({ ok: true, result: finalized });
        });

        await expect(adapter.run(request, context)).resolves.toEqual(finalized);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe("http://127.0.0.1:8789/oracle/run");
        await expect(calls[0]?.json()).resolves.toEqual({
            request,
            context,
        });
    });

    it("throws sidecar oracle errors so processing uses the existing runner failure path", async () => {
        const adapter = new HttpRunnerAdapter("http://127.0.0.1:8789", async () =>
            Response.json(
                { ok: false, error_code: "RUST_ORACLE_FAILED", message: "cargo failed" },
                { status: 500 },
            ),
        );

        await expect(adapter.run(request, context)).rejects.toThrow(/cargo failed/);
    });

    it("rejects non-finalized relayer inputs before sending them to the sidecar", async () => {
        let calls = 0;
        const adapter = new HttpRelayerPreviewAdapter(
            {
                sidecarUrl: "http://127.0.0.1:8789",
                target: preview.target,
                registry: preview.registry,
            },
            async () => {
                calls += 1;
                return Response.json({ ok: true, value: preview });
            },
        );

        await expect(
            adapter.previewRelayerRequest({
                status: "pending_mmi",
                source_event_id: "us7000sonari",
                next_retry_at_ms: context.nowMs,
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
        const adapter = new HttpRelayerPreviewAdapter(
            {
                sidecarUrl: "http://127.0.0.1:8789",
                target: preview.target,
                registry: preview.registry,
            },
            async (input) => {
                const outbound = input instanceof Request ? input : new Request(input);
                calls.push(outbound.clone());
                return Response.json({ ok: true, value: preview });
            },
        );

        await expect(adapter.previewRelayerRequest(finalized)).resolves.toEqual({
            ok: true,
            value: preview,
        });
        await expect(calls[0]?.json()).resolves.toEqual({
            input: finalized,
            target: preview.target,
            registry: preview.registry,
        });
    });
});
