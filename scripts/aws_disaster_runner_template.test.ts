import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const templatePath = path.join(process.cwd(), "infra/aws/disaster-runner/template.yaml");

describe("AWS disaster runner CloudFormation template", () => {
    it("starts the runner service during instance bootstrap", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("systemctl enable --now sonari-disaster-runner.service");
    });

    it("makes runner secret files readable by ec2-user only", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain(
            "chown ec2-user:ec2-user /opt/sonari/runner-token /opt/sonari/tee-signing-key /opt/sonari/walrus-config.json",
        );
        expect(template).toContain(
            "chmod 0400 /opt/sonari/runner-token /opt/sonari/tee-signing-key /opt/sonari/walrus-config.json",
        );
    });

    it("injects production runner command and Walrus aggregator configuration", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("NitroEnclaveProcessCommand:");
        expect(template).toContain("WalrusAggregatorUrl:");
        expect(template).toContain(
            `NITRO_ENCLAVE_PROCESS_COMMAND=$${"{NitroEnclaveProcessCommand}"}`,
        );
        expect(template).toContain(`SONARI_WALRUS_AGGREGATOR_URL=$${"{WalrusAggregatorUrl}"}`);
    });
});
