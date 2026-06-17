import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAwsCensusEifBuildPlan } from "./build_aws_census_eif.js";

const packageJsonPath = path.join(process.cwd(), "package.json");

describe("AWS census EIF build script", () => {
    it("generates deterministic Nitro build and run-enclave commands with the server EIF entrypoint", () => {
        const plan = createAwsCensusEifBuildPlan({
            artifactPath: "dist/aws/census-tee-artifact.tar.gz",
            eifPath: "dist/aws/census-tee.eif",
            workDir: ".build/aws-census-eif",
        });

        expect(plan.artifactPath).toBe(path.resolve("dist/aws/census-tee-artifact.tar.gz"));
        expect(plan.eifPath).toBe(path.resolve("dist/aws/census-tee.eif"));
        expect(plan.dockerContextDir).toBe(path.resolve(".build/aws-census-eif"));
        expect(plan.dockerUri).toBe("sonari/census-tee:local");
        expect(plan.teeCommand).toEqual([
            "/bin/sh",
            "-c",
            "set -e; ip link set lo up || true; /opt/sonari/tee-artifact/bin/vsock-tcp-bridge --listen-host 127.0.0.1 --listen-port 18080 --parent-cid 3 --vsock-port 18080 & exec /opt/sonari/tee-artifact/bin/census-tee server",
        ]);
        expect(plan.buildEnclaveCommand).toEqual([
            "nitro-cli",
            "build-enclave",
            "--docker-uri",
            "sonari/census-tee:local",
            "--docker-dir",
            path.resolve(".build/aws-census-eif"),
            "--output-file",
            path.resolve("dist/aws/census-tee.eif"),
        ]);
        expect(plan.runEnclaveCommand).toEqual([
            "nitro-cli",
            "run-enclave",
            "--cpu-count",
            "2",
            "--memory",
            "1024",
            "--enclave-cid",
            "16",
            "--eif-path",
            path.resolve("dist/aws/census-tee.eif"),
        ]);
    });

    it("documents that the EIF container runs the vsock bridge and census-tee server without Walrus", async () => {
        const script = await readFile(
            path.join(process.cwd(), "scripts/build_aws_census_eif.ts"),
            "utf8",
        );

        expect(script).toContain("/opt/sonari/tee-artifact/bin/census-tee");
        expect(script).toContain("/opt/sonari/tee-artifact/bin/vsock-tcp-bridge");
        expect(script).toContain("--listen-port");
        expect(script).toContain('"18080"');
        expect(script).toContain("server");
        expect(script).toContain("nitro-cli");
        expect(script).toContain("build-enclave");
        expect(script).toContain("run-enclave");
        expect(script).not.toContain("walrus");
    });

    it("installs ca-certificates and iproute in the EIF container", async () => {
        const script = await readFile(
            path.join(process.cwd(), "scripts/build_aws_census_eif.ts"),
            "utf8",
        );

        expect(script).toContain("dnf install -y ca-certificates iproute");
    });

    it("exposes pnpm scripts for artifact and EIF builds", async () => {
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
            scripts?: Record<string, string>;
        };

        expect(packageJson.scripts?.["build:aws-census-tee-artifact"]).toBe(
            "tsx scripts/build_aws_census_tee_artifact.ts",
        );
        expect(packageJson.scripts?.["build:aws-census-eif"]).toBe(
            "tsx scripts/build_aws_census_eif.ts",
        );
    });
});
