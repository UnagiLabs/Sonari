import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(
    process.cwd(),
    ".github/workflows/aws-sonari-verifier-runner-dev-deploy.yml",
);
const legacyEarthquakeWorkflowPath = path.join(
    process.cwd(),
    ".github/workflows/aws-earthquake-runner-dev-deploy.yml",
);

async function readWorkflow(): Promise<string> {
    return readFile(workflowPath, "utf8");
}

function expectContainsAll(source: string, expected: readonly string[]): void {
    for (const value of expected) {
        expect(source).toContain(value);
    }
}

describe("AWS Sonari verifier runner dev deploy workflow", () => {
    it("does not keep the legacy earthquake runner deploy workflow", async () => {
        await expect(access(legacyEarthquakeWorkflowPath)).rejects.toThrow();
    });

    it("runs only for main pushes and manual dev retries with dev-scoped names", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "name: AWS Sonari Verifier Runner Dev Deploy",
            "push:",
            "branches:",
            "- main",
            "workflow_dispatch:",
            "environment: aws-sonari-verifier-runner-dev",
            "group: aws-sonari-verifier-runner-dev-deploy",
        ]);
        expect(workflow).not.toContain("pull_request:");
        expect(workflow).not.toContain("aws-sonari-verifier-runner-prod");
    });

    it("uses GitHub OIDC and only dev-prefixed GitHub variables for AWS access", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "id-token: write",
            "contents: read",
            "aws-actions/configure-aws-credentials",
            "role-to-assume: $" + "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_ROLE_ARN }}",
            "aws-region: $" + "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_REGION }}",
            "AWS_SONARI_VERIFIER_RUNNER_DEV_ACCOUNT_ID",
            "AWS_SONARI_VERIFIER_RUNNER_DEV_STACK_NAME",
            "AWS_SONARI_VERIFIER_RUNNER_DEV_ARTIFACT_BUCKET",
            "AWS_SONARI_VERIFIER_RUNNER_DEV_WALRUS_CLI_URL",
            "AWS_SONARI_VERIFIER_RUNNER_DEV_WALRUS_CLI_SHA256",
        ]);
        expect(workflow).not.toContain("AWS_ACCESS_KEY_ID");
        expect(workflow).not.toContain("AWS_SECRET_ACCESS_KEY");
        expect(workflow).not.toContain("secrets.AWS_");
    });

    it("fails closed unless required dev deployment inputs are valid", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "Validate dev deployment inputs",
            "aws sts get-caller-identity",
            "EXPECTED_AWS_ACCOUNT_ID",
            '[[ "$actual_account_id" == "$EXPECTED_AWS_ACCOUNT_ID" ]]',
            '[[ "$AWS_ROLE_ARN" == *":role/"*dev* ]]',
            '[[ "$STACK_NAME" =~ (^|[-_])dev($|[-_]) ]]',
            '[[ "$STACK_NAME" == "sonari-aws-sonari-verifier-runner-dev" ]]',
            '[[ ! "$WALRUS_CLI_SHA256" =~ ^[0-9a-f]{64}$ ]]',
            '[[ ! "$NITRO_ENCLAVE_IMAGE_SHA384" =~ ^[0-9a-fA-F]{96}$ ]]',
            '[[ ! "$NITRO_ENCLAVE_PCR3" =~ ^[0-9a-fA-F]{96}$ ]]',
            "expected_runner_role_arn",
            'digest.update(b"\\0" * 48)',
            '[[ "$' + '{NITRO_ENCLAVE_PCR3,,}" != "$expected_pcr3" ]]',
        ]);
    });

    it("builds every verifier runner deployment artifact", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "pnpm install --frozen-lockfile",
            "pnpm check",
            "pnpm test:oracle",
            "pnpm test:identity",
            "pnpm build:aws-sonari-verifier-runner-lambda",
            "pnpm build:aws-earthquake-tee-artifact",
            "pnpm build:aws-earthquake-eif",
            "pnpm build:aws-membership-identity-tee-artifact",
            "pnpm build:aws-membership-identity-eif",
            "NITRO_CLI_TAG: v1.4.4",
            "Cache Nitro CLI build",
            "Install pinned Nitro CLI",
            "https://github.com/aws/aws-nitro-enclaves-cli",
            "cargo build",
            '--manifest-path "$source_dir/Cargo.toml"',
            "sudo mkdir -p /var/log/nitro_enclaves",
            'sudo chown "$(id -u):$(id -g)" /var/log/nitro_enclaves',
            "NITRO_CLI_BLOBS=$blobs_dir",
        ]);
    });

    it("uploads commit-scoped artifacts under one Sonari verifier runner prefix", async () => {
        const workflow = await readWorkflow();
        const githubSha = "$" + "{GITHUB_SHA}";
        const s3Prefix = "$" + "{S3_PREFIX}";

        expectContainsAll(workflow, [
            "S3_PREFIX: sonari-verifier-runner",
            `lambda_key="${s3Prefix}/${githubSha}/sonari-verifier-runner-lambda.zip"`,
            `earthquake_tee_key="${s3Prefix}/${githubSha}/earthquake-tee-artifact.tar.gz"`,
            `earthquake_eif_key="${s3Prefix}/${githubSha}/earthquake-tee.eif"`,
            `membership_tee_key="${s3Prefix}/${githubSha}/membership-identity-tee-artifact.tar.gz"`,
            `membership_eif_key="${s3Prefix}/${githubSha}/membership-identity-tee.eif"`,
            "s3://$ARTIFACT_BUCKET/$lambda_key",
            "s3://$ARTIFACT_BUCKET/$earthquake_tee_key",
            "s3://$ARTIFACT_BUCKET/$earthquake_eif_key",
            "s3://$ARTIFACT_BUCKET/$membership_tee_key",
            "s3://$ARTIFACT_BUCKET/$membership_eif_key",
        ]);
    });

    it("computes and validates every TEE and EIF SHA-256 before deployment", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "validate_sha256",
            "EARTHQUAKE_TEE_ARTIFACT_SHA256",
            "EARTHQUAKE_EIF_SHA256",
            "MEMBERSHIP_TEE_ARTIFACT_SHA256",
            "MEMBERSHIP_EIF_SHA256",
            'sha256sum -c "$checksum_path" >&2',
            'sha256sum "$path"',
            'validate_sha256 "earthquake TEE artifact" dist/aws/earthquake-tee-artifact.tar.gz',
            'validate_sha256 "earthquake EIF" dist/aws/earthquake-tee.eif',
            'validate_sha256 "membership TEE artifact" dist/aws/membership-identity-tee-artifact.tar.gz',
            'validate_sha256 "membership EIF" dist/aws/membership-identity-tee.eif',
            '[[ "$digest" =~ ^[0-9a-f]{64}$ ]]',
        ]);
    });

    it("uses validated deploy-plan output for CloudFormation parameter overrides", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "scripts/aws_sonari_verifier_runner_deploy_plan.ts",
            "--earthquake-tee-sha256",
            "$EARTHQUAKE_TEE_ARTIFACT_SHA256",
            "--earthquake-eif-bucket",
            "--earthquake-eif-sha256",
            "$EARTHQUAKE_EIF_SHA256",
            "--membership-tee-sha256",
            "$MEMBERSHIP_TEE_ARTIFACT_SHA256",
            "--membership-eif-sha256",
            "$MEMBERSHIP_EIF_SHA256",
            "parameterOverrideArgs",
            "LambdaCodeS3Bucket",
            "LambdaCodeS3Key",
            "TeeArtifactS3Bucket",
            "TeeArtifactS3Key",
            "TeeArtifactSha256",
            "EarthquakeTeeEifS3Bucket",
            "EarthquakeTeeEifS3Key",
            "EarthquakeTeeEifSha256",
            "MembershipTeeArtifactS3Bucket",
            "MembershipTeeArtifactS3Key",
            "MembershipTeeArtifactSha256",
            "TeeEifS3Bucket",
            "TeeEifS3Key",
            "TeeEifSha256",
            "GitCommitSha",
            "ScheduleState",
            "ScheduleState=DISABLED",
            "--parameter-overrides",
            "aws cloudformation deploy",
            "--template-file infra/aws/sonari-verifier-runner/template.yaml",
            "--capabilities CAPABILITY_NAMED_IAM",
            "--no-fail-on-empty-changeset",
        ]);
        expect(workflow).not.toContain("TeeSigningKeySecretArn");
        expect(workflow).not.toContain("TEE_SIGNING_KEY_SECRET_ARN");
    });

    it("checks post-deploy guardrails before completing", async () => {
        const workflow = await readWorkflow();
        const githubSha = "$" + "{GITHUB_SHA}";

        expectContainsAll(workflow, [
            "Verify post-deploy guardrails",
            "RunnerAutoScalingGroupName",
            "WatcherScheduleName",
            "BatchScheduleName",
            "WatcherLambdaName",
            "ManualWatcherLambdaName",
            "SubmitVerificationLambdaName",
            "BatchVerifierLambdaName",
            "RunnerControlLambdaName",
            "describe-auto-scaling-groups",
            "DesiredCapacity",
            '[[ "$desired_capacity" == "0" ]]',
            "aws scheduler get-schedule",
            '[[ "$watcher_schedule_state" == "DISABLED" ]]',
            '[[ "$batch_schedule_state" == "DISABLED" ]]',
            "CodeSha256",
            '[[ "$watcher_code_sha" != "None" ]]',
            '[[ "$watcher_code_sha" == "$manual_watcher_code_sha" ]]',
            '[[ "$watcher_code_sha" == "$submit_verification_code_sha" ]]',
            '[[ "$watcher_code_sha" == "$batch_verifier_code_sha" ]]',
            '[[ "$watcher_code_sha" == "$runner_control_code_sha" ]]',
            "DeployedGitCommitSha",
            "LambdaCodeS3KeyOutput",
            "TeeArtifactS3KeyOutput",
            "TeeArtifactSha256Output",
            "EarthquakeTeeEifS3KeyOutput",
            "EarthquakeTeeEifSha256Output",
            "MembershipTeeArtifactS3KeyOutput",
            "MembershipTeeArtifactSha256Output",
            "TeeEifS3KeyOutput",
            "TeeEifSha256Output",
            '[[ "$deployed_git_commit_sha" == "$GITHUB_SHA" ]]',
            `[[ "$lambda_code_s3_key" == "sonari-verifier-runner/${githubSha}/sonari-verifier-runner-lambda.zip" ]]`,
            `[[ "$tee_artifact_s3_key" == "sonari-verifier-runner/${githubSha}/earthquake-tee-artifact.tar.gz" ]]`,
            `[[ "$earthquake_eif_s3_key" == "sonari-verifier-runner/${githubSha}/earthquake-tee.eif" ]]`,
            `[[ "$membership_tee_artifact_s3_key" == "sonari-verifier-runner/${githubSha}/membership-identity-tee-artifact.tar.gz" ]]`,
            `[[ "$tee_eif_s3_key" == "sonari-verifier-runner/${githubSha}/membership-identity-tee.eif" ]]`,
        ]);
    });

    it("does not clean old AWS-side artifacts in this automated deploy step", async () => {
        const workflow = await readWorkflow();

        expect(workflow).not.toContain("Cleanup old S3 artifacts");
        expect(workflow).not.toContain("delete-objects");
        expect(workflow).not.toContain("s3:DeleteObject");
    });

    it("does not enable shell tracing", async () => {
        const workflow = await readWorkflow();

        expect(workflow).not.toContain("set -x");
    });
});
