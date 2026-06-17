import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(process.cwd(), ".github/workflows/dapp-deploy.yml");
const dappEnvExamplePath = path.join(process.cwd(), "dapp/.env.example");
const dappReadmePath = path.join(process.cwd(), "dapp/README.md");
const dappWranglerPath = path.join(process.cwd(), "dapp/wrangler.jsonc");
const dappDevVarsExamplePath = path.join(process.cwd(), "dapp/.dev.vars.example");

async function readWorkflow(): Promise<string> {
    return readFile(workflowPath, "utf8");
}

async function readDappEnvExample(): Promise<string> {
    return readFile(dappEnvExamplePath, "utf8");
}

async function readDappReadme(): Promise<string> {
    return readFile(dappReadmePath, "utf8");
}

async function readDappWrangler(): Promise<string> {
    return readFile(dappWranglerPath, "utf8");
}

async function readDappDevVarsExample(): Promise<string> {
    return readFile(dappDevVarsExamplePath, "utf8");
}

function stepBlock(workflow: string, stepName: string): string {
    const start = workflow.indexOf(`- name: ${stepName}`);
    expect(start).toBeGreaterThan(-1);

    const next = workflow.indexOf("\n      - name: ", start + 1);
    return next === -1 ? workflow.slice(start) : workflow.slice(start, next);
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
        expect(workflow).not.toContain(
            "NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID: $" + "{{ vars.SONARI_FUNDING_PACKAGE_ID }}",
        );
    });

    it("passes affected-area R2 base URL to the dapp build", async () => {
        const workflow = await readWorkflow();

        expect(workflow).toContain(
            "NEXT_PUBLIC_SONARI_AFFECTED_AREA_BASE_URL: $" +
                "{{ vars.SONARI_AFFECTED_AREA_BASE_URL }}",
        );
    });

    it("passes Enoki public configuration to the dapp build", async () => {
        const workflow = await readWorkflow();
        const deployStep = stepBlock(workflow, "Build and deploy to Cloudflare");

        expect(deployStep).toContain(
            "NEXT_PUBLIC_ENOKI_API_KEY: $" + "{{ vars.NEXT_PUBLIC_ENOKI_API_KEY }}",
        );
        expect(deployStep).toContain(
            "NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID: $" +
                "{{ vars.NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID }}",
        );
        expect(workflow).not.toContain("NEXT_PUBLIC_ENOKI_NETWORK");
        expect(deployStep).toContain("SONARI_SUI_NETWORK: $" + "{{ vars.SONARI_SUI_NETWORK }}");
        expect(deployStep).toContain(
            "NEXT_PUBLIC_SUI_NETWORK: $" + "{{ vars.SONARI_SUI_NETWORK }}",
        );
        expect(deployStep).not.toContain("ENOKI_PRIVATE_API_KEY");
    });

    it("syncs Enoki private key from GitHub Environment Secret to Cloudflare runtime secret", async () => {
        const workflow = await readWorkflow();
        const syncStep = stepBlock(workflow, "Sync Enoki private API key to Cloudflare secret");
        const deployStep = stepBlock(workflow, "Build and deploy to Cloudflare");

        expect(workflow).toContain(
            "ENOKI_PRIVATE_API_KEY: $" + "{{ secrets.ENOKI_PRIVATE_API_KEY }}",
        );
        expect(syncStep).toContain(
            "CLOUDFLARE_API_TOKEN: $" + "{{ secrets.CLOUDFLARE_API_TOKEN }}",
        );
        expect(syncStep).toContain(
            "CLOUDFLARE_ACCOUNT_ID: $" + "{{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
        );
        expect(syncStep).toContain(
            "ENOKI_PRIVATE_API_KEY: $" + "{{ secrets.ENOKI_PRIVATE_API_KEY }}",
        );
        expect(syncStep).toContain(
            "Missing required GitHub Environment secret: ENOKI_PRIVATE_API_KEY",
        );
        expect(syncStep).toContain(
            "printf '%s' \"$ENOKI_PRIVATE_API_KEY\" | pnpm --filter @sonari/dapp exec wrangler secret put ENOKI_PRIVATE_API_KEY --name sonari-dapp",
        );

        expect(workflow.indexOf("Sync Enoki private API key to Cloudflare secret")).toBeGreaterThan(
            -1,
        );
        expect(workflow.indexOf("Build and deploy to Cloudflare")).toBeGreaterThan(
            workflow.indexOf("Sync Enoki private API key to Cloudflare secret"),
        );
        expect(deployStep).not.toContain("ENOKI_PRIVATE_API_KEY");
    });
});

describe("dapp env example", () => {
    it("documents Enoki public configuration without client secrets", async () => {
        const envExample = await readDappEnvExample();

        expect(envExample).toContain("NEXT_PUBLIC_ENOKI_API_KEY=");
        expect(envExample).toContain("NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID=");
        expect(envExample).toContain("SONARI_SUI_NETWORK=testnet");
        expect(envExample).toContain("NEXT_PUBLIC_SUI_NETWORK=testnet");
        expect(envExample).toContain("Enoki / zkLogin もこの値を共有");
        expect(envExample).not.toContain("NEXT_PUBLIC_ENOKI_NETWORK");
        expect(envExample).not.toContain("ENOKI_PRIVATE_API_KEY=");
    });
});

describe("dapp Enoki setup docs", () => {
    it("documents Google OAuth and Enoki allowed origins", async () => {
        const readme = await readDappReadme();

        expect(readme).toContain("Google OAuth Client ID");
        expect(readme).toContain("authorized JavaScript origins");
        expect(readme).toContain("authorized redirect URIs");
        expect(readme).toContain("Enoki Portal");
        expect(readme).toContain("Google provider");
        expect(readme).toContain("http://localhost:3000");
        expect(readme).toContain("http://localhost:3000/");
        expect(readme).toContain("https://sonari.help");
        expect(readme).toContain("https://sonari.help/");
        expect(readme).toContain("NEXT_PUBLIC_ENOKI_API_KEY");
        expect(readme).toContain("NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID");
        expect(readme).toContain("NEXT_PUBLIC_SUI_NETWORK");
        expect(readme).toContain("Enoki uses the shared `NEXT_PUBLIC_SUI_NETWORK` value");
        expect(readme).not.toContain("NEXT_PUBLIC_ENOKI_NETWORK");
    });

    it("documents Enoki private key as server-only secret", async () => {
        const readme = await readDappReadme();
        const wrangler = await readDappWrangler();
        const devVarsExample = await readDappDevVarsExample();

        expect(readme).toContain("POST /api/enoki/membership/sponsor");
        expect(readme).toContain("POST /api/enoki/membership/execute");
        expect(readme).toContain(
            'gh secret set ENOKI_PRIVATE_API_KEY -R UnagiLabs/Sonari -e cloudflare-dapp-worker --body "<ENOKI_PRIVATE_API_KEY>"',
        );
        expect(readme).toContain("GitHub Environment Secret");
        expect(readme).toContain("Cloudflare Worker runtime secret");
        expect(readme).toContain("NEXT_PUBLIC_* に secret を置かない");
        expect(readme).toContain("MembershipPass 発行専用");
        expect(readme).toContain("ENOKI_PRIVATE_API_KEY");
        expect(wrangler).toContain("ENOKI_PRIVATE_API_KEY");
        expect(wrangler).toContain("dapp deploy workflow");
        expect(wrangler).toContain("GitHub Environment Secret");
        expect(devVarsExample).toContain("ENOKI_PRIVATE_API_KEY=");
        expect(devVarsExample).toContain("/api/enoki/membership/sponsor");
        expect(devVarsExample).toContain("/api/enoki/membership/execute");
        expect(devVarsExample).toContain("GitHub Environment Secret");
        expect(devVarsExample).toContain("NEXT_PUBLIC_ は付けません");
    });
});
