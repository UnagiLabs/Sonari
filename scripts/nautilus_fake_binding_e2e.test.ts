import { describe, expect, it } from "vitest";
import { runFakeBindingOracleE2e } from "./nautilus_fake_binding_e2e.js";

describe("Nautilus fake-binding oracle E2E", () => {
    it("covers controlled queue and stale recovery paths without Wrangler", async () => {
        const output = await runFakeBindingOracleE2e();

        expect(output.cases).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: "ignored_small", status: "ignored_small" }),
                expect.objectContaining({ name: "ignored_small_to_new", status: "queued" }),
                expect.objectContaining({ name: "queue_send_failure", status: "new" }),
                expect.objectContaining({ name: "stale_queued_recovery", recovered: 1 }),
                expect.objectContaining({ name: "stale_processing_recovery", recovered: 1 }),
                expect.objectContaining({
                    name: "deadline_exceeded_rejected",
                    status: "rejected",
                    error_code: "REJECTED_AUTO_TRIGGER",
                }),
            ]),
        );
    });
});
