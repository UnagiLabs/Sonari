import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(
    process.cwd(),
    ".github/workflows/affected-cells-proof-worker-deploy.yml",
);
const wranglerPath = path.join(process.cwd(), "packages/affected-cells-proof-worker/wrangler.toml");

describe("affected cells proof worker deploy workflow", () => {
    it("injects affected-area base URL into the Cloudflare worker deploy", async () => {
        const workflow = await readFile(workflowPath, "utf8");

        expect(workflow).toContain(
            "SONARI_AFFECTED_AREA_BASE_URL: $" + "{{ vars.SONARI_AFFECTED_AREA_BASE_URL }}",
        );
        expect(workflow).toContain(
            "Missing required GitHub variable: SONARI_AFFECTED_AREA_BASE_URL",
        );
        expect(workflow).toContain(
            "--var SONARI_AFFECTED_AREA_BASE_URL:$" + "{{ vars.SONARI_AFFECTED_AREA_BASE_URL }}",
        );
    });

    it("binds a dedicated R2 bucket and workflow for affected-area artifacts", async () => {
        const wrangler = await readFile(wranglerPath, "utf8");

        expect(wrangler).toContain('binding = "AFFECTED_AREA_ARTIFACTS"');
        expect(wrangler).toContain('bucket_name = "sonari-affected-area-tiles-v1"');
        expect(wrangler).toContain('binding = "AFFECTED_AREA_ARTIFACT_WORKFLOW"');
        expect(wrangler).toContain('class_name = "AffectedAreaArtifactWorkflow"');
    });
});
