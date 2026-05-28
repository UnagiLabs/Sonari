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

    it("creates sanitized rollback JSON from previous stack parameters", () => {
        const plan = buildAwsEarthquakeRunnerDeployPlan({
            commitSha: validCommitSha,
            lambdaBucket: "lambda-artifacts",
            teeBucket: "tee-artifacts",
            teeArtifactSha256: validTeeSha256,
            existingStack: {
                Parameters: [
                    {
                        ParameterKey: "GitCommitSha",
                        ParameterValue: "fedcba9876543210fedcba9876543210fedcba98",
                    },
                    {
                        ParameterKey: "LambdaCodeS3Key",
                        ParameterValue: "earthquake-runner/old/earthquake-runner-lambda.zip",
                    },
                    {
                        ParameterKey: "TeeArtifactS3Key",
                        ParameterValue: "earthquake-runner/old/earthquake-tee-artifact.tar.gz",
                    },
                    { ParameterKey: "TeeArtifactSha256", ParameterValue: "b".repeat(64) },
                    {
                        ParameterKey: "RunnerTokenSecretArn",
                        ParameterValue:
                            "arn:aws:secretsmanager:us-east-1:123456789012:secret:runner-token",
                    },
                    {
                        ParameterKey: "SuiKeystoreSecretArn",
                        ParameterValue:
                            "arn:aws:secretsmanager:us-east-1:123456789012:secret:sui-keystore",
                    },
                    {
                        ParameterKey: "WalrusConfigPath",
                        ParameterValue:
                            "infra/aws/earthquake-runner/.local/walrus-client-config.yaml",
                    },
                    { ParameterKey: "ScheduleState", ParameterValue: "ENABLED" },
                ],
            },
        });

        expect(plan.rollback).toEqual({
            GitCommitSha: "fedcba9876543210fedcba9876543210fedcba98",
            LambdaCodeS3Key: "earthquake-runner/old/earthquake-runner-lambda.zip",
            TeeArtifactS3Key: "earthquake-runner/old/earthquake-tee-artifact.tar.gz",
            TeeArtifactSha256: "b".repeat(64),
        });
        expect(JSON.stringify(plan.rollback)).not.toContain("secret");
        expect(JSON.stringify(plan.rollback)).not.toContain(".local");
        expect(JSON.stringify(plan.rollback)).not.toContain("ScheduleState");
    });

    it("creates rollback JSON from AWS describe-stacks outputs", () => {
        const plan = buildAwsEarthquakeRunnerDeployPlan({
            commitSha: validCommitSha,
            lambdaBucket: "lambda-artifacts",
            teeBucket: "tee-artifacts",
            teeArtifactSha256: validTeeSha256,
            existingStack: {
                Stacks: [
                    {
                        Outputs: [
                            {
                                OutputKey: "DeployedGitCommitSha",
                                OutputValue: "fedcba9876543210fedcba9876543210fedcba98",
                            },
                            {
                                OutputKey: "LambdaCodeS3KeyOutput",
                                OutputValue: "earthquake-runner/old/earthquake-runner-lambda.zip",
                            },
                            {
                                OutputKey: "TeeArtifactS3KeyOutput",
                                OutputValue: "earthquake-runner/old/earthquake-tee-artifact.tar.gz",
                            },
                            { OutputKey: "TeeArtifactSha256Output", OutputValue: "b".repeat(64) },
                            {
                                OutputKey: "RunnerAutoScalingGroupName",
                                OutputValue: "runner-asg",
                            },
                        ],
                    },
                ],
            },
        });

        expect(plan.rollback).toEqual({
            GitCommitSha: "fedcba9876543210fedcba9876543210fedcba98",
            LambdaCodeS3Key: "earthquake-runner/old/earthquake-runner-lambda.zip",
            TeeArtifactS3Key: "earthquake-runner/old/earthquake-tee-artifact.tar.gz",
            TeeArtifactSha256: "b".repeat(64),
        });
    });
});
