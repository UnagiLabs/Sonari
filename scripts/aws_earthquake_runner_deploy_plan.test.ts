import { describe, expect, it } from "vitest";
import { buildAwsEarthquakeRunnerDeployPlan } from "./aws_earthquake_runner_deploy_plan.js";

const validCommitSha = "0123456789abcdef0123456789abcdef01234567";
const validTeeSha256 = "a".repeat(64);

describe("AWS earthquake runner deploy plan", () => {
    it("fails closed when the commit SHA is not a full Git commit SHA", () => {
        expect(() =>
            buildAwsEarthquakeRunnerDeployPlan({
                commitSha: "main",
                lambdaBucket: "lambda-artifacts",
                teeBucket: "tee-artifacts",
                teeArtifactSha256: validTeeSha256,
            }),
        ).toThrow("Invalid commit SHA");
    });

    it("builds commit-scoped Lambda and TEE S3 keys", () => {
        const plan = buildAwsEarthquakeRunnerDeployPlan({
            commitSha: validCommitSha,
            lambdaBucket: "lambda-artifacts",
            teeBucket: "tee-artifacts",
            teeArtifactSha256: validTeeSha256,
        });

        expect(plan.parameterOverrides.LambdaCodeS3Key).toBe(
            `earthquake-runner/${validCommitSha}/earthquake-runner-lambda.zip`,
        );
        expect(plan.parameterOverrides.TeeArtifactS3Key).toBe(
            `earthquake-runner/${validCommitSha}/earthquake-tee-artifact.tar.gz`,
        );
        expect(plan.parameterOverrides.GitCommitSha).toBe(validCommitSha);
        expect(plan.parameterOverrides.TeeArtifactSha256).toBe(validTeeSha256);
    });

    it("keeps scheduled production execution disabled for dev deploys", () => {
        const plan = buildAwsEarthquakeRunnerDeployPlan({
            commitSha: validCommitSha,
            lambdaBucket: "lambda-artifacts",
            teeBucket: "tee-artifacts",
            teeArtifactSha256: validTeeSha256,
        });

        expect(plan.parameterOverrides.ScheduleState).toBe("DISABLED");
    });

    it("does not expose rollback outputs or existing stack inputs", () => {
        const plan = buildAwsEarthquakeRunnerDeployPlan({
            commitSha: validCommitSha,
            lambdaBucket: "lambda-artifacts",
            teeBucket: "tee-artifacts",
            teeArtifactSha256: validTeeSha256,
        });

        expect(Object.keys(plan)).toEqual(["parameterOverrides", "parameterOverrideArgs"]);
        expect(JSON.stringify(plan)).not.toContain("rollback");
        expect(JSON.stringify(plan)).not.toContain("existingStack");
    });
});
