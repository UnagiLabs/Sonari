import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildAwsMembershipIdentityTeeArtifact } from "./build_aws_membership_identity_tee_artifact.js";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(
    process.cwd(),
    "scripts/build_aws_membership_identity_tee_artifact.ts",
);
const tempDirs: string[] = [];

describe("AWS membership identity TEE artifact build script", () => {
    afterEach(async () => {
        delete process.env.SONARI_MEMBERSHIP_IDENTITY_TEE_BINARY;
        await Promise.all(
            tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
        );
    });

    it("packages only bin/membership-tee and writes a sha256sum-compatible checksum", async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), "sonari-membership-tee-artifact-"));
        tempDirs.push(tempDir);
        const fakeBinary = path.join(tempDir, "membership-tee");
        const outPath = path.join(tempDir, "membership-identity-tee-artifact.tar.gz");
        await writeFile(fakeBinary, "#!/bin/sh\nexec echo membership-tee\n", { mode: 0o700 });
        process.env.SONARI_MEMBERSHIP_IDENTITY_TEE_BINARY = fakeBinary;

        const result = await buildAwsMembershipIdentityTeeArtifact({ outPath });

        expect(result.artifactPath).toBe(outPath);
        expect(result.checksumPath).toBe(`${outPath}.sha256`);
        const { stdout: tarList } = await execFileAsync("tar", ["-tzf", outPath]);
        expect(tarList.trim().split("\n")).toEqual(["bin/membership-tee"]);
        expect(tarList).not.toContain("walrus");

        const checksum = await readFile(result.checksumPath, "utf8");
        const digest = createHash("sha256")
            .update(await readFile(outPath))
            .digest("hex");
        expect(checksum).toBe(`${digest}  ${outPath}\n`);
        await execFileAsync("sha256sum", ["-c", result.checksumPath], { cwd: "/" });
    });

    it("keeps the membership artifact contract separate from Walrus and earthquake paths", async () => {
        const script = await readFile(scriptPath, "utf8");

        expect(script).toContain("nautilus/verifiers/membership/tee/Cargo.toml");
        expect(script).toContain('const DEFAULT_CARGO_TARGET = "x86_64-unknown-linux-musl"');
        expect(script).toContain("SONARI_MEMBERSHIP_IDENTITY_TEE_CARGO_TARGET");
        expect(script).toContain("SONARI_MEMBERSHIP_IDENTITY_TEE_BINARY");
        expect(script).toContain('"bin/membership-tee"');
        expect(script).not.toContain("SONARI_WALRUS_CLI");
        expect(script).not.toContain('"bin/walrus"');
        expect(script).not.toContain("nautilus/verifiers/earthquake/tee/Cargo.toml");
    });
});
