import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AwsCli } from "./shared.js";
import { runVerifySourceArchiver } from "./verify-source-archiver.js";

describe("AWS SourceArchiver verification script", () => {
    it("stages a source artifact, invokes SourceArchiver Lambda, checks logs, and asserts idle", async () => {
        const cli = new RecordingAwsCli();

        const result = await runVerifySourceArchiver({
            aws: cli,
            stack: "sonari-verifier-runner-dev",
            expectedAccount: "595103996064",
            region: "ap-northeast-1",
            nowMs: () => 1_700_000_000_000,
            artifactBytes: new TextEncoder().encode("source-archiver verification\n"),
            blobIdForBytes: async () => "expectedBlob123",
            poll: { intervalMs: 0, timeoutMs: 1 },
        });

        expect(result).toMatchObject({
            sourceArchiverLambdaName: "source-archiver",
            sourceArchiverUrl: "https://source-archiver.lambda-url.test/",
            resultBucket: "runner-results",
            artifactS3Key:
                "source-artifacts/source-archiver-verification/1700000000000-artifact.bin",
            expectedWalrusBlobId: "expectedBlob123",
            walrusBlobId: "expectedBlob123",
            successLogEvents: 1,
            idle: true,
        });

        const operations = cli.operations.map((operation) => operation.label);
        expect(operations).toEqual(
            expect.arrayContaining([
                "sts:get-caller-identity",
                "cloudformation:describe-stacks",
                "scheduler:get-schedule:watcher-schedule",
                "scheduler:get-schedule:batch-schedule",
                "secretsmanager:get-secret-value:source-archiver-token-secret",
                "secretsmanager:get-secret-value:source-archiver-walrus-secret",
                "s3api:put-object",
                "lambda:invoke",
                "logs:filter-log-events:success",
                "logs:filter-log-events:all",
                "autoscaling:describe-auto-scaling-groups",
                "ec2:describe-instances:empty",
            ]),
        );
        expect(cli.putObjectKeys).toEqual([
            "source-artifacts/source-archiver-verification/1700000000000-artifact.bin",
        ]);
        expect(cli.lambdaPayloads).toEqual([
            {
                headers: { "x-sonari-source-archiver-token": "source-archiver-token" },
                body: JSON.stringify({
                    artifact_s3_key:
                        "source-artifacts/source-archiver-verification/1700000000000-artifact.bin",
                    expected_walrus_blob_id: "expectedBlob123",
                    source_hash:
                        "0x661cb916f0c538771140a7901341fe0260b21afe38df0f5202302df172be6d8d",
                    size_bytes: 29,
                }),
            },
        ]);
    });

    it("fails when CloudWatch logs contain source archiver secret material", async () => {
        const cli = new RecordingAwsCli({ leakSecretInLogs: true });

        await expect(
            runVerifySourceArchiver({
                aws: cli,
                stack: "sonari-verifier-runner-dev",
                expectedAccount: "595103996064",
                region: "ap-northeast-1",
                nowMs: () => 1_700_000_000_000,
                blobIdForBytes: async () => "expectedBlob123",
                poll: { intervalMs: 0, timeoutMs: 1 },
            }),
        ).rejects.toThrow("CloudWatch logs contained forbidden SourceArchiver secret material");
    });
});

type RecordingAwsCliOptions = {
    leakSecretInLogs?: boolean;
};

class RecordingAwsCli implements AwsCli {
    readonly operations: Array<{ label: string; args: readonly string[] }> = [];
    readonly putObjectKeys: string[] = [];
    readonly lambdaPayloads: unknown[] = [];

    constructor(private readonly options: RecordingAwsCliOptions = {}) {}

    async json(args: readonly string[]): Promise<unknown> {
        const label = this.label(args);
        this.operations.push({ label, args });

        switch (label) {
            case "sts:get-caller-identity":
                return { Account: "595103996064" };
            case "cloudformation:describe-stacks":
                return stackResponse();
            case "scheduler:get-schedule:watcher-schedule":
            case "scheduler:get-schedule:batch-schedule":
                return { State: "DISABLED" };
            case "secretsmanager:get-secret-value:source-archiver-token-secret":
                return { SecretString: "source-archiver-token" };
            case "secretsmanager:get-secret-value:source-archiver-walrus-secret":
                return {
                    SecretString: JSON.stringify({
                        SONARI_WALRUS_CLIENT_CONFIG_YAML: "walrus-secret-config-yaml",
                        SONARI_SUI_WALLET_CONFIG_YAML: "wallet-secret-config-yaml",
                        SONARI_SUI_KEYSTORE_JSON: "keystore-secret-json",
                    }),
                };
            case "s3api:put-object":
                this.putObjectKeys.push(args[args.indexOf("--key") + 1] ?? "");
                return {};
            case "lambda:invoke": {
                const payload = args[args.indexOf("--payload") + 1];
                this.lambdaPayloads.push(JSON.parse(payload ?? "{}") as unknown);
                const responsePath = args.at(-1);
                if (responsePath === undefined) {
                    throw new Error("lambda invoke response path missing");
                }
                await writeFile(
                    responsePath,
                    JSON.stringify({
                        statusCode: 200,
                        body: JSON.stringify({ walrus_blob_id: "expectedBlob123" }),
                    }),
                );
                return { StatusCode: 200 };
            }
            case "logs:filter-log-events:success":
                return {
                    events: [
                        {
                            message: JSON.stringify({
                                event: "source_archiver.walrus_store.success",
                                artifactS3Key:
                                    "source-artifacts/source-archiver-verification/1700000000000-artifact.bin",
                                walrusBlobId: "expectedBlob123",
                            }),
                        },
                    ],
                };
            case "logs:filter-log-events:all":
                return {
                    events: [
                        {
                            message: this.options.leakSecretInLogs
                                ? "walrus-secret-config-yaml"
                                : "source_archiver.walrus_store.success",
                        },
                    ],
                };
            case "autoscaling:describe-auto-scaling-groups":
                return {
                    AutoScalingGroups: [{ DesiredCapacity: 0, MaxSize: 1, Instances: [] }],
                };
            case "ec2:describe-instances:empty":
                return { Reservations: [] };
            default:
                throw new Error(`unexpected AWS call: ${label}`);
        }
    }

    private label(args: readonly string[]): string {
        const service = args[0];
        const operation = args[1];
        if (service === "sts" && operation === "get-caller-identity") {
            return "sts:get-caller-identity";
        }
        if (service === "cloudformation" && operation === "describe-stacks") {
            return "cloudformation:describe-stacks";
        }
        if (service === "scheduler" && operation === "get-schedule") {
            return `scheduler:get-schedule:${args[args.indexOf("--name") + 1]}`;
        }
        if (service === "secretsmanager" && operation === "get-secret-value") {
            return `secretsmanager:get-secret-value:${args[args.indexOf("--secret-id") + 1]}`;
        }
        if (service === "s3api" && operation === "put-object") {
            return "s3api:put-object";
        }
        if (service === "lambda" && operation === "invoke") {
            return "lambda:invoke";
        }
        if (service === "logs" && operation === "filter-log-events") {
            return args.includes('"source_archiver.walrus_store.success"')
                ? "logs:filter-log-events:success"
                : "logs:filter-log-events:all";
        }
        if (service === "autoscaling" && operation === "describe-auto-scaling-groups") {
            return "autoscaling:describe-auto-scaling-groups";
        }
        if (service === "ec2" && operation === "describe-instances") {
            return "ec2:describe-instances:empty";
        }
        return `${service}:${operation}`;
    }
}

function stackResponse(): unknown {
    return {
        Stacks: [
            {
                StackName: "sonari-verifier-runner-dev",
                StackStatus: "UPDATE_COMPLETE",
                Parameters: [
                    {
                        ParameterKey: "SourceArchiverTokenSecretArn",
                        ParameterValue: "source-archiver-token-secret",
                    },
                    {
                        ParameterKey: "SourceArchiverWalrusEnvSecretArn",
                        ParameterValue: "source-archiver-walrus-secret",
                    },
                ],
                Outputs: [
                    { OutputKey: "RunnerResultBucketName", OutputValue: "runner-results" },
                    { OutputKey: "RunnerAutoScalingGroupName", OutputValue: "runner-asg" },
                    { OutputKey: "WatcherScheduleName", OutputValue: "watcher-schedule" },
                    { OutputKey: "BatchScheduleName", OutputValue: "batch-schedule" },
                    { OutputKey: "SourceArchiverLambdaName", OutputValue: "source-archiver" },
                    {
                        OutputKey: "SourceArchiverFunctionUrlOutput",
                        OutputValue: "https://source-archiver.lambda-url.test/",
                    },
                ],
            },
        ],
    };
}
