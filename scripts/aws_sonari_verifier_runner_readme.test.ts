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
            "AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_WALRUS_ENV_SECRET_ARN",
            "AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_WALRUS_LAYER_ARN",
            "--source-archiver-token-secret-arn",
            "--source-archiver-walrus-env-secret-arn",
            "--source-archiver-walrus-layer-arn",
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
});
