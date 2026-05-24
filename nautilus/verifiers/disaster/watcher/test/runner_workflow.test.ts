import { describe, expect, it } from "vitest";
import type { TeeCoreResult } from "@sonari/oracle-shared";
import {
    createRunnerControlHandler,
    type AutoScalingClientLike,
    type Ec2ClientLike,
    type S3ClientLike,
    type SsmClientLike,
} from "../src/runner_workflow.js";
import { InMemoryStateRepository } from "../src/state.js";

describe("AWS runner workflow helper", () => {
    it("scales the runner ASG up and down", async () => {
        const autoscaling = new RecordingAutoScalingClient();
        const handler = createRunnerControlHandler({
            autoscaling,
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        await handler({ action: "start_instance", source_event_id: "us7000sonari" });
        await handler({ action: "stop_instance", source_event_id: "us7000sonari" });

        expect(autoscaling.capacities).toEqual([1, 0]);
    });

    it("fails closed when no running SSM-managed instance is available", async () => {
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client({ instances: [] }),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        await expect(
            handler({ action: "find_ready_instance", source_event_id: "us7000sonari" }),
        ).rejects.toThrow(/No running SSM-managed runner instance/);
    });

    it("dispatches SSM command and polls pending/success states", async () => {
        const ssm = new RecordingSsmClient({ invocationStatus: "Success" });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            now: () => 1_800_000_000_123,
            config: baseConfig(),
        });

        const dispatched = await handler({
            action: "dispatch_tee_command",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
        });
        const polled = await handler({
            action: "poll_command",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
            command_id: "cmd-123",
        });

        expect(dispatched).toMatchObject({
            command_id: "cmd-123",
            result_s3_key: "results/us7000sonari/1800000000123.json",
        });
        expect(polled).toMatchObject({ command_status: "SUCCEEDED" });
        expect(ssm.commands[0]).toContain("NITRO_ENCLAVE_PROCESS_COMMAND");
        expect(ssm.commands[0]).toContain("/tmp/sonari-tee-result-us7000sonari-1800000000123.json");
        expect(ssm.commands[0]).not.toContain("latest.json");
    });

    it("fails closed before dispatching SSM commands for malformed event IDs", async () => {
        const ssm = new RecordingSsmClient();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "dispatch_tee_command",
                source_event_id: "us7000$(touch bad)",
                instance_id: "i-123",
            }),
        ).rejects.toThrow(/invalid source_event_id/);
        await expect(
            handler({
                action: "dispatch_tee_command",
                source_event_id: "us7000/bad",
                instance_id: "i-123",
            }),
        ).rejects.toThrow(/invalid source_event_id/);
        expect(ssm.commands).toEqual([]);
    });

    it("single-quotes shell interpolations and creates unique result paths per dispatch", async () => {
        const ssm = new RecordingSsmClient();
        let nowMs = 1_800_000_000_123;
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            now: () => nowMs,
            config: {
                ...baseConfig(),
                resultBucket: "sonari-results-$(touch bad)",
                nitroEnclaveProcessCommand: "/opt/sonari/bin/run-enclave 'quoted value'",
            },
        });

        const first = await handler({
            action: "dispatch_tee_command",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
        });
        nowMs += 1;
        const second = await handler({
            action: "dispatch_tee_command",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
        });

        expect(first).toMatchObject({ result_s3_key: "results/us7000sonari/1800000000123.json" });
        expect(second).toMatchObject({ result_s3_key: "results/us7000sonari/1800000000124.json" });
        expect(ssm.commands[0]).toContain(
            "NITRO_ENCLAVE_PROCESS_COMMAND='/opt/sonari/bin/run-enclave '\\''quoted value'\\'''",
        );
        expect(ssm.commands[0]).toContain("'s3://sonari-results-$(touch bad)/$RESULT_S3_KEY'");
        expect(ssm.commands[0]).not.toContain('"s3://sonari-results-$(touch bad)');
        expect(ssm.commands[0]).toContain("/tmp/sonari-tee-result-us7000sonari-1800000000123.json");
        expect(ssm.commands[1]).toContain("/tmp/sonari-tee-result-us7000sonari-1800000000124.json");
    });

    it("rejects malformed S3 TEE results", async () => {
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client({ body: JSON.stringify({ status: "finalized" }) }),
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "read_result",
                source_event_id: "us7000sonari",
                result_s3_key: "results/us7000sonari/cmd-123.json",
            }),
        ).rejects.toThrow(/invalid finalized TEE result/);
    });

    it("applies TEE results to DynamoDB-compatible state and skips relayer when not configured", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_001_000,
            config: baseConfig(),
        });
        const result = pendingSourceResult("us7000sonari");

        await handler({ action: "apply_result", source_event_id: "us7000sonari", result });
        const relayer = await handler({
            action: "relayer_preview_or_dry_run",
            source_event_id: "us7000sonari",
            result,
        });

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "pending_source",
            error_code: "SHAKEMAP_PRODUCT_MISSING",
        });
        expect(relayer).toMatchObject({ relayer: "skipped" });
    });
});

function baseConfig() {
    return {
        autoScalingGroupName: "sonari-runner",
        resultBucket: "sonari-results",
        nitroEnclaveProcessCommand: "/opt/sonari/bin/run-enclave",
    };
}

function pendingSourceResult(sourceEventId: string): TeeCoreResult {
    return {
        status: "pending_source",
        source_event_id: sourceEventId,
        error_code: "SHAKEMAP_PRODUCT_MISSING",
    };
}

class RecordingAutoScalingClient implements AutoScalingClientLike {
    readonly capacities: number[] = [];

    async setDesiredCapacity(input: { desiredCapacity: number }): Promise<void> {
        this.capacities.push(input.desiredCapacity);
    }
}

class RecordingEc2Client implements Ec2ClientLike {
    constructor(
        private readonly options: { instances?: Array<{ instanceId: string; state: string }> } = {},
    ) {}

    async listRunnerInstances(): Promise<Array<{ instanceId: string; state: string }>> {
        return this.options.instances ?? [{ instanceId: "i-123", state: "running" }];
    }
}

class RecordingSsmClient implements SsmClientLike {
    readonly commands: string[] = [];

    constructor(private readonly options: { invocationStatus?: string } = {}) {}

    async sendCommand(input: { shellCommand: string }): Promise<{ commandId: string }> {
        this.commands.push(input.shellCommand);
        return { commandId: "cmd-123" };
    }

    async getCommandInvocation(): Promise<{ status: string }> {
        return { status: this.options.invocationStatus ?? "InProgress" };
    }
}

class RecordingS3Client implements S3ClientLike {
    constructor(private readonly options: { body?: string } = {}) {}

    async getObjectText(): Promise<string> {
        return (
            this.options.body ??
            JSON.stringify({
                status: "pending_source",
                error_code: "SHAKEMAP_PRODUCT_MISSING",
            })
        );
    }
}
