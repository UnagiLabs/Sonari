import { describe, expect, it } from "vitest";
import { HOUR_MS } from "../nautilus_disaster_oracle/watcher/src/index.js";
import {
    E2E_FIXTURE_CASES,
    loadFixtureCandidate,
    runLocalOracleE2e,
} from "./nautilus_local_e2e.js";

const target = "0x123::disaster_oracle::submit_payload_v1";
const registry = "0x456";
const LOCAL_E2E_TEST_TIMEOUT_MS = 30_000;

describe("Nautilus local oracle E2E", () => {
    it(
        "finalizes the canonical fixture and builds a relayer request preview",
        async () => {
            const output = await runLocalOracleE2e({
                caseId: "usgs/finalized_minimal",
                target,
                registry,
            });

            expect(output.case_id).toBe("usgs/finalized_minimal");
            expect(output.source_event_id).toBe("us7000sonari");
            expect(output.first_process_summary.processed).toBe(1);
            expect(output.second_process_summary.processed).toBe(0);
            expect(output.runner_invocation_count).toBe(1);
            expect(output.final_event).toMatchObject({
                status: "finalized",
                retry_count: 0,
                source_updated_at_ms: 1_704_151_200_000,
                error_code: null,
            });
            expect(output.runner_result).toEqual({
                status: "finalized",
                payload: expect.objectContaining({
                    event_uid: expect.any(String),
                    source_updated_at_ms: 1_704_151_200_000,
                }),
                payload_bcs_hex: expect.any(String),
                signature: expect.any(String),
                public_key: expect.any(String),
            });
            expect(output.runner_result).not.toHaveProperty("payloadBcsBytes");
            expect(output.runner_result).not.toHaveProperty("signatureBytes");
            expect(output.runner_result).not.toHaveProperty("publicKeyBytes");
            expect(output.relayer_preview).toMatchObject({
                ok: true,
                value: {
                    target,
                    registry,
                    arguments: [registry, expect.any(Array), expect.any(Array), expect.any(Array)],
                },
            });
            expect(output).not.toHaveProperty("relayer_skipped");
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );

    it(
        "fails finalized cases when relayer preview generation fails",
        async () => {
            await expect(
                runLocalOracleE2e({
                    caseId: "usgs/finalized_minimal",
                    target: "",
                    registry,
                }),
            ).rejects.toThrow(/Local E2E relayer preview failed: .*target and registry/);
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );

    it.each([
        ["usgs/pending_source_no_shakemap", "pending_source", "SHAKEMAP_PRODUCT_MISSING"],
        ["usgs/pending_mmi_empty_grid", "pending_mmi", "MMI_NOT_AVAILABLE"],
        ["usgs/rejected_cancelled_shakemap", "rejected", "SHAKEMAP_CANCELLED"],
        ["usgs/rejected_no_affected_cells", "rejected", "NO_AFFECTED_CELLS"],
    ] as const)(
        "skips relayer preview for non-finalized case %s",
        async (caseId, status, errorCode) => {
            const output = await runLocalOracleE2e({ caseId, target, registry });

            expect(output.first_process_summary.processed).toBe(1);
            expect(output.second_process_summary.processed).toBe(0);
            expect(output.runner_invocation_count).toBe(1);
            expect(output.runner_result).toMatchObject({
                status,
                source_event_id: output.source_event_id,
                error_code: errorCode,
            });
            expect(output.final_event).toMatchObject({
                status,
                retry_count: 0,
                error_code: errorCode,
            });
            expect(output.relayer_skipped).toEqual({
                reason: "non_finalized_status",
                status,
                error_code: errorCode,
            });
            expect(output).not.toHaveProperty("relayer_preview");
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );

    it(
        "keeps every Step 6 fixture eligible under normal watcher screening",
        async () => {
            for (const caseId of E2E_FIXTURE_CASES) {
                const output = await runLocalOracleE2e({ caseId, target, registry });

                expect(output.first_process_summary.processed).toBe(1);
                expect(output.final_event.status).not.toBe("ignored_small");
            }
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );

    it.each([
        ["usgs/finalized_minimal", "finalized", null],
        ["usgs/rejected_cancelled_shakemap", "rejected", "SHAKEMAP_CANCELLED"],
    ] as const)(
        "does not re-run terminal case %s after duplicate scans and process attempts",
        async (caseId, status, errorCode) => {
            const candidate = loadFixtureCandidate(caseId);
            const output = await runLocalOracleE2e({
                caseId,
                nowMs: candidate.occurred_at_ms + 25 * HOUR_MS,
                target,
                registry,
            });

            expect(output.runner_invocation_count).toBe(1);
            expect(output.second_process_summary).toMatchObject({
                processed: 0,
                deferred: 0,
                recovered: 0,
                failed: 0,
                rejected: 0,
            });
            expect(output.final_event).toMatchObject({
                status,
                retry_count: 0,
                source_updated_at_ms: candidate.source_updated_at_ms,
                error_code: errorCode,
            });
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );
});
