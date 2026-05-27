import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.join(process.cwd(), "scripts/build_aws_earthquake_tee_artifact.ts");

describe("AWS earthquake TEE artifact build script", () => {
    it("packages the Walrus CLI next to the TEE binary", async () => {
        const script = await readFile(scriptPath, "utf8");

        expect(script).toContain('path.join(workDir, "bin/walrus")');
        expect(script).toContain('process.env.SONARI_WALRUS_CLI ?? "walrus"');
        expect(script).toContain('"bin/tee"');
        expect(script).toContain('"bin/walrus"');
    });
});
