import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildAwsSonariVerifierRunnerDeployPlan } from "./aws_sonari_verifier_runner_deploy_plan.js";

const execFileAsync = promisify(execFile);
const validCommitSha = "0123456789abcdef0123456789abcdef01234567";
const validEarthquakeTeeSha256 = "a".repeat(64);
const validEarthquakeEifSha256 = "b".repeat(64);
const validMembershipTeeSha256 = "c".repeat(64);
const validMembershipEifSha256 = "d".repeat(64);
const validCensusTeeSha256 = "e".repeat(64);
const validCensusEifSha256 = "f".repeat(64);

const validInput = {
    commitSha: validCommitSha,
    lambdaBucket: "lambda-artifacts",
    earthquakeTeeBucket: "earthquake-tee-artifacts",
    earthquakeTeeArtifactSha256: validEarthquakeTeeSha256,
    earthquakeEifBucket: "earthquake-eif-artifacts",
    earthquakeEifSha256: validEarthquakeEifSha256,
    membershipTeeBucket: "membership-tee-artifacts",
    membershipTeeArtifactSha256: validMembershipTeeSha256,
    membershipEifBucket: "membership-eif-artifacts",
    membershipEifSha256: validMembershipEifSha256,
    censusTeeBucket: "census-tee-artifacts",
    censusTeeArtifactSha256: validCensusTeeSha256,
    censusEifBucket: "census-eif-artifacts",
    censusEifSha256: validCensusEifSha256,
    sourceArchiverTokenSecretArn:
        "arn:aws:secretsmanager:ap-northeast-1:595103996064:secret:source-archiver-token",
    sourceArchiverPrivateKeySecretArn:
        "arn:aws:secretsmanager:ap-northeast-1:595103996064:secret:source-archiver-private-key",
    relayerNetwork: "testnet",
    worldIdProofMode: "dummy",
} as const;

describe("AWS Sonari verifier runner deploy plan", () => {
    it("fails closed when the commit SHA is not a full Git commit SHA", () => {
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                commitSha: "main",
            }),
        ).toThrow("Invalid commit SHA");
    });

    it("builds commit-scoped S3 keys for all artifacts", () => {
        const plan = buildAwsSonariVerifierRunnerDeployPlan(validInput);

        expect(plan.parameterOverrides.LambdaCodeS3Key).toBe(
            `sonari-verifier-runner/${validCommitSha}/sonari-verifier-runner-lambda.zip`,
        );
        expect(plan.parameterOverrides.TeeArtifactS3Key).toBe(
            `sonari-verifier-runner/${validCommitSha}/earthquake-tee-artifact.tar.gz`,
        );
        expect(plan.parameterOverrides.MembershipTeeArtifactS3Key).toBe(
            `sonari-verifier-runner/${validCommitSha}/membership-identity-tee-artifact.tar.gz`,
        );
        expect(plan.parameterOverrides.EarthquakeTeeEifS3Key).toBe(
            `sonari-verifier-runner/${validCommitSha}/earthquake-tee.eif`,
        );
        expect(plan.parameterOverrides.TeeEifS3Key).toBe(
            `sonari-verifier-runner/${validCommitSha}/membership-identity-tee.eif`,
        );
        expect(plan.parameterOverrides.CensusTeeArtifactS3Key).toBe(
            `sonari-verifier-runner/${validCommitSha}/census-tee-artifact.tar.gz`,
        );
        expect(plan.parameterOverrides.CensusTeeEifS3Key).toBe(
            `sonari-verifier-runner/${validCommitSha}/census-tee.eif`,
        );
        expect(plan.parameterOverrides.GitCommitSha).toBe(validCommitSha);
    });

    it("validates every artifact SHA-256 value", () => {
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                earthquakeTeeArtifactSha256: "not-a-sha",
            }),
        ).toThrow("Invalid earthquake TEE artifact SHA-256");
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                earthquakeEifSha256: "not-a-sha",
            }),
        ).toThrow("Invalid earthquake EIF SHA-256");
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                membershipTeeArtifactSha256: "not-a-sha",
            }),
        ).toThrow("Invalid membership TEE artifact SHA-256");
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                membershipEifSha256: "not-a-sha",
            }),
        ).toThrow("Invalid membership EIF SHA-256");
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                censusTeeArtifactSha256: "not-a-sha",
            }),
        ).toThrow("Invalid census TEE artifact SHA-256");
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                censusEifSha256: "not-a-sha",
            }),
        ).toThrow("Invalid census EIF SHA-256");
    });

    it("validates source archiver deployment ARNs", () => {
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                sourceArchiverTokenSecretArn: "not-an-arn",
            }),
        ).toThrow("Invalid source archiver token secret ARN");
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                sourceArchiverPrivateKeySecretArn: "not-an-arn",
            }),
        ).toThrow("Invalid source archiver private key secret ARN");
    });

    it("keeps schedules disabled and emits CloudFormation parameter override args", () => {
        const plan = buildAwsSonariVerifierRunnerDeployPlan(validInput);

        expect(plan.parameterOverrides.ScheduleState).toBe("DISABLED");
        expect(plan.parameterOverrideArgs).toEqual(
            expect.arrayContaining([
                `LambdaCodeS3Bucket=${validInput.lambdaBucket}`,
                [
                    "LambdaCodeS3Key=sonari-verifier-runner",
                    `${validCommitSha}/sonari-verifier-runner-lambda.zip`,
                ].join("/"),
                `TeeArtifactS3Bucket=${validInput.earthquakeTeeBucket}`,
                [
                    "TeeArtifactS3Key=sonari-verifier-runner",
                    `${validCommitSha}/earthquake-tee-artifact.tar.gz`,
                ].join("/"),
                `TeeArtifactSha256=${validEarthquakeTeeSha256}`,
                `EarthquakeTeeEifS3Bucket=${validInput.earthquakeEifBucket}`,
                `EarthquakeTeeEifS3Key=sonari-verifier-runner/${validCommitSha}/earthquake-tee.eif`,
                `EarthquakeTeeEifSha256=${validEarthquakeEifSha256}`,
                `MembershipTeeArtifactS3Bucket=${validInput.membershipTeeBucket}`,
                [
                    "MembershipTeeArtifactS3Key=sonari-verifier-runner",
                    `${validCommitSha}/membership-identity-tee-artifact.tar.gz`,
                ].join("/"),
                `MembershipTeeArtifactSha256=${validMembershipTeeSha256}`,
                `TeeEifS3Bucket=${validInput.membershipEifBucket}`,
                `TeeEifS3Key=sonari-verifier-runner/${validCommitSha}/membership-identity-tee.eif`,
                `TeeEifSha256=${validMembershipEifSha256}`,
                `CensusTeeArtifactS3Bucket=${validInput.censusTeeBucket}`,
                [
                    "CensusTeeArtifactS3Key=sonari-verifier-runner",
                    `${validCommitSha}/census-tee-artifact.tar.gz`,
                ].join("/"),
                `CensusTeeArtifactSha256=${validCensusTeeSha256}`,
                `CensusTeeEifS3Bucket=${validInput.censusEifBucket}`,
                `CensusTeeEifS3Key=sonari-verifier-runner/${validCommitSha}/census-tee.eif`,
                `CensusTeeEifSha256=${validCensusEifSha256}`,
                `GitCommitSha=${validCommitSha}`,
                "ScheduleState=DISABLED",
                "WorldIdProofMode=dummy",
                "WorldIdAction=sonari_membership_register_v2",
                `SourceArchiverTokenSecretArn=${validInput.sourceArchiverTokenSecretArn}`,
                `SourceArchiverPrivateKeySecretArn=${validInput.sourceArchiverPrivateKeySecretArn}`,
                "SourceArchiverSuiNetwork=testnet",
                "SourceArchiverSuiRpcUrl=https://fullnode.testnet.sui.io:443",
                "SourceArchiverWalrusUploadRelayUrl=https://upload-relay.testnet.walrus.space",
                "SourceArchiverWalrusUploadRelayTipMaxMist=1000",
                "SourceArchiverWalrusEpochs=1",
                "SourceArchiverWalrusDeletable=false",
            ]),
        );
    });

    it("overrides NitroEnclaveMemoryMiB with the 4096 default so PR #230 reaches the stack", () => {
        const plan = buildAwsSonariVerifierRunnerDeployPlan(validInput);

        expect(plan.parameterOverrides.NitroEnclaveMemoryMiB).toBe("4096");
        expect(plan.parameterOverrideArgs).toContain("NitroEnclaveMemoryMiB=4096");
    });

    it("honors an explicit nitroEnclaveMemoryMiB override", () => {
        const plan = buildAwsSonariVerifierRunnerDeployPlan({
            ...validInput,
            nitroEnclaveMemoryMiB: 8192,
        });

        expect(plan.parameterOverrides.NitroEnclaveMemoryMiB).toBe("8192");
        expect(plan.parameterOverrideArgs).toContain("NitroEnclaveMemoryMiB=8192");
    });

    it("overrides ScheduleExpression with the fixed JST cron default so the watcher runs at 00:00/12:00", () => {
        const plan = buildAwsSonariVerifierRunnerDeployPlan(validInput);

        expect(plan.parameterOverrides.ScheduleExpression).toBe("cron(0 0,12 * * ? *)");
        expect(plan.parameterOverrideArgs).toContain("ScheduleExpression=cron(0 0,12 * * ? *)");
    });

    it("honors an explicit scheduleExpression override", () => {
        const plan = buildAwsSonariVerifierRunnerDeployPlan({
            ...validInput,
            scheduleExpression: "rate(6 hours)",
        });

        expect(plan.parameterOverrides.ScheduleExpression).toBe("rate(6 hours)");
        expect(plan.parameterOverrideArgs).toContain("ScheduleExpression=rate(6 hours)");
    });

    it("fails closed when nitroEnclaveMemoryMiB is not a positive integer", () => {
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                nitroEnclaveMemoryMiB: 0,
            }),
        ).toThrow("Invalid nitro enclave memory MiB");
    });

    it("fails closed before planning a mainnet deploy with dummy World ID proof mode", () => {
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                relayerNetwork: "mainnet",
                worldIdProofMode: "dummy",
            }),
        ).toThrow("dummy World ID proof mode is not allowed on mainnet");
    });

    it("includes WorldIdProofMode=dummy in parameterOverrideArgs when worldIdProofMode is dummy", () => {
        const plan = buildAwsSonariVerifierRunnerDeployPlan({
            ...validInput,
            relayerNetwork: "testnet",
            worldIdProofMode: "dummy",
        });

        expect(plan.parameterOverrideArgs).toContain("WorldIdProofMode=dummy");
    });

    it("defaults WorldIdProofMode to real in parameterOverrideArgs when worldIdProofMode is not specified", () => {
        const { worldIdProofMode: _omit, ...inputWithoutProofMode } = validInput;
        const plan = buildAwsSonariVerifierRunnerDeployPlan(inputWithoutProofMode);

        expect(plan.parameterOverrideArgs).toContain("WorldIdProofMode=real");
    });

    it("validates and includes the World ID action parameter override", () => {
        const plan = buildAwsSonariVerifierRunnerDeployPlan({
            ...validInput,
            worldIdAction: "sonari_membership_register_v3",
        });

        expect(plan.parameterOverrides.WorldIdAction).toBe("sonari_membership_register_v3");
        expect(plan.parameterOverrideArgs).toContain("WorldIdAction=sonari_membership_register_v3");
        expect(() =>
            buildAwsSonariVerifierRunnerDeployPlan({
                ...validInput,
                worldIdAction: "attacker_action",
            }),
        ).toThrow("Invalid World ID action");
    });

    it("exposes CLI flags for the mainnet dummy World ID proof mode gate", async () => {
        await expect(
            execFileAsync("pnpm", [
                "tsx",
                "scripts/aws_sonari_verifier_runner_deploy_plan.ts",
                "--commit-sha",
                validCommitSha,
                "--lambda-bucket",
                validInput.lambdaBucket,
                "--earthquake-tee-bucket",
                validInput.earthquakeTeeBucket,
                "--earthquake-tee-sha256",
                validEarthquakeTeeSha256,
                "--earthquake-eif-bucket",
                validInput.earthquakeEifBucket,
                "--earthquake-eif-sha256",
                validEarthquakeEifSha256,
                "--membership-tee-bucket",
                validInput.membershipTeeBucket,
                "--membership-tee-sha256",
                validMembershipTeeSha256,
                "--membership-eif-bucket",
                validInput.membershipEifBucket,
                "--membership-eif-sha256",
                validMembershipEifSha256,
                "--census-tee-bucket",
                validInput.censusTeeBucket,
                "--census-tee-sha256",
                validCensusTeeSha256,
                "--census-eif-bucket",
                validInput.censusEifBucket,
                "--census-eif-sha256",
                validCensusEifSha256,
                "--source-archiver-token-secret-arn",
                validInput.sourceArchiverTokenSecretArn,
                "--source-archiver-private-key-secret-arn",
                validInput.sourceArchiverPrivateKeySecretArn,
                "--relayer-network",
                "mainnet",
                "--world-id-proof-mode",
                "dummy",
            ]),
        ).rejects.toThrow("dummy World ID proof mode is not allowed on mainnet");
    });
});
