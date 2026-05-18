import { afterEach, describe, expect, it, vi } from "vitest";
import { runLiveE2e } from "./nautilus_live_e2e.js";

describe("Nautilus live oracle E2E harness", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it("runs a manual live event through the runner boundary with mocked USGS HTTP", async () => {
        const requests: string[] = [];
        vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
            const url = String(input);
            requests.push(url);
            if (url.endsWith("/all_hour.geojson")) {
                return Response.json({ features: [] });
            }
            return new Response("missing", { status: 404 });
        });

        const output = await runLiveE2e({
            manualEventId: "us7000manual",
            scanLive: false,
            expect: "pending_source",
            nowMs: 1_800_000_000_000,
        });

        expect(requests).toContain(
            "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000manual.geojson",
        );
        expect(output).toMatchObject({
            manual_event_id: "us7000manual",
            runner_invocation_count: 1,
            runner_result: {
                status: "pending_source",
                error_code: "USGS_DETAIL_UNAVAILABLE",
            },
            event: {
                status: "pending_source",
                error_code: "USGS_DETAIL_UNAVAILABLE",
            },
            relayer: {
                mode: "preview",
                status: null,
                argument_lengths: [],
            },
        });
    });

    it("rejects invalid RELAYER_MODE before running the harness", async () => {
        vi.stubEnv("RELAYER_MODE", "invalid");
        vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));

        await expect(
            runLiveE2e({
                manualEventId: "us7000manual",
                scanLive: false,
                nowMs: 1_800_000_000_000,
            }),
        ).rejects.toThrow("Unsupported RELAYER_MODE: invalid");
    });

    it("validates submitted expectation against RELAYER_MODE before row status comparison", async () => {
        vi.stubEnv("RELAYER_MODE", "preview");
        vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));

        await expect(
            runLiveE2e({
                manualEventId: "us7000manual",
                scanLive: false,
                expect: "submitted",
                nowMs: 1_800_000_000_000,
            }),
        ).rejects.toThrow("submitted expectation requires RELAYER_MODE=submit");
    });
});
