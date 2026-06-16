import { describe, expect, it } from "vitest";
import type { AffectedAreaWorkflowInput } from "./affected_area_workflow_input.js";
import { affectedAreaWorkflowInstanceId } from "./affected_area_workflow_trigger.js";

const VALID_INPUT: AffectedAreaWorkflowInput = {
    event_uid: "0x761f8694f710f24141f4aed210b64a2ac5172d3362dec1e5d62295f44bfd437d",
    event_revision: 2,
    affected_cells_hash: "0xc3bb6d3a0ba176465f91024bf73aa89c1ba45aaa4f739a93288f2cbcafdb30bc",
    affected_cells_root: "0x419e809c74e090ba27464e7c692e3752434fb35e261b5ce9ec603de1f47d1ab8",
    affected_cell_count: 200,
    geo_resolution: 7,
    affected_cells_uri: "walrus://blob/test-blob-id-001",
};

describe("affectedAreaWorkflowInstanceId", () => {
    it("builds a short id accepted by the Cloudflare production limit", () => {
        const id = affectedAreaWorkflowInstanceId(VALID_INPUT);

        expect(id).toMatch(/^affected-area-r2-[0-9a-f]{32}$/u);
        expect(id.length).toBeLessThanOrEqual(64);
    });

    it("is deterministic for the same event revision and affected-cells root", () => {
        expect(affectedAreaWorkflowInstanceId(VALID_INPUT)).toBe(
            affectedAreaWorkflowInstanceId({ ...VALID_INPUT }),
        );
    });

    it("changes when the affected-cells root changes", () => {
        const otherId = affectedAreaWorkflowInstanceId({
            ...VALID_INPUT,
            affected_cells_root:
                "0x519e809c74e090ba27464e7c692e3752434fb35e261b5ce9ec603de1f47d1ab8",
        });

        expect(otherId).not.toBe(affectedAreaWorkflowInstanceId(VALID_INPUT));
    });
});
