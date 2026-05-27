import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.join(process.cwd(), "scripts/build_aws_earthquake_tee_artifact.ts");

describe("AWS earthquake TEE artifact build script", () => {
    it("packages the Walrus CLI next to the TEE binary", async () => {
        const script = await readFile(scriptPath, "utf8");

        expect(script).toContain('path.join(workDir, "bin/walrus")');
        expect(script).toContain('process.env.SONARI_WALRUS_CLI ?? "walrus"');
        expect(script).toContain('const DEFAULT_CARGO_TARGET = "x86_64-unknown-linux-musl"');
        expect(script).toContain("process.env.SONARI_TEE_CARGO_TARGET ?? DEFAULT_CARGO_TARGET");
        expect(script).toContain("process.env.SONARI_TEE_BINARY");
        expect(script).toContain('"bin/tee"');
        expect(script).toContain('"bin/walrus"');
    });
});
