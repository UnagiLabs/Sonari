import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAwsEarthquakeEifBuildPlan } from "./build_aws_earthquake_eif.js";

const packageJsonPath = path.join(process.cwd(), "package.json");

describe("AWS earthquake EIF build script", () => {
    it("generates deterministic Nitro build and run-enclave commands", () => {
        const plan = createAwsEarthquakeEifBuildPlan({
            artifactPath: "dist/aws/earthquake-tee-artifact.tar.gz",
            eifPath: "dist/aws/earthquake-tee.eif",
            workDir: ".build/aws-earthquake-eif",
        });

        expect(plan.artifactPath).toBe(path.resolve("dist/aws/earthquake-tee-artifact.tar.gz"));
        expect(plan.eifPath).toBe(path.resolve("dist/aws/earthquake-tee.eif"));
        expect(plan.dockerContextDir).toBe(path.resolve(".build/aws-earthquake-eif"));
        expect(plan.dockerUri).toBe("sonari/earthquake-tee:local");
        expect(plan.teeCommand).toEqual([
            "/bin/sh",
            "-c",
            "set -e; ip link set lo up || true; /opt/sonari/tee-artifact/bin/vsock-tcp-bridge --listen-host 127.0.0.1 --listen-port 18080 --parent-cid 3 --vsock-port 18080 & exec /opt/sonari/tee-artifact/bin/tee server",
        ]);
        expect(plan.buildEnclaveCommand).toEqual([
            "nitro-cli",
            "build-enclave",
            "--docker-uri",
            "sonari/earthquake-tee:local",
            "--docker-dir",
            path.resolve(".build/aws-earthquake-eif"),
            "--output-file",
            path.resolve("dist/aws/earthquake-tee.eif"),
        ]);
        expect(plan.runEnclaveCommand).toEqual([
            "nitro-cli",
            "run-enclave",
            "--cpu-count",
            "2",
            "--memory",
            "4096",
            "--enclave-cid",
            "16",
            "--eif-path",
            path.resolve("dist/aws/earthquake-tee.eif"),
        ]);
    });

    it("exposes a pnpm script for the EIF build", async () => {
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
            scripts?: Record<string, string>;
        };

        expect(packageJson.scripts?.["build:aws-earthquake-eif"]).toBe(
            "tsx scripts/build_aws_earthquake_eif.ts",
        );
    });

    it("installs CA certificates for HTTPS source fetches inside the EIF", async () => {
        const script = await readFile(
            path.join(process.cwd(), "scripts/build_aws_earthquake_eif.ts"),
            "utf8",
        );

        expect(script).toContain("ca-certificates");
        expect(script).toContain("iproute");
    });
});
