import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildAwsCensusTeeArtifact } from "./build_aws_census_tee_artifact.js";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts/build_aws_census_tee_artifact.ts");
const tempDirs: string[] = [];

describe("AWS census TEE artifact build script", () => {
    afterEach(async () => {
        delete process.env.SONARI_CENSUS_TEE_BINARY;
        delete process.env.SONARI_CENSUS_VSOCK_TCP_BRIDGE_BINARY;
        await Promise.all(
            tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
        );
    });

    it("packages bin/census-tee plus the vsock bridge and writes a sha256sum-compatible checksum", async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), "sonari-census-tee-artifact-"));
        tempDirs.push(tempDir);
        const fakeBinary = path.join(tempDir, "census-tee");
        const fakeBridgeBinary = path.join(tempDir, "vsock-tcp-bridge");
        const outPath = path.join(tempDir, "census-tee-artifact.tar.gz");
        await writeFile(fakeBinary, "#!/bin/sh\nexec echo census-tee\n", { mode: 0o700 });
        await writeFile(fakeBridgeBinary, "#!/bin/sh\nexec echo vsock-tcp-bridge\n", {
            mode: 0o700,
        });
        process.env.SONARI_CENSUS_TEE_BINARY = fakeBinary;
        process.env.SONARI_CENSUS_VSOCK_TCP_BRIDGE_BINARY = fakeBridgeBinary;

        const result = await buildAwsCensusTeeArtifact({ outPath });

        expect(result.artifactPath).toBe(outPath);
        expect(result.checksumPath).toBe(`${outPath}.sha256`);
        const { stdout: tarList } = await execFileAsync("tar", ["-tzf", outPath]);
        expect(tarList.trim().split("\n")).toEqual(["bin/census-tee", "bin/vsock-tcp-bridge"]);
        expect(tarList).not.toContain("walrus");

        const checksum = await readFile(result.checksumPath, "utf8");
        const digest = createHash("sha256")
            .update(await readFile(outPath))
            .digest("hex");
        expect(checksum).toBe(`${digest}  ${outPath}\n`);
        await execFileAsync("sha256sum", ["-c", result.checksumPath], { cwd: "/" });
    });

    it("keeps the census artifact contract separate from Walrus and earthquake paths", async () => {
        const script = await readFile(scriptPath, "utf8");

        expect(script).toContain("nautilus/verifiers/census/tee/Cargo.toml");
        expect(script).toContain('const DEFAULT_CARGO_TARGET = "x86_64-unknown-linux-musl"');
        expect(script).toContain("SONARI_CENSUS_TEE_CARGO_TARGET");
        expect(script).toContain("SONARI_CENSUS_TEE_BINARY");
        expect(script).toContain("SONARI_CENSUS_VSOCK_TCP_BRIDGE_BINARY");
        expect(script).toContain('"bin/census-tee"');
        expect(script).toContain('"bin/vsock-tcp-bridge"');
        expect(script).not.toContain("SONARI_WALRUS_CLI");
        expect(script).not.toContain('"bin/walrus"');
        expect(script).not.toContain("nautilus/verifiers/earthquake/tee/Cargo.toml");
    });
});
