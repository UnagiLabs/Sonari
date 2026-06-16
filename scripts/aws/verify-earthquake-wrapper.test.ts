import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AwsCli } from "./shared.js";
import {
    buildProcessDataS3UploadCommand,
    readEarthquakeWrapperS3Result,
    runVerifyEarthquakeWrapper,
} from "./verify-earthquake-wrapper.js";

describe("AWS earthquake wrapper verification script", () => {
    it("waits for ASG InService, SSM Online, and bootstrap marker before wrapper calls", async () => {
        const cli = new RecordingAwsCli();

        await runVerifyEarthquakeWrapper({
            aws: cli,
            stack: "sonari-verifier-runner-dev",
            expectedAccount: "595103996064",
            sourceEventId: "us6000m0xl",
            poll: { intervalMs: 0, timeoutMs: 1 },
        });

        const operations = cli.operations.map((operation) => operation.label);
        expect(operations).toEqual(
            expect.arrayContaining([
                "sts:get-caller-identity",
                "cloudformation:describe-stacks",
                "scheduler:get-schedule:watcher-schedule",
                "scheduler:get-schedule:batch-schedule",
                "autoscaling:update-auto-scaling-group:1",
                "autoscaling:describe-auto-scaling-groups",
                "ssm:describe-instance-information",
                "ssm:send-command:bootstrap-marker",
                "ssm:send-command:earthquake-wrapper-socat-timeout",
                "ssm:send-command:health_check",
                "ssm:send-command:get_attestation",
                "ssm:send-command:process_data",
                "s3api:get-object",
                "autoscaling:update-auto-scaling-group:0",
                "scheduler:get-schedule:watcher-schedule",
                "scheduler:get-schedule:batch-schedule",
            ]),
        );
        expect(operations.indexOf("ssm:describe-instance-information")).toBeLessThan(
            operations.indexOf("ssm:send-command:bootstrap-marker"),
        );
        expect(operations.indexOf("ssm:send-command:bootstrap-marker")).toBeLessThan(
            operations.indexOf("ssm:send-command:health_check"),
        );

        const asgUpdates = cli.operations.filter((operation) =>
            operation.args.includes("update-auto-scaling-group"),
        );
        expect(asgUpdates[0]?.args).toContain("--desired-capacity");
        expect(asgUpdates[0]?.args).not.toContain("--no-honor-cooldown");

        const processDataCommand = cli.ssmCommands.get("process_data");
        expect(processDataCommand).toContain("aws s3 cp --only-show-errors");
        expect(processDataCommand).toContain("results/earthquake-wrapper-results/");

        const s3GetObject = cli.operations.find(
            (operation) => operation.label === "s3api:get-object",
        );
        expect(s3GetObject?.args).toEqual(
            expect.arrayContaining([
                "s3api",
                "get-object",
                "--bucket",
                "runner-results",
                "--key",
                "results/earthquake-wrapper-results/test-run.json",
            ]),
        );
    });

    it("cleans up ASG capacity and rechecks disabled schedules when wrapper verification fails", async () => {
        const cli = new RecordingAwsCli({ failProcessData: true });

        await expect(
            runVerifyEarthquakeWrapper({
                aws: cli,
                stack: "sonari-verifier-runner-dev",
                expectedAccount: "595103996064",
                sourceEventId: "us6000m0xl",
                poll: { intervalMs: 0, timeoutMs: 1 },
            }),
        ).rejects.toThrow("process_data failed");

        const operations = cli.operations.map((operation) => operation.label);
        expect(operations).toContain("autoscaling:update-auto-scaling-group:0");
        expect(
            operations.slice(operations.lastIndexOf("autoscaling:update-auto-scaling-group:0")),
        ).toEqual(
            expect.arrayContaining([
                "autoscaling:describe-auto-scaling-groups:empty",
                "ec2:describe-instances:empty",
                "scheduler:get-schedule:watcher-schedule",
                "scheduler:get-schedule:batch-schedule",
            ]),
        );
    });

    it("cleans up when process_data SSM succeeds but S3 reference validation fails", async () => {
        const cli = new RecordingAwsCli({
            processDataReference: {
                status: "ok",
                result_s3_uri: "s3://runner-results/results/earthquake-wrapper-results/test-run.json",
                sha256: "not-a-sha",
                bytes: 1,
            },
        });

        await expect(
            runVerifyEarthquakeWrapper({
                aws: cli,
                stack: "sonari-verifier-runner-dev",
                expectedAccount: "595103996064",
                sourceEventId: "us6000m0xl",
                poll: { intervalMs: 0, timeoutMs: 1 },
            }),
        ).rejects.toThrow("process_data S3 reference sha256");

        const operations = cli.operations.map((operation) => operation.label);
        expect(operations).toContain("ssm:get-command-invocation:process_data");
        expect(operations).not.toContain("s3api:get-object");
        expect(operations).toContain("autoscaling:update-auto-scaling-group:0");
        expect(
            operations.slice(operations.lastIndexOf("autoscaling:update-auto-scaling-group:0")),
        ).toEqual(
            expect.arrayContaining([
                "autoscaling:describe-auto-scaling-groups:empty",
                "ec2:describe-instances:empty",
                "scheduler:get-schedule:watcher-schedule",
                "scheduler:get-schedule:batch-schedule",
            ]),
        );
    });

    it("cleans up when process_data SSM succeeds but S3 result validation fails", async () => {
        const resultText = JSON.stringify(finalizedWrapperResult());
        const cli = new RecordingAwsCli({
            s3Body: resultText,
            processDataReference: {
                status: "ok",
                result_s3_uri: "s3://runner-results/results/earthquake-wrapper-results/test-run.json",
                sha256: "0".repeat(64),
                bytes: Buffer.byteLength(resultText, "utf8"),
            },
        });

        await expect(
            runVerifyEarthquakeWrapper({
                aws: cli,
                stack: "sonari-verifier-runner-dev",
                expectedAccount: "595103996064",
                sourceEventId: "us6000m0xl",
                poll: { intervalMs: 0, timeoutMs: 1 },
            }),
        ).rejects.toThrow("process_data result sha256 mismatch");

        const operations = cli.operations.map((operation) => operation.label);
        expect(operations).toContain("ssm:get-command-invocation:process_data");
        expect(operations).toContain("s3api:get-object");
        expect(operations).toContain("autoscaling:update-auto-scaling-group:0");
        expect(
            operations.slice(operations.lastIndexOf("autoscaling:update-auto-scaling-group:0")),
        ).toEqual(
            expect.arrayContaining([
                "autoscaling:describe-auto-scaling-groups:empty",
                "ec2:describe-instances:empty",
                "scheduler:get-schedule:watcher-schedule",
                "scheduler:get-schedule:batch-schedule",
            ]),
        );
    });

    it("downloads and validates process_data result JSON from an S3 reference", async () => {
        const resultText = JSON.stringify(finalizedWrapperResult());
        const cli = new S3ObjectAwsCli(resultText);

        await expect(
            readEarthquakeWrapperS3Result({
                aws: cli,
                expectedBucket: "runner-results",
                reference: {
                    status: "ok",
                    result_s3_uri:
                        "s3://runner-results/results/earthquake-wrapper-results/result.json",
                    sha256: createHash("sha256").update(resultText).digest("hex"),
                    bytes: Buffer.byteLength(resultText, "utf8"),
                },
            }),
        ).resolves.toEqual(finalizedWrapperResult());

        expect(cli.operations).toHaveLength(1);
        expect(cli.operations[0]?.slice(0, 6)).toEqual([
            "s3api",
            "get-object",
            "--bucket",
            "runner-results",
            "--key",
            "results/earthquake-wrapper-results/result.json",
        ]);
        const outputPath = cli.operations[0]?.at(-1);
        expect(typeof outputPath).toBe("string");
        expect(outputPath).not.toBe("-");
    });

    it("builds a process_data command that uploads wrapper stdout to S3 and prints only a reference JSON", () => {
        const command = buildProcessDataS3UploadCommand({
            input: { action: "process_data", payload: { source_event_id: "us6000m0xl" } },
            bucket: "runner-results",
            runId: "run-123",
        });

        expect(command).toContain("/opt/sonari/bin/run-earthquake-enclave > \"$result_file\"");
        expect(command).toContain(
            'result_key="results/earthquake-wrapper-results/run-123.json"',
        );
        expect(command).toContain(
            'aws s3 cp --only-show-errors "$result_file" "s3://runner-results/$result_key"',
        );
        expect(command).toContain('sha256="$(sha256sum "$result_file" | awk \'{ print $1 }\')"');
        expect(command).toContain('bytes="$(wc -c < "$result_file" | tr -d \'[:space:]\')"');
        expect(command).toContain("JSON.stringify({");
        expect(command).toContain('status: "ok"');
        expect(command).toContain("result_s3_uri: process.env.RESULT_S3_URI");
        expect(command).toContain("sha256: process.env.RESULT_SHA256");
        expect(command).toContain("bytes: Number(process.env.RESULT_BYTES)");
        expect(command).not.toContain("CommandId");
    });

    it("rejects S3 result references with invalid metadata or downloaded bytes", async () => {
        const resultText = JSON.stringify(finalizedWrapperResult());
        const sha256 = createHash("sha256").update(resultText).digest("hex");

        await expect(
            readEarthquakeWrapperS3Result({
                aws: new S3ObjectAwsCli(resultText),
                expectedBucket: "runner-results",
                reference: {
                    status: "failed",
                    result_s3_uri:
                        "s3://runner-results/results/earthquake-wrapper-results/result.json",
                    sha256,
                    bytes: Buffer.byteLength(resultText, "utf8"),
                },
            }),
        ).rejects.toThrow('Expected process_data S3 reference status "ok"');

        await expect(
            readEarthquakeWrapperS3Result({
                aws: new S3ObjectAwsCli(resultText),
                expectedBucket: "runner-results",
                reference: {
                    status: "ok",
                    result_s3_uri: "s3://other/results/earthquake-wrapper-results/result.json",
                    sha256,
                    bytes: Buffer.byteLength(resultText, "utf8"),
                },
            }),
        ).rejects.toThrow("process_data result bucket mismatch");

        await expect(
            readEarthquakeWrapperS3Result({
                aws: new S3ObjectAwsCli(resultText),
                expectedBucket: "runner-results",
                reference: {
                    status: "ok",
                    result_s3_uri: "s3://runner-results/results/other/result.json",
                    sha256,
                    bytes: Buffer.byteLength(resultText, "utf8"),
                },
            }),
        ).rejects.toThrow("process_data result key must be under");

        await expect(
            readEarthquakeWrapperS3Result({
                aws: new S3ObjectAwsCli(resultText),
                expectedBucket: "runner-results",
                reference: {
                    status: "ok",
                    result_s3_uri:
                        "s3://runner-results/results/earthquake-wrapper-results/result.json",
                    sha256: "0".repeat(64),
                    bytes: Buffer.byteLength(resultText, "utf8"),
                },
            }),
        ).rejects.toThrow("process_data result sha256 mismatch");

        await expect(
            readEarthquakeWrapperS3Result({
                aws: new S3ObjectAwsCli(resultText),
                expectedBucket: "runner-results",
                reference: {
                    status: "ok",
                    result_s3_uri:
                        "s3://runner-results/results/earthquake-wrapper-results/result.json",
                    sha256,
                    bytes: Buffer.byteLength(resultText, "utf8") + 1,
                },
            }),
        ).rejects.toThrow("process_data result byte length mismatch");
    });
});

type RecordingAwsCliOptions = {
    failProcessData?: boolean;
    processDataReference?: unknown;
    s3Body?: string;
};

class RecordingAwsCli implements AwsCli {
    readonly operations: Array<{ label: string; args: readonly string[] }> = [];
    readonly ssmCommands = new Map<string, string>();
    private readonly options: RecordingAwsCliOptions;

    constructor(options: RecordingAwsCliOptions = {}) {
        this.options = options;
    }

    async json(args: readonly string[]): Promise<unknown> {
        const label = this.label(args);
        this.operations.push({ label, args });
        if (label.startsWith("ssm:send-command:")) {
            await this.recordSsmCommand(label, args);
        }

        switch (label) {
            case "sts:get-caller-identity":
                return { Account: "595103996064" };
            case "cloudformation:describe-stacks":
                return stackResponse();
            case "scheduler:get-schedule:watcher-schedule":
            case "scheduler:get-schedule:batch-schedule":
                return { State: "DISABLED" };
            case "autoscaling:describe-auto-scaling-groups":
                return {
                    AutoScalingGroups: [
                        {
                            DesiredCapacity: 1,
                            MaxSize: 1,
                            Instances: [{ InstanceId: "i-ready", LifecycleState: "InService" }],
                        },
                    ],
                };
            case "autoscaling:describe-auto-scaling-groups:empty":
                return {
                    AutoScalingGroups: [{ DesiredCapacity: 0, MaxSize: 1, Instances: [] }],
                };
            case "ssm:describe-instance-information":
                return {
                    InstanceInformationList: [{ InstanceId: "i-ready", PingStatus: "Online" }],
                };
            case "ssm:send-command:bootstrap-marker":
            case "ssm:send-command:earthquake-wrapper-socat-timeout":
            case "ssm:send-command:health_check":
            case "ssm:send-command:get_attestation":
            case "ssm:send-command:process_data":
                return { Command: { CommandId: `${label}-command` } };
            case "ssm:get-command-invocation:bootstrap-marker":
                return { Status: "Success", StandardOutputContent: "" };
            case "ssm:get-command-invocation:earthquake-wrapper-socat-timeout":
                return { Status: "Success", StandardOutputContent: "180\n" };
            case "ssm:get-command-invocation:health_check":
                return {
                    Status: "Success",
                    StandardOutputContent: JSON.stringify({ status: "ok" }),
                };
            case "ssm:get-command-invocation:get_attestation":
                return {
                    Status: "Success",
                    StandardOutputContent: JSON.stringify({
                        attestation: { public_key: "public-key-1" },
                    }),
                };
            case "ssm:get-command-invocation:process_data":
                if (this.options.failProcessData) {
                    return { Status: "Failed", StandardErrorContent: "process_data failed" };
                }
                return {
                    Status: "Success",
                    StandardOutputContent: JSON.stringify(
                        this.options.processDataReference ?? processDataS3Reference(),
                    ),
                };
            case "s3api:get-object": {
                const destination = args.at(-1);
                if (typeof destination !== "string" || destination === "-") {
                    throw new Error("s3api get-object must write to a local file");
                }
                await writeFile(
                    destination,
                    this.options.s3Body ?? JSON.stringify(finalizedWrapperResult()),
                );
                return {};
            }
            case "ec2:describe-instances:empty":
                return { Reservations: [] };
            default:
                if (label.startsWith("autoscaling:update-auto-scaling-group")) {
                    return {};
                }
                throw new Error(`unexpected AWS call: ${label}`);
        }
    }

    private async recordSsmCommand(label: string, args: readonly string[]): Promise<void> {
        const parameters = args[args.indexOf("--parameters") + 1];
        if (parameters === undefined || !parameters.startsWith("file://")) {
            return;
        }
        const text = await readFile(parameters.slice("file://".length), "utf8");
        const value: unknown = JSON.parse(text);
        if (!isRecord(value) || !Array.isArray(value.commands)) {
            return;
        }
        const command = value.commands[0];
        if (typeof command !== "string") {
            return;
        }
        this.ssmCommands.set(label.replace("ssm:send-command:", ""), command);
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
        if (service === "autoscaling" && operation === "update-auto-scaling-group") {
            return `autoscaling:update-auto-scaling-group:${args[args.indexOf("--desired-capacity") + 1]}`;
        }
        if (service === "autoscaling" && operation === "describe-auto-scaling-groups") {
            return this.operations.some(
                (entry) => entry.label === "autoscaling:update-auto-scaling-group:0",
            )
                ? "autoscaling:describe-auto-scaling-groups:empty"
                : "autoscaling:describe-auto-scaling-groups";
        }
        if (service === "ssm" && operation === "describe-instance-information") {
            return "ssm:describe-instance-information";
        }
        if (service === "ssm" && operation === "send-command") {
            const params = args[args.indexOf("--parameters") + 1] ?? "";
            if (!params.startsWith("file://")) {
                throw new Error("SSM parameters must use file:// JSON");
            }
            const comment = args[args.indexOf("--comment") + 1] ?? "";
            return `ssm:send-command:${comment}`;
        }
        if (service === "ssm" && operation === "get-command-invocation") {
            const commandId = args[args.indexOf("--command-id") + 1] ?? "";
            return `ssm:get-command-invocation:${commandId.replace(/-command$/, "").replace(/^ssm:send-command:/, "")}`;
        }
        if (service === "ec2" && operation === "describe-instances") {
            return "ec2:describe-instances:empty";
        }
        if (service === "s3api" && operation === "get-object") {
            return "s3api:get-object";
        }
        return `${service}:${operation}`;
    }
}

class S3ObjectAwsCli implements AwsCli {
    readonly operations: readonly string[][] = [];
    private readonly body: string;

    constructor(body: string) {
        this.body = body;
    }

    async json(args: readonly string[]): Promise<unknown> {
        if (args[0] !== "s3api" || args[1] !== "get-object") {
            throw new Error(`unexpected AWS call: ${args.join(" ")}`);
        }
        (this.operations as string[][]).push([...args]);
        const destination = args.at(-1);
        if (typeof destination !== "string" || destination === "-") {
            throw new Error("s3api get-object must write to a local file");
        }
        await writeFile(destination, this.body);
        return {};
    }
}

function finalizedWrapperResult(): unknown {
    const affectedCellsRef = {
        uri: "walrus://blob/affected-cells",
        source_hash: `0x${"66".repeat(32)}`,
    };
    const evidenceManifestRef = {
        uri: "walrus://blob/evidence-manifest",
        source_hash: `0x${"77".repeat(32)}`,
    };
    const evidenceManifest = {
        schema_version: 1,
        oracle_version: 1,
        event_uid: `0x${"11".repeat(32)}`,
        event_revision: 1,
        hazard_type: "EARTHQUAKE",
        source_event_id: "us6000m0xl",
        sources: [],
        earthquake: {
            title: "M 7.1 - Fixture",
            region: "Fixture Region",
            occurred_at_ms: 1_700_000_000_000,
            magnitude_x100: 710,
            source_updated_at_ms: 1_700_000_050_000,
        },
        affected_cells: {
            uri: affectedCellsRef.uri,
            hash: affectedCellsRef.source_hash,
            root: `0x${"44".repeat(32)}`,
            count: 1,
            geo_resolution: 7,
        },
    };
    const evidenceManifestHash = `0x${createHash("sha256")
        .update(JSON.stringify(evidenceManifest))
        .digest("hex")}`;
    return {
        status: "finalized",
        source_event_id: "us6000m0xl",
        payload: {
            intent: 1,
            oracle_version: 1,
            event_uid: `0x${"11".repeat(32)}`,
            event_revision: 1,
            source_event_id: "us6000m0xl",
            title: "M 7.1 - Fixture",
            region: "Fixture Region",
            occurred_at_ms: 1_700_000_000_000,
            hazard_type: 1,
            status: 3,
            severity_band: 3,
            affected_cells_root: `0x${"44".repeat(32)}`,
            affected_cell_count: 1,
            evidence_manifest_uri: evidenceManifestRef.uri,
            evidence_manifest_hash: evidenceManifestHash,
            verified_at_ms: 1_700_000_100_000,
            freshness_deadline_ms: 1_700_021_700_000,
        },
        raw_data_manifest: {
            entries: [{ path: "grid.xml" }, { path: "detail.json" }],
        },
        affected_cells_ref: affectedCellsRef,
        evidence_manifest_ref: evidenceManifestRef,
        evidence_manifest: evidenceManifest,
        attestation: { public_key: "public-key-1" },
        signature: { public_key: "public-key-1" },
    };
}

function processDataS3Reference(): unknown {
    const resultText = JSON.stringify(finalizedWrapperResult());
    return {
        status: "ok",
        result_s3_uri: "s3://runner-results/results/earthquake-wrapper-results/test-run.json",
        sha256: createHash("sha256").update(resultText).digest("hex"),
        bytes: Buffer.byteLength(resultText, "utf8"),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stackResponse(): unknown {
    return {
        Stacks: [
            {
                StackName: "sonari-verifier-runner-dev",
                StackStatus: "UPDATE_COMPLETE",
                Outputs: [
                    { OutputKey: "RunnerAutoScalingGroupName", OutputValue: "runner-asg" },
                    { OutputKey: "WatcherScheduleName", OutputValue: "watcher-schedule" },
                    { OutputKey: "BatchScheduleName", OutputValue: "batch-schedule" },
                    { OutputKey: "EarthquakeRunnerStateMachineArn", OutputValue: "arn:runner" },
                    { OutputKey: "EventsTableName", OutputValue: "events" },
                    { OutputKey: "ManualWatcherLambdaName", OutputValue: "manual-watcher" },
                    { OutputKey: "RunnerResultBucketName", OutputValue: "runner-results" },
                    { OutputKey: "DeployedGitCommitSha", OutputValue: "abc123" },
                ],
            },
        ],
    };
}
