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
    it("runs manually on the manji self-hosted runner with the admin key masked", async () => {
        const workflow = await readWorkflow();

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).toContain("runs-on: [self-hosted, linux, x64, manji]");
        expect(workflow).toContain(
            "SONARI_DEV_ADMIN_PRIVATE_KEY: $" + "{{ secrets.SONARI_DEV_ADMIN_PRIVATE_KEY }}",
        );
        expect(workflow).toContain('echo "::add-mask::$' + '{SONARI_DEV_ADMIN_PRIVATE_KEY}"');
        expect(workflow).not.toContain("ubuntu-latest");
        expect(workflow).not.toContain("pull_request:");
    });

    it("publishes and updates the AllowedResidenceCellRegistry root in one action", async () => {
        const workflow = await readWorkflow();

        expect(workflow).toContain("pnpm run republish:bootstrap --");
        expect(workflow).toContain("--live");
        expect(workflow).toContain("--residence-root");
        expect(workflow).toContain("--geo-resolution 7");
        expect(workflow).toContain("--source-hash");
        expect(workflow).toContain("Verify Published.toml changed");
    });

    it("can commit Published.toml from the workflow when explicitly requested", async () => {
        const workflow = await readWorkflow();

        expect(workflow).toContain("commit_published_toml:");
        expect(workflow).toContain("if: $" + "{{ inputs.commit_published_toml }}");
        expect(workflow).toContain("git add contracts/Published.toml");
        expect(workflow).toContain("git push");
    });
});
