import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(process.cwd(), ".github/workflows/dapp-deploy.yml");

async function readWorkflow(): Promise<string> {
    return readFile(workflowPath, "utf8");
}

describe("dapp deploy workflow", () => {
    it("resolves public Sonari contract ids before the build", async () => {
        const workflow = await readWorkflow();

        expect(workflow).toContain("Resolve Sonari contract ids from Published.toml");
        expect(workflow).toContain("scripts/resolve_published_contract_ids.ts");
        expect(workflow).toContain("SONARI_SUI_NETWORK: $" + "{{ vars.SONARI_SUI_NETWORK }}");
        expect(workflow).toContain("SUI_RPC_URL: $" + "{{ vars.SONARI_SUI_RPC_URL }}");

        const resolverIndex = workflow.indexOf("Resolve Sonari contract ids from Published.toml");
        const deployIndex = workflow.indexOf("Build and deploy to Cloudflare");
        expect(resolverIndex).toBeGreaterThan(-1);
        expect(deployIndex).toBeGreaterThan(resolverIndex);
    });

    it("does not pass contract object ids from GitHub Variables to the dapp build", async () => {
        const workflow = await readWorkflow();

        expect(workflow).not.toContain(
            "NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID: $" + "{{ vars.SONARI_IDENTITY_REGISTRY_ID }}",
        );
        expect(workflow).not.toContain(
            "NEXT_PUBLIC_SONARI_IDENTITY_PAUSE_STATE_ID: $" +
                "{{ vars.SONARI_IDENTITY_PAUSE_STATE_ID }}",
        );
        expect(workflow).not.toContain(
            "NEXT_PUBLIC_SONARI_MEMBERSHIP_REGISTRY_ID: $" +
                "{{ vars.SONARI_MEMBERSHIP_REGISTRY_ID }}",
        );
        expect(workflow).not.toContain(
            "NEXT_PUBLIC_SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID: $" +
                "{{ vars.SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID }}",
        );
    });
});
