import { describe, expect, it } from "vitest";
import type { AwsCli } from "./shared.js";
import { runVerifyEarthquakeWrapper } from "./verify-earthquake-wrapper.js";

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
});

type RecordingAwsCliOptions = {
    failProcessData?: boolean;
};

class RecordingAwsCli implements AwsCli {
    readonly operations: Array<{ label: string; args: readonly string[] }> = [];
    private readonly options: RecordingAwsCliOptions;

    constructor(options: RecordingAwsCliOptions = {}) {
        this.options = options;
    }

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
                    StandardOutputContent: JSON.stringify({
                        status: "finalized",
                        source_event_id: "us6000m0xl",
                        raw_data_manifest: {
                            entries: [{ path: "grid.xml" }, { path: "detail.json" }],
                        },
                        attestation: { public_key: "public-key-1" },
                        signature: { public_key: "public-key-1" },
                    }),
                };
            case "ec2:describe-instances:empty":
                return { Reservations: [] };
            default:
                if (label.startsWith("autoscaling:update-auto-scaling-group")) {
                    return {};
                }
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
        return `${service}:${operation}`;
    }
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
