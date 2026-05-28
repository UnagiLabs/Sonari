import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(
    process.cwd(),
    ".github/workflows/aws-earthquake-runner-dev-deploy.yml",
);
const readmePath = path.join(process.cwd(), "infra/aws/earthquake-runner/README.md");

async function readWorkflow(): Promise<string> {
    return readFile(workflowPath, "utf8");
}

async function readReadme(): Promise<string> {
    return readFile(readmePath, "utf8");
}

function expectContainsAll(source: string, expected: readonly string[]): void {
    for (const value of expected) {
        expect(source).toContain(value);
    }
}

describe("AWS earthquake runner dev deploy workflow", () => {
    it("runs only for main pushes and manual dev retries", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "name: AWS Earthquake Runner Dev Deploy",
            "push:",
            "branches:",
            "- main",
            "workflow_dispatch:",
            "environment: aws-earthquake-runner-dev",
        ]);
        expect(workflow).not.toContain("pull_request:");
        expect(workflow).not.toContain("aws-earthquake-runner-prod");
    });

    it("uses OIDC credentials scoped to dev GitHub variables", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "id-token: write",
            "contents: read",
            "aws-actions/configure-aws-credentials",
            "role-to-assume: $" + "{{ vars.AWS_EARTHQUAKE_RUNNER_DEV_ROLE_ARN }}",
            "aws-region: $" + "{{ vars.AWS_EARTHQUAKE_RUNNER_DEV_REGION }}",
            "AWS_EARTHQUAKE_RUNNER_DEV_ACCOUNT_ID",
            "AWS_EARTHQUAKE_RUNNER_DEV_STACK_NAME",
            "AWS_EARTHQUAKE_RUNNER_DEV_ARTIFACT_BUCKET",
            "AWS_EARTHQUAKE_RUNNER_DEV_SUI_CLI_URL",
            "AWS_EARTHQUAKE_RUNNER_DEV_SUI_CLI_SHA256",
            "AWS_EARTHQUAKE_RUNNER_DEV_WALRUS_CLI_URL",
            "AWS_EARTHQUAKE_RUNNER_DEV_WALRUS_CLI_SHA256",
        ]);
    });

    it("fails closed unless account, role, and stack are explicitly dev scoped", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "Validate dev deployment inputs",
            "aws sts get-caller-identity",
            "actual_account_id",
            "EXPECTED_AWS_ACCOUNT_ID",
            '[[ "$actual_account_id" == "$EXPECTED_AWS_ACCOUNT_ID" ]]',
            '[[ "$AWS_ROLE_ARN" == *":role/"*dev* ]]',
            '[[ "$STACK_NAME" =~ (^|[-_])dev($|[-_]) ]]',
            '[[ "$STACK_NAME" == "sonari-aws-earthquake-runner-dev" ]]',
        ]);
    });

    it("sets up the toolchain needed by repo checks and AWS artifacts", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "actions/setup-node@v6",
            "node-version: 24.x",
            "corepack prepare pnpm@10.27.0 --activate",
            "rustup toolchain install stable --profile minimal --component rustfmt",
            "rustup target add x86_64-unknown-linux-musl",
            "sudo apt-get install -y musl-tools unzip",
            "Install pinned Sui and Walrus CLIs",
            "curl -fsSL",
            "sha256sum -c -",
            "SUI_CLI_URL",
            "SUI_CLI_SHA256",
            "WALRUS_CLI_URL",
            "WALRUS_CLI_SHA256",
            "SONARI_WALRUS_CLI",
            '"$install_dir/$command_name" --version',
            "SONARI_WALRUS_CLI=$RUNNER_TEMP/sonari-bin/walrus",
        ]);
    });

    it("runs required checks and builds both deployment artifacts", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "pnpm install --frozen-lockfile",
            "pnpm check",
            "pnpm check:move",
            "pnpm test:oracle",
            "pnpm build:aws-earthquake-lambda",
            "pnpm build:aws-earthquake-tee-artifact",
        ]);
    });

    it("uploads commit-scoped artifacts and deploys disabled schedule parameters", async () => {
        const workflow = await readWorkflow();
        const githubSha = "$" + "{GITHUB_SHA}";
        const s3Prefix = "$" + "{S3_PREFIX}";

        expectContainsAll(workflow, [
            `lambda_key="${s3Prefix}/${githubSha}/earthquake-runner-lambda.zip"`,
            `tee_key="${s3Prefix}/${githubSha}/earthquake-tee-artifact.tar.gz"`,
            "s3://$ARTIFACT_BUCKET/$lambda_key",
            "s3://$ARTIFACT_BUCKET/$tee_key",
            "scripts/aws_earthquake_runner_deploy_plan.ts",
            "--parameter-overrides",
            "LambdaCodeS3Bucket",
            "LambdaCodeS3Key",
            "TeeArtifactS3Bucket",
            "TeeArtifactS3Key",
            "TeeArtifactSha256",
            "GitCommitSha",
            "ScheduleState",
            "ScheduleState=DISABLED",
            "--no-fail-on-empty-changeset",
        ]);
    });

    it("does not keep rollback data as a GitHub Actions artifact", async () => {
        const workflow = await readWorkflow();

        expect(workflow).not.toContain("earthquake-runner-dev-rollback");
        expect(workflow).not.toContain("actions/upload-artifact");
        expect(workflow).not.toContain("dist/aws/earthquake-runner-rollback.json");
        expect(workflow).not.toContain("--stack-json");
    });

    it("checks post-deploy dev guardrails before completing", async () => {
        const workflow = await readWorkflow();
        const githubSha = "$" + "{GITHUB_SHA}";

        expectContainsAll(workflow, [
            "Verify post-deploy guardrails",
            "RunnerAutoScalingGroupName",
            "WatcherScheduleName",
            "WatcherLambdaName",
            "ManualWatcherLambdaName",
            "RunnerControlLambdaName",
            "describe-auto-scaling-groups",
            "DesiredCapacity",
            '[[ "$desired_capacity" == "0" ]]',
            "aws scheduler get-schedule",
            '[[ "$schedule_state" == "DISABLED" ]]',
            "CodeSha256",
            '[[ "$watcher_code_sha" == "$manual_watcher_code_sha" ]]',
            '[[ "$watcher_code_sha" == "$runner_control_code_sha" ]]',
            "DeployedGitCommitSha",
            "LambdaCodeS3KeyOutput",
            "TeeArtifactS3KeyOutput",
            '[[ "$deployed_git_commit_sha" == "$GITHUB_SHA" ]]',
            `[[ "$lambda_code_s3_key" == "earthquake-runner/${githubSha}/earthquake-runner-lambda.zip" ]]`,
            `[[ "$tee_artifact_s3_key" == "earthquake-runner/${githubSha}/earthquake-tee-artifact.tar.gz" ]]`,
        ]);
    });

    it("cleans old S3 artifacts only after post-deploy guardrails pass", async () => {
        const workflow = await readWorkflow();

        expect(workflow.indexOf("name: Cleanup old S3 artifacts")).toBeGreaterThan(
            workflow.indexOf("name: Verify post-deploy guardrails"),
        );
        expectContainsAll(workflow, [
            "aws s3api list-objects-v2",
            "aws s3api delete-objects",
            '--prefix "$' + '{S3_PREFIX}/"',
            'if [[ "$key" == "$keep_lambda_key" ]]',
            'if [[ "$key" == "$keep_tee_key" ]]',
            "No old S3 artifacts to delete.",
        ]);
    });

    it("does not enable shell tracing", async () => {
        const workflow = await readWorkflow();

        expect(workflow).not.toContain("set -x");
    });

    it("documents post-deploy verification and Git revert rollback", async () => {
        const readme = await readReadme();
        const rollbackSection = readme.slice(readme.indexOf("## dev deploy の確認と rollback"));

        expectContainsAll(readme, [
            "## dev deploy の確認と rollback",
            "aws cloudformation describe-stacks",
            "DeployedGitCommitSha",
            "LambdaCodeS3KeyOutput",
            "TeeArtifactS3KeyOutput",
            "TeeArtifactSha256Output",
            "RunnerAutoScalingGroupName",
            "WatcherScheduleName",
            "WatcherLambdaName",
            "ManualWatcherLambdaName",
            "RunnerControlLambdaName",
            "AWS_EARTHQUAKE_RUNNER_DEV_SUI_CLI_URL",
            "AWS_EARTHQUAKE_RUNNER_DEV_SUI_CLI_SHA256",
            "AWS_EARTHQUAKE_RUNNER_DEV_WALRUS_CLI_URL",
            "AWS_EARTHQUAKE_RUNNER_DEV_WALRUS_CLI_SHA256",
            "S3 には最新 deploy commit の 2 object だけを残します",
            "post-deploy guardrail 成功後",
            "Git revert",
            "通常の CI deploy",
            "s3:ListBucket",
            "s3:DeleteObject",
            "DesiredCapacity",
            "DISABLED",
            "CodeSha256",
        ]);
        expect(rollbackSection).toContain("Git revert");
        expect(rollbackSection).not.toContain("rollback JSON");
        expect(rollbackSection).not.toContain("earthquake-runner-dev-rollback");
        expect(rollbackSection).not.toContain("RunnerTokenSecretArn");
        expect(rollbackSection).not.toContain("SuiKeystoreSecretArn");
        expect(rollbackSection).not.toContain(".local");
    });
});
