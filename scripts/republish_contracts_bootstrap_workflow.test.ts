import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(
    process.cwd(),
    ".github/workflows/sonari-contract-republish-bootstrap.yml",
);

async function readWorkflow(): Promise<string> {
    return readFile(workflowPath, "utf8");
}

describe("Sonari contract republish bootstrap workflow", () => {
    it("runs on Published.toml merges to main and keeps manual reruns", async () => {
        const workflow = await readWorkflow();

        expect(workflow).toContain("push:");
        expect(workflow).toContain("branches:");
        expect(workflow).toContain("- main");
        expect(workflow).toContain("paths:");
        expect(workflow).toContain("- contracts/Published.toml");
        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).toContain("network:");
        expect(workflow).toContain("runs-on: [self-hosted, linux, x64, manji]");
        expect(workflow).toContain(
            "SONARI_DEV_ADMIN_PRIVATE_KEY: $" + "{{ secrets.SONARI_DEV_ADMIN_PRIVATE_KEY }}",
        );
        expect(workflow).toContain('echo "::add-mask::$' + '{SONARI_DEV_ADMIN_PRIVATE_KEY}"');
        expect(workflow).toContain("contents: read");
        expect(workflow).not.toContain("ubuntu-latest");
        expect(workflow).not.toContain("pull_request:");
    });

    it("uses Published.toml, Sui events, and repo variables for the admin root update", async () => {
        const workflow = await readWorkflow();

        expect(workflow).toContain("Resolve Sonari contract ids from Published.toml");
        expect(workflow).toContain("scripts/resolve_published_contract_ids.ts");
        expect(workflow).toContain("SONARI_RESIDENCE_ROOT: $" + "{{ vars.SONARI_RESIDENCE_ROOT }}");
        expect(workflow).toContain(
            "SONARI_RESIDENCE_SOURCE_HASH: $" + "{{ vars.SONARI_RESIDENCE_SOURCE_HASH }}",
        );
        expect(workflow).toContain("SONARI_GEO_RESOLUTION: $" + "{{ vars.SONARI_GEO_RESOLUTION }}");
        expect(workflow).toContain('SONARI_RESIDENCE_ALLOWLIST_VERSION: "1"');
        expect(workflow).toContain("Validate residence root update inputs");
        expect(workflow).toContain("SONARI_RESIDENCE_ROOT must be 32-byte 0x-prefixed hex");
        expect(workflow).toContain("SONARI_RESIDENCE_SOURCE_HASH must be 32-byte 0x-prefixed hex");
        expect(workflow).toContain("SONARI_GEO_RESOLUTION must be an integer");
        expect(workflow).toContain("SONARI_RESIDENCE_ALLOWLIST_VERSION must be an integer");
        expect(workflow).toContain("--function update_allowed_residence_cell_root");
        expect(workflow).toContain("$SONARI_IDENTITY_PACKAGE_ID");
        expect(workflow).toContain("$SONARI_ADMIN_CAP_ID");
        expect(workflow).toContain("$SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID");
        expect(workflow).toContain("AllowedResidenceCellRootUpdated");
    });

    it("does not publish, rewrite Published.toml, commit, or read Cloudflare state", async () => {
        const workflow = await readWorkflow();

        expect(workflow).not.toContain("republish:bootstrap");
        expect(workflow).not.toContain("sui client publish");
        expect(workflow).not.toContain("Verify Published.toml changed");
        expect(workflow).not.toContain("commit_published_toml:");
        expect(workflow).not.toContain("git add contracts/Published.toml");
        expect(workflow).not.toContain("git commit");
        expect(workflow).not.toContain("git push");
        expect(workflow.toLowerCase()).not.toContain("cloudflare");
        expect(workflow).not.toContain("wrangler");
    });
});
