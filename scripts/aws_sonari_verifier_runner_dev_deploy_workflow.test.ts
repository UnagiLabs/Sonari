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

    it("runs only on manual dispatch to avoid wasteful auto-deploys, with dev-scoped names", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "name: AWS Sonari Verifier Runner Dev Deploy",
            "workflow_dispatch:",
            "environment: aws-sonari-verifier-runner-dev",
            "group: aws-sonari-verifier-runner-dev-deploy",
        ]);
        // GitHub Actions のコスト削減のため、push などの自動 trigger は持たず手動実行限定にする。
        // EIF 再ビルドを伴うフルデプロイは毎 push で走らせない（PCR 自動再登録も dispatch 時のみ動く）。
        expect(workflow).not.toContain("push:");
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
            "AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_TOKEN_SECRET_ARN",
            "AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN",
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
            "Resolve SourceArchiver private key secret ARN",
            "aws cloudformation describe-stacks",
            "SourceArchiverPrivateKeySecretArn",
            "SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN must be set or recoverable from the dev stack SourceArchiverPrivateKeySecretArn parameter",
            "SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN=%s",
        ]);

        const requiredNamesMatch = workflow.match(/required_names=\(\n([\s\S]*?)\n {10}\)/u);
        expect(requiredNamesMatch?.[1]).not.toContain("SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN");
    });

    it("builds every verifier runner deployment artifact", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "rustup toolchain install stable --profile minimal --component rustfmt --component clippy",
            "pnpm install --frozen-lockfile",
            "pnpm check",
            "pnpm test:oracle",
            "pnpm test:identity",
            "pnpm build:aws-sonari-verifier-runner-lambda",
            "pnpm build:aws-earthquake-tee-artifact",
            "pnpm build:aws-earthquake-eif",
            "Read earthquake EIF measurements",
            "nitro-cli describe-eif",
            "--eif-path dist/aws/earthquake-tee.eif",
            "dist/aws/earthquake-tee-measurements.json",
            "EARTHQUAKE_EIF_PCR0",
            "EARTHQUAKE_EIF_PCR1",
            "EARTHQUAKE_EIF_PCR2",
            "Earthquake EIF PCRs",
            "pnpm build:aws-membership-identity-tee-artifact",
            "pnpm build:aws-membership-identity-eif",
            "NITRO_CLI_TAG: v1.4.4",
            "Cache Nitro CLI build",
            "Use local Nitro CLI",
            "if: runner.name == 'manji'",
            "Install pinned Nitro CLI",
            "if: runner.name != 'manji'",
            "https://github.com/aws/aws-nitro-enclaves-cli",
            "cargo build",
            '--manifest-path "$source_dir/Cargo.toml"',
            "Nitro CLI blobs directory is missing",
            "/var/log/nitro_enclaves must exist and be writable by the runner user",
            "sudo mkdir -p /var/log/nitro_enclaves",
            'sudo chown "$(id -u):$(id -g)" /var/log/nitro_enclaves',
            "NITRO_CLI_BLOBS=$blobs_dir",
            'export SUI_CONFIG_DIR="$admin_dir"',
            'admin_alias="sonari-dev-admin-$' + "{GITHUB_RUN_ID}-$" + '{GITHUB_RUN_ATTEMPT}"',
            "sui client --yes new-address ed25519 sonari-bootstrap",
            "sui keytool import",
            '--alias "$admin_alias"',
            'sui client switch --env testnet --address "$admin_address"',
            "Sui client active address mismatch after admin key import",
            '--sender "$admin_address"',
            'Buffer.from(value, "base64")',
            "PCR field is not a byte array or base64 string",
        ]);
    });

    it("reads membership identity EIF measurements and writes PCR0/1/2 to run summary", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "Read membership identity EIF measurements",
            "--eif-path dist/aws/membership-identity-tee.eif",
            "dist/aws/membership-identity-tee-measurements.json",
            "MEMBERSHIP_IDENTITY_EIF_PCR0",
            "MEMBERSHIP_IDENTITY_EIF_PCR1",
            "MEMBERSHIP_IDENTITY_EIF_PCR2",
            "Membership Identity EIF PCRs",
        ]);
    });

    it("earthquake EIF measurements step is unchanged after membership step addition", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "Read earthquake EIF measurements",
            "--eif-path dist/aws/earthquake-tee.eif",
            "dist/aws/earthquake-tee-measurements.json",
            "EARTHQUAKE_EIF_PCR0",
            "EARTHQUAKE_EIF_PCR1",
            "EARTHQUAKE_EIF_PCR2",
            "Earthquake EIF PCRs",
            "Use these values for the Sui `VerifierRegistry` earthquake config.",
        ]);
    });

    it("does not expose relayer deployment variables to test steps", async () => {
        const workflow = await readWorkflow();
        const jobEnvMatch = workflow.match(/ {4}env:\n([\s\S]*?)\n\n {4}steps:/u);

        expect(jobEnvMatch?.[1]).not.toContain("RELAYER_MODE");
        expect(jobEnvMatch?.[1]).not.toContain("RELAYER_TARGET");
        expect(jobEnvMatch?.[1]).not.toContain("RELAYER_REGISTRY");
        expect(jobEnvMatch?.[1]).not.toContain("RELAYER_VERIFIER_REGISTRY");
        expect(jobEnvMatch?.[1]).not.toContain("RELAYER_CATEGORY_REGISTRY");
        expect(jobEnvMatch?.[1]).not.toContain("RELAYER_CATEGORY_POOL");
        expect(jobEnvMatch?.[1]).not.toContain("RELAYER_GRPC_URL");
        expect(jobEnvMatch?.[1]).not.toContain("RELAYER_SENDER_ADDRESS");
        expect(jobEnvMatch?.[1]).not.toContain("RELAYER_SIGNER_SECRET_ARN");
        expect(jobEnvMatch?.[1]).not.toContain("RELAYER_ALLOW_SUBMIT");
        expect(jobEnvMatch?.[1]).not.toContain("FLOOR_CENSUS_MODE");
        expect(jobEnvMatch?.[1]).not.toContain("FLOOR_CENSUS_TARGET");
        expect(jobEnvMatch?.[1]).not.toContain("FLOOR_CENSUS_PAUSE_STATE");
        expect(jobEnvMatch?.[1]).not.toContain("FLOOR_CENSUS_CATEGORY_POOL");
        expect(jobEnvMatch?.[1]).not.toContain("FLOOR_CENSUS_MAIN_POOL");
        expect(jobEnvMatch?.[1]).not.toContain("FLOOR_CENSUS_JSON_RPC_URL");

        expectContainsAll(workflow, [
            "RELAYER_MODE: $" + "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_MODE }}",
            "RELAYER_GRPC_URL: $" + "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_GRPC_URL }}",
            "RELAYER_SENDER_ADDRESS: $" +
                "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_SENDER_ADDRESS }}",
            "RELAYER_SIGNER_SECRET_ARN: $" +
                "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_SIGNER_SECRET_ARN }}",
            "RELAYER_ALLOW_SUBMIT: $" +
                "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_ALLOW_SUBMIT }}",
        ]);
        expect(workflow).not.toContain(
            "RELAYER_REGISTRY: $" + "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_REGISTRY }}",
        );
        expect(workflow).not.toContain(
            "RELAYER_VERIFIER_REGISTRY: $" +
                "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_VERIFIER_REGISTRY }}",
        );
        expect(workflow).not.toContain(
            "RELAYER_CATEGORY_REGISTRY: $" + "{{ vars.SONARI_CATEGORY_REGISTRY_ID }}",
        );
        expect(workflow).not.toContain(
            "RELAYER_CATEGORY_POOL: $" + "{{ vars.SONARI_EARTHQUAKE_CATEGORY_POOL_ID }}",
        );
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
            "for pcr_name in EARTHQUAKE_EIF_PCR0 EARTHQUAKE_EIF_PCR1 EARTHQUAKE_EIF_PCR2",
            '[[ ! "$' + '{!pcr_name}" =~ ^[0-9a-f]{96}$ ]]',
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
            "--source-archiver-token-secret-arn",
            "$SOURCE_ARCHIVER_TOKEN_SECRET_ARN",
            "--source-archiver-private-key-secret-arn",
            "$SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN",
            "--world-id-proof-mode",
            "$WORLD_ID_PROOF_MODE",
            "--world-id-action",
            "$WORLD_ID_ACTION",
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
            "WorldIdProofMode",
            "WorldIdAction",
            "SourceArchiverTokenSecretArn",
            "SourceArchiverPrivateKeySecretArn",
            "SourceArchiverSuiNetwork",
            "SourceArchiverSuiRpcUrl",
            "SourceArchiverWalrusUploadRelayUrl",
            "SourceArchiverWalrusUploadRelayTipMaxMist",
            "SourceArchiverWalrusEpochs",
            "SourceArchiverWalrusDeletable",
            "ScheduleState=DISABLED",
            "--parameter-overrides",
            "aws cloudformation deploy",
            "--template-file infra/aws/sonari-verifier-runner/template.yaml",
            '--s3-bucket "$ARTIFACT_BUCKET"',
            '--s3-prefix "$' + "{S3_PREFIX}/$" + '{GITHUB_SHA}/cloudformation"',
            "EarthquakeNitroEnclaveProcessCommand=/opt/sonari/bin/run-earthquake-enclave",
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
            "SourceArchiverLambdaName",
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
            '[[ "$watcher_code_sha" == "$source_archiver_code_sha" ]]',
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

    it("auto-registers on-chain verifier PCR configs from the rebuilt EIFs", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            // testnet 互換の pinned Sui CLI を取得して register スクリプトに供給する。
            "SUI_CLI_URL: https://github.com/MystenLabs/sui/releases/download/testnet-v1.71.1/",
            "SUI_CLI_SHA256: ca6bc791596d5def88500b653b5db718e72dd0d2b58039ad118f74ef9e6761a5",
            "Cache Sui CLI artifact",
            "Install pinned Sui CLI",
            "Register verifier PCR configs from rebuilt EIFs",
            "scripts/register-verifier-configs.sh",
            '--package-id "$SONARI_IDENTITY_PACKAGE_ID"',
            '--admin-cap-id "$SONARI_ADMIN_CAP_ID"',
            '--verifier-registry-id "$SONARI_VERIFIER_REGISTRY_ID"',
            '--sui-config "$client_config"',
            "--sui-env testnet",
            // PCR は EIF 値の env fallback で渡る（手書きしない）。
            "register-verifier-configs.sh",
        ]);
        // admin cap id と registry id は resolver 由来、admin 鍵は環境スコープ secret から。
        expect(workflow).not.toContain("SONARI_ADMIN_CAP_ID: $" + "{{ vars.SONARI_ADMIN_CAP_ID }}");
        expect(workflow).not.toContain(
            "SONARI_VERIFIER_REGISTRY_ID: $" + "{{ vars.SONARI_VERIFIER_REGISTRY_ID }}",
        );
        expect(workflow).toContain(
            "SONARI_DEV_ADMIN_PRIVATE_KEY: $" + "{{ secrets.SONARI_DEV_ADMIN_PRIVATE_KEY }}",
        );
    });

    it("keeps the dev admin key out of logs and cleans it up afterwards", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "set +x",
            'echo "::add-mask::$' + '{SONARI_DEV_ADMIN_PRIVATE_KEY}"',
            "Cleanup admin wallet materials",
            "if: always()",
            'rm -rf "$RUNNER_TEMP/sui-admin"',
        ]);
        // 使い捨て admin 鍵は AWS Secrets Manager / Variables に置かない。
        expect(workflow).not.toContain("aws secretsmanager");
    });

    it("verifies on-chain PCR matches the rebuilt EIFs to catch silent partial failures", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "Verify on-chain PCR config matches rebuilt EIFs",
            'object "$SONARI_VERIFIER_REGISTRY_ID" --json',
            "verifier_family",
            "EARTHQUAKE_EIF_PCR0",
            "MEMBERSHIP_IDENTITY_EIF_PCR0",
            "process.exit(1)",
        ]);
    });

    it("wires shared object ids from resolver output and forwards them as CloudFormation parameters", async () => {
        const workflow = await readWorkflow();

        // 共有 object id は resolver が GITHUB_ENV へ書くため、workflow env で Variables から再宣言しない。
        expect(workflow).not.toContain(
            "SONARI_IDENTITY_PAUSE_STATE_ID: $" + "{{ vars.SONARI_IDENTITY_PAUSE_STATE_ID }}",
        );
        expect(workflow).not.toContain(
            "SONARI_IDENTITY_REGISTRY_ID: $" + "{{ vars.SONARI_IDENTITY_REGISTRY_ID }}",
        );
        expect(workflow).not.toContain(
            "SONARI_MEMBERSHIP_REGISTRY_ID: $" + "{{ vars.SONARI_MEMBERSHIP_REGISTRY_ID }}",
        );
        expect(workflow).not.toContain(
            "SONARI_VERIFIER_REGISTRY_ID: $" + "{{ vars.SONARI_VERIFIER_REGISTRY_ID }}",
        );

        // identity relayer mode は引き続き dev-prefixed の environment-level variable。
        expect(workflow).toContain(
            "IDENTITY_RELAYER_MODE: $" +
                "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_IDENTITY_RELAYER_MODE }}",
        );

        // 共有値は CloudFormation パラメータとして deploy step から渡す。
        expect(workflow).toContain("IdentityRelayerMode=$IDENTITY_RELAYER_MODE");
        expect(workflow).toContain("SonariIdentityPackageId=$SONARI_IDENTITY_PACKAGE_ID");
        expect(workflow).toContain("SonariIdentityPauseStateId=$SONARI_IDENTITY_PAUSE_STATE_ID");
        expect(workflow).toContain("SonariIdentityRegistryId=$SONARI_IDENTITY_REGISTRY_ID");
        expect(workflow).toContain("SonariMembershipRegistryId=$SONARI_MEMBERSHIP_REGISTRY_ID");
        expect(workflow).toContain("SonariVerifierRegistryId=$SONARI_VERIFIER_REGISTRY_ID");
        expect(workflow).toContain("RelayerCategoryRegistry=$RELAYER_CATEGORY_REGISTRY");
        expect(workflow).toContain("RelayerCategoryPool=$RELAYER_CATEGORY_POOL");
    });

    it("derives Sonari contract ids from Published.toml and Sui events instead of GitHub variables", async () => {
        const workflow = await readWorkflow();

        // package id は Published.toml、object id は Sui event から導出する。
        expect(workflow).toContain("Resolve Sonari contract ids from Published.toml");
        expect(workflow).toContain("scripts/resolve_published_contract_ids.ts");
        expect(workflow).not.toContain(
            "RELAYER_TARGET: $" + "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_TARGET }}",
        );
        // deploy step の env では SONARI_IDENTITY_PACKAGE_ID を vars から再宣言しない
        // （前段 step が GITHUB_ENV に書いた toml 由来の値を使うため）。
        expect(workflow).not.toContain(
            "SONARI_IDENTITY_PACKAGE_ID: $" +
                "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_SONARI_IDENTITY_PACKAGE_ID }}",
        );
    });

    it("wires the affected proof registrar URL from the shared repo-level variable", async () => {
        const workflow = await readWorkflow();

        // affected-cells proof の register URL は dapp と同じ repo-level 単一情報源を使う。
        expect(workflow).toContain(
            "AFFECTED_PROOF_WORKER_URL: $" + "{{ vars.SONARI_AFFECTED_PROOF_WORKER_URL }}",
        );
        expect(workflow).toContain("AffectedProofRegistrarUrl=$AFFECTED_PROOF_WORKER_URL");
    });

    it("wires floor census CloudFormation parameters from repo-level variables", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "FLOOR_CENSUS_MODE: $" + "{{ vars.SONARI_FLOOR_CENSUS_MODE }}",
            "FLOOR_CENSUS_JSON_RPC_URL: $" + "{{ vars.SONARI_FLOOR_CENSUS_JSON_RPC_URL }}",
            "FloorCensusMode=$FLOOR_CENSUS_MODE",
            "FloorCensusTarget=$FLOOR_CENSUS_TARGET",
            "FloorCensusPauseState=$FLOOR_CENSUS_PAUSE_STATE",
            "FloorCensusCategoryPool=$FLOOR_CENSUS_CATEGORY_POOL",
            "FloorCensusMainPool=$FLOOR_CENSUS_MAIN_POOL",
            "FloorCensusJsonRpcUrl=$FLOOR_CENSUS_JSON_RPC_URL",
        ]);
        expect(workflow).not.toContain(
            "FLOOR_CENSUS_TARGET: $" + "{{ vars.SONARI_FLOOR_CENSUS_TARGET }}",
        );
        expect(workflow).not.toContain(
            "FLOOR_CENSUS_PAUSE_STATE: $" + "{{ vars.SONARI_FLOOR_CENSUS_PAUSE_STATE }}",
        );
        expect(workflow).not.toContain(
            "FLOOR_CENSUS_CATEGORY_POOL: $" + "{{ vars.SONARI_FLOOR_CENSUS_CATEGORY_POOL }}",
        );
        expect(workflow).not.toContain(
            "FLOOR_CENSUS_MAIN_POOL: $" + "{{ vars.SONARI_FLOOR_CENSUS_MAIN_POOL }}",
        );

        const requiredNamesMatch = workflow.match(/required_names=\(\n([\s\S]*?)\n {10}\)/u);
        expect(requiredNamesMatch?.[1]).not.toContain("FLOOR_CENSUS_MODE");
    });

    it("takes the Sui network from the shared variable and keeps other earthquake relayer wiring unchanged", async () => {
        const workflow = await readWorkflow();

        // Sui network は単一情報源（SONARI_SUI_NETWORK）から取り、relayer / source archiver に共有する。
        expect(workflow).toContain("RELAYER_NETWORK: $" + "{{ vars.SONARI_SUI_NETWORK }}");
        // earthquake relayer の他の RELAYER_* は移行ラグのため dev-prefixed のまま据置。
        expect(workflow).toContain(
            "RELAYER_MODE: $" + "{{ vars.AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_MODE }}",
        );
        expect(workflow).toContain("RelayerMode=$RELAYER_MODE");
        expect(workflow).toContain("RelayerNetwork=$RELAYER_NETWORK");
    });
});
