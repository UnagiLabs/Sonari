import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAwsMembershipIdentityEifBuildPlan } from "./build_aws_membership_identity_eif.js";

const packageJsonPath = path.join(process.cwd(), "package.json");

describe("AWS membership identity EIF build script", () => {
    it("generates deterministic Nitro build and run-enclave commands with the server EIF entrypoint", () => {
        const plan = createAwsMembershipIdentityEifBuildPlan({
            artifactPath: "dist/aws/membership-identity-tee-artifact.tar.gz",
            eifPath: "dist/aws/membership-identity-tee.eif",
            workDir: ".build/aws-membership-identity-eif",
        });

        expect(plan.artifactPath).toBe(
            path.resolve("dist/aws/membership-identity-tee-artifact.tar.gz"),
        );
        expect(plan.eifPath).toBe(path.resolve("dist/aws/membership-identity-tee.eif"));
        expect(plan.dockerContextDir).toBe(path.resolve(".build/aws-membership-identity-eif"));
        expect(plan.dockerUri).toBe("sonari/membership-identity-tee:local");
        expect(plan.teeCommand).toEqual([
            "/bin/sh",
            "-c",
            "set -e; ip link set lo up || true; /opt/sonari/tee-artifact/bin/vsock-tcp-bridge --listen-host 127.0.0.1 --listen-port 18080 --parent-cid 3 --vsock-port 18080 & exec /opt/sonari/tee-artifact/bin/membership-tee server",
        ]);
        expect(plan.buildEnclaveCommand).toEqual([
            "nitro-cli",
            "build-enclave",
            "--docker-uri",
            "sonari/membership-identity-tee:local",
            "--docker-dir",
            path.resolve(".build/aws-membership-identity-eif"),
            "--output-file",
            path.resolve("dist/aws/membership-identity-tee.eif"),
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
            path.resolve("dist/aws/membership-identity-tee.eif"),
        ]);
    });

    it("rejects legacy stdin/stdout modes for the AWS server EIF builder", async () => {
        const script = await readFile(
            path.join(process.cwd(), "scripts/build_aws_membership_identity_eif.ts"),
            "utf8",
        );

        expect(script).not.toContain("--tee-mode");
        expect(script).not.toContain("--world-id-status");
        expect(script).not.toContain("--world-app-id");
        expect(script).not.toContain('"production"');
        expect(script).not.toContain('"fixture"');
    });

    it("documents that the EIF container runs the vsock bridge and membership-tee server without Walrus", async () => {
        const script = await readFile(
            path.join(process.cwd(), "scripts/build_aws_membership_identity_eif.ts"),
            "utf8",
        );

        expect(script).toContain("/opt/sonari/tee-artifact/bin/membership-tee");
        expect(script).toContain("/opt/sonari/tee-artifact/bin/vsock-tcp-bridge");
        expect(script).toContain("--listen-port");
        expect(script).toContain('"18080"');
        expect(script).toContain("server");
        expect(script).toContain("nitro-cli");
        expect(script).toContain("build-enclave");
        expect(script).toContain("run-enclave");
        expect(script).not.toContain("walrus");
    });

    it("installs ca-certificates and iproute in the EIF container for real World ID egress", async () => {
        const script = await readFile(
            path.join(process.cwd(), "scripts/build_aws_membership_identity_eif.ts"),
            "utf8",
        );

        // ca-certificates は enclave 内 TLS 検証、iproute は loopback を起こして
        // bridge が 127.0.0.1:18080 に bind するために必須（earthquake EIF と同一）。
        expect(script).toContain("dnf install -y ca-certificates iproute");
    });

    it("exposes pnpm scripts for artifact and EIF builds", async () => {
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
            scripts?: Record<string, string>;
        };

        expect(packageJson.scripts?.["build:aws-membership-identity-tee-artifact"]).toBe(
            "tsx scripts/build_aws_membership_identity_tee_artifact.ts",
        );
        expect(packageJson.scripts?.["build:aws-membership-identity-eif"]).toBe(
            "tsx scripts/build_aws_membership_identity_eif.ts",
        );
    });
});
