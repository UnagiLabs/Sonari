import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readmePath = path.join(process.cwd(), "infra/aws/sonari-verifier-runner/README.md");

async function readReadme(): Promise<string> {
    return readFile(readmePath, "utf8");
}

function expectContainsAll(source: string, expected: readonly string[]): void {
    for (const value of expected) {
        expect(source).toContain(value);
    }
}

function expectAdminCallIncludesSender(source: string, functionName: string): void {
    const callBlocks = Array.from(
        source.matchAll(/```bash\n(sui client call[\s\S]*?)\n```/g),
        (match) => match[1] ?? "",
    );
    const matchingBlock = callBlocks.find((block) => block.includes(`--function ${functionName}`));

    expect(matchingBlock).toBeDefined();
    expect(matchingBlock).toContain('--sender "$ADMIN_ADDRESS"');
}

describe("AWS Sonari verifier runner README", () => {
    it("documents manual deploy with the validated deploy plan and commit-scoped artifacts", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "aws sts get-caller-identity",
            "595103996064",
            "pnpm build:aws-sonari-verifier-runner-lambda",
            "pnpm build:aws-earthquake-tee-artifact",
            "pnpm build:aws-earthquake-eif",
            "pnpm build:aws-membership-identity-tee-artifact",
            "pnpm build:aws-membership-identity-eif",
            "sonari-verifier-runner/<commit>/",
            "sonari-verifier-runner/$COMMIT_SHA/sonari-verifier-runner-lambda.zip",
            "sonari-verifier-runner/$COMMIT_SHA/earthquake-tee-artifact.tar.gz",
            "sonari-verifier-runner/$COMMIT_SHA/earthquake-tee.eif",
            "sonari-verifier-runner/$COMMIT_SHA/membership-identity-tee-artifact.tar.gz",
            "sonari-verifier-runner/$COMMIT_SHA/membership-identity-tee.eif",
            "scripts/aws_sonari_verifier_runner_deploy_plan.ts",
            "--earthquake-eif-sha256",
            "run-earthquake-enclave",
            "/get_attestation",
            "/process_data",
            "--relayer-network mainnet --world-id-proof-mode dummy",
            "parameterOverrideArgs",
            "RelayerTarget=<PACKAGE_ID>::accessor::create_disaster_event_from_signed_payload",
            "AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_TARGET",
            "AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_TOKEN_SECRET_ARN",
            "AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN",
            "suiprivkey",
            "WALRUS_UPLOAD_RELAY_URL",
            "https://upload-relay.testnet.walrus.space",
            "--source-archiver-token-secret-arn",
            "--source-archiver-private-key-secret-arn",
            "aws cloudformation deploy",
            "--template-file infra/aws/sonari-verifier-runner/template.yaml",
            "--s3-bucket",
            "sonari-verifier-runner/$COMMIT_SHA/cloudformation",
            "ScheduleState=DISABLED",
        ]);
    });

    it("documents runtime smoke gates for both verifier kinds and idle resources", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "earthquake manual workflow",
            "source_archive_summary",
            "source_archive_status",
            "relayer_digest",
            "disaster_event_object_id",
            "SourceArchiverFunctionUrlOutput",
            "membership dummy proof smoke",
            "devnet または testnet 専用",
            "mainnet dummy proof が deploy 前に拒否",
            "未解決の CloudWatch log error",
            "RunnerAutoScalingGroupName",
            "DesiredCapacity",
            "InService",
            "running EC2 instances が `0`",
            "WatcherScheduleName",
            "BatchScheduleName",
            "DISABLED",
        ]);
    });

    it("documents existing AdminCap-gated earthquake PCR config entrypoints", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "admin::create_earthquake_verifier_config",
            "admin::update_earthquake_verifier_config_pcrs",
            "admin::disable_earthquake_verifier_config",
            "`&AdminCap`",
            "既存の `admin.move` 関数で足りるため、新しい wrapper は追加しません",
            "metadata_verifier::register_enclave_instance",
            "accessor::create_disaster_event_from_signed_payload",
        ]);
    });

    it("documents Earthquake EIF PCR extraction and Move byte-vector format", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "pnpm build:aws-earthquake-eif",
            "nitro-cli build-enclave",
            "PCR0 / PCR1 / PCR2",
            "48 byte SHA-384",
            "Move の `vector<u8>`",
            "hex を 2 桁ずつ byte に分けます",
            "EarthquakeTeeEifSha256 は EIF file の SHA-256 checksum",
            "PCR0/1/2 は attestation document の measurement",
        ]);
    });

    it("documents AdminCap PCR transactions, key separation, and verification scope", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "PACKAGE_ID",
            "ADMIN_ADDRESS",
            "ADMIN_CAP_ID",
            "VERIFIER_REGISTRY_ID",
            '--sender "$ADMIN_ADDRESS"',
            "--function create_earthquake_verifier_config",
            "--function update_earthquake_verifier_config_pcrs",
            "--function disable_earthquake_verifier_config",
            "AdminCap を持つ管理者 wallet は AWS に置きません",
            "Codex が動く管理端末",
            "AWS Secrets Manager に入れてはいけません",
            "Relayer wallet は AdminCap を持ちません",
            "`VerifierConfigCreated` と `VerifierConfigPcrsUpdated`",
            "`VerifierConfigDisabled`",
            "この event は PCR0/1/2 を持たないため",
            "pnpm check:move",
            "本番 AWS 実行はこの手順の必須検証ではありません",
        ]);
        expectAdminCallIncludesSender(readme, "create_earthquake_verifier_config");
        expectAdminCallIncludesSender(readme, "update_earthquake_verifier_config_pcrs");
        expectAdminCallIncludesSender(readme, "disable_earthquake_verifier_config");
    });

    it("documents existing AdminCap-gated membership identity PCR config entrypoints", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "admin::create_identity_verifier_config",
            "admin::update_identity_verifier_config_pcrs",
            "admin::disable_identity_verifier_config",
        ]);
    });

    it("documents membership identity EIF PCR extraction and Move byte-vector format", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "pnpm build:aws-membership-identity-eif",
            "### Membership Identity EIF PCRs",
            "nitro-cli describe-eif",
        ]);
    });

    it("documents membership identity AdminCap PCR transactions and register/update semantics", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "--function create_identity_verifier_config",
            "--function update_identity_verifier_config_pcrs",
            "--function disable_identity_verifier_config",
            "全部 dry-run は登録済み enclave state を要するため不可",
        ]);
        expectAdminCallIncludesSender(readme, "create_identity_verifier_config");
        expectAdminCallIncludesSender(readme, "update_identity_verifier_config_pcrs");
        expectAdminCallIncludesSender(readme, "disable_identity_verifier_config");
    });

    it("limits old AWS-side cleanup to files after successful new-stack smoke", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "新 stack の smoke が成功",
            "resource inventory で idle が確認",
            "古い S3 prefix",
            "古い Lambda zip object",
            "古い TEE tarball object",
            "古い EIF object",
            "古い SHA object",
            "旧単独 earthquake runner stack と GitHub environment",
        ]);
    });

    it("documents cost/resource checks and rollback without relying on the old stack", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "Cost Explorer",
            "Cost Explorer は遅延",
            "deploy 前",
            "cleanup 後",
            "running EC2",
            "ASG desired/running",
            "NAT gateway",
            "Elastic IP",
            "load balancer",
            "EventBridge schedule",
            "CloudFormation stack",
            "S3 inventory",
            "Rollback は Git revert と redeploy",
        ]);
        expect(readme).not.toContain("rollback to earthquake-runner");
        expect(readme).not.toContain("rollback to membership-identity-runner");
    });

    it("does not document sensitive local material or static AWS keys", async () => {
        const readme = await readReadme();

        expect(readme).not.toMatch(/secret value/i);
        expect(readme).not.toContain(".local");
        expect(readme).not.toMatch(/private credential/i);
        expect(readme).not.toContain("AWS_ACCESS_KEY_ID");
        expect(readme).not.toContain("AWS_SECRET_ACCESS_KEY");
    });

    it("documents the replication units required to add a third verifier_kind", async () => {
        const readme = await readReadme();

        // The section must name the CloudFormation Parameters block to duplicate
        // (TeeArtifact bucket/key/sha256, Eif bucket/key/sha256,
        // NitroEnclaveProcessCommand, and optionally ScheduleExpression).
        expectContainsAll(readme, [
            "3 例目",
            "TeeArtifactS3Bucket",
            "TeeArtifactS3Key",
            "TeeArtifactSha256",
            "TeeEifS3Bucket",
            "TeeEifS3Key",
            "TeeEifSha256",
            "NitroEnclaveProcessCommand",
        ]);

        // The dispatcher extension point must be listed explicitly.
        expectContainsAll(readme, [
            "run-sonari-verifier",
            "SONARI_VERIFIER_KIND",
            "case",
            "enclave wrapper",
        ]);

        // The Lambda env namespace extension must be called out.
        expectContainsAll(readme, ["RunnerControlLambda", "env namespace"]);

        // StateMachine and schedule duplication must be mentioned.
        expectContainsAll(readme, ["StateMachine", "ScheduleExpression", "BatchSchedule"]);

        // The runner src SONARI_VERIFIER_KIND export must be mentioned.
        expectContainsAll(readme, ["buildSsmShellCommand", "SONARI_VERIFIER_KIND"]);

        // The deploy workflow steps for the new kind must be mentioned.
        expectContainsAll(readme, ["pnpm build:aws-", "EIF", "PCR"]);
    });

    it("documents that earthquake RELAYER_* namespace must not be changed when adding a new verifier", async () => {
        const readme = await readReadme();

        // The README must make clear that earthquake RELAYER_* env vars are
        // earthquake-specific and must not be renamed or moved when a third
        // verifier_kind is added.
        expectContainsAll(readme, ["RELAYER_MODE", "RELAYER_NETWORK", "earthquake"]);

        // The README must mention that the earthquake schedule default rate(5 minutes)
        // must not be changed when extending to a third verifier kind.
        expect(readme).toContain("rate(5 minutes)");
    });
});
