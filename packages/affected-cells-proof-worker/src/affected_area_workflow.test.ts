import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    summarizeAffectedAreaWorkflowInput,
    validateAffectedAreaWorkflowInput,
} from "./affected_area_workflow_input.js";

const VALID_INPUT = {
    event_uid: "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
    event_revision: 1,
    affected_cells_hash: `0x${"12".repeat(32)}`,
    affected_cells_root: `0x${"34".repeat(32)}`,
    affected_cell_count: 2,
    geo_resolution: 7,
    affected_cells_uri: "walrus://blob/test-blob-id-001",
};

describe("validateAffectedAreaWorkflowInput", () => {
    it("accepts the registration metadata used by the workflow", () => {
        expect(validateAffectedAreaWorkflowInput(VALID_INPUT)).toStrictEqual(VALID_INPUT);
    });

    it("rejects invalid payloads before any heavy work starts", () => {
        expect(() =>
            validateAffectedAreaWorkflowInput({ ...VALID_INPUT, geo_resolution: 8 }),
        ).toThrow(/geo_resolution/u);
        expect(() =>
            validateAffectedAreaWorkflowInput({
                ...VALID_INPUT,
                affected_cells_uri: "https://example.com/blob",
            }),
        ).toThrow(/walrus/u);
    });

    it("summarizes without returning large artifact bytes", () => {
        const summary = summarizeAffectedAreaWorkflowInput(
            validateAffectedAreaWorkflowInput(VALID_INPUT),
        );

        expect(summary).toStrictEqual({
            event_uid: VALID_INPUT.event_uid,
            event_revision: VALID_INPUT.event_revision,
            affected_cells_root: VALID_INPUT.affected_cells_root,
        });
        expect(new TextEncoder().encode(JSON.stringify(summary)).byteLength).toBeLessThan(1024);
    });
});

describe("AffectedAreaArtifactWorkflow", () => {
    it("is exported as the class named by wrangler.toml", async () => {
        vi.stubGlobal("WorkflowEntrypoint", class {});
        vi.stubGlobal("NonRetryableError", Error);

        const [{ AffectedAreaArtifactWorkflow }, wranglerToml] = await Promise.all([
            import("./affected_area_workflow.js"),
            readFile(path.join(process.cwd(), "wrangler.toml"), "utf8"),
        ]);

        expect(AffectedAreaArtifactWorkflow.name).toBe("AffectedAreaArtifactWorkflow");
        expect(wranglerToml).toContain('binding = "AFFECTED_AREA_ARTIFACT_WORKFLOW"');
        expect(wranglerToml).toContain('name = "sonari-affected-area-artifact-workflow"');
        expect(wranglerToml).toContain('class_name = "AffectedAreaArtifactWorkflow"');
    });
});
