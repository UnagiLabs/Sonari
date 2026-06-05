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
        expect(plan.teeCommand).toEqual(["/opt/sonari/tee-artifact/bin/membership-tee", "server"]);
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

    it("can build a non-mainnet dummy World ID EIF with the fixture verifier", () => {
        const plan = createAwsMembershipIdentityEifBuildPlan({
            artifactPath: "dist/aws/membership-identity-tee-artifact.tar.gz",
            eifPath: "dist/aws/membership-identity-tee-dummy.eif",
            workDir: ".build/aws-membership-identity-eif-dummy",
            teeMode: "fixture",
            worldIdStatus: "verified",
            worldAppId: "app_staging_dummy",
        });

        expect(plan.teeCommand).toEqual([
            "/opt/sonari/tee-artifact/bin/membership-tee",
            "fixture",
            "--world-id-status",
            "verified",
            "--world-app-id",
            "app_staging_dummy",
        ]);
    });

    it("can still build an explicit legacy local production EIF", () => {
        const plan = createAwsMembershipIdentityEifBuildPlan({
            teeMode: "production",
        });

        expect(plan.teeCommand).toEqual([
            "/opt/sonari/tee-artifact/bin/membership-tee",
            "production",
        ]);
    });

    it("documents that the EIF container runs membership-tee entrypoints without Walrus", async () => {
        const script = await readFile(
            path.join(process.cwd(), "scripts/build_aws_membership_identity_eif.ts"),
            "utf8",
        );

        expect(script).toContain('"/opt/sonari/tee-artifact/bin/membership-tee"');
        expect(script).toContain('"server"');
        expect(script).toContain('"production"');
        expect(script).toContain("nitro-cli");
        expect(script).toContain("build-enclave");
        expect(script).toContain("run-enclave");
        expect(script).not.toContain("walrus");
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
