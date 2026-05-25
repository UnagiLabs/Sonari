import { describe, expect, it } from "vitest";
import { BCS_ENUMS, type TeeCoreResult } from "@sonari/oracle-shared";
import type { RelayerAdapter, RelayerSuccess } from "../src/relayer_preview.js";
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

    it("requires a running EC2 instance to be online in SSM before it is ready", async () => {
        const offlineHandler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client({
                instances: [{ instanceId: "i-offline", state: "running" }],
            }),
            ssm: new RecordingSsmClient({ onlineManagedInstanceIds: [] }),
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });
        const onlineHandler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client({
                instances: [
                    { instanceId: "i-stopped", state: "stopped" },
                    { instanceId: "i-online", state: "running" },
                ],
            }),
            ssm: new RecordingSsmClient({ onlineManagedInstanceIds: ["i-online"] }),
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        await expect(
            offlineHandler({ action: "find_ready_instance", source_event_id: "us7000sonari" }),
        ).rejects.toThrow(/No running SSM-managed runner instance/);
        await expect(
            onlineHandler({ action: "find_ready_instance", source_event_id: "us7000sonari" }),
        ).resolves.toMatchObject({ instance_id: "i-online" });
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
        expect(ssm.commands[0]).toContain(
            ': "${SONARI_TEE_SIGNING_KEY_SEED_FILE:?SONARI_TEE_SIGNING_KEY_SEED_FILE is required}"',
        );
        expect(ssm.commands[0]).toContain(
            ': "${SONARI_WALRUS_CONFIG:?SONARI_WALRUS_CONFIG is required}"',
        );
        expect(ssm.commands[0]).toContain(
            ': "${SONARI_WALRUS_AGGREGATOR_URL:?SONARI_WALRUS_AGGREGATOR_URL is required}"',
        );
        expect(ssm.commands[0]).toContain(
            "export SONARI_TEE_SIGNING_KEY_SEED_FILE SONARI_WALRUS_CONFIG SONARI_WALRUS_AGGREGATOR_URL",
        );
        expect(ssm.commands[0]).toContain("/tmp/sonari-tee-result-us7000sonari-1800000000123.json");
        expect(ssm.commands[0]).not.toContain("latest.json");
    });

    it("increments SSM command poll count while the command remains pending", async () => {
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient({ invocationStatus: "InProgress" }),
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        const polled = await handler({
            action: "poll_command",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
            command_id: "cmd-123",
            result_s3_key: "results/us7000sonari/1800000000123.json",
            command_poll_count: 59,
        });

        expect(polled).toMatchObject({
            command_status: "PENDING",
            command_poll_count: 60,
        });
    });

    it("records guarded workflow progress when dispatching and polling SSM commands", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "disaster-us7000sonari-1",
            1_800_000_000_001,
        );
        const ssm = new RecordingSsmClient({ invocationStatus: "InProgress" });
        let nowMs = 1_800_000_000_123;
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            repository,
            now: () => nowMs,
            config: baseConfig(),
        });

        await handler({
            action: "dispatch_tee_command",
            source_event_id: "us7000sonari",
            attempt: 1,
            instance_id: "i-123",
        });
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "processing",
            runner_attempt: 1,
            runner_phase: "dispatching_command",
            runner_instance_id: "i-123",
            runner_command_id: "cmd-123",
            runner_result_s3_key: "results/us7000sonari/1800000000123.json",
            updated_at_ms: 1_800_000_000_123,
        });

        nowMs += 30_000;
        const polled = await handler({
            action: "poll_command",
            source_event_id: "us7000sonari",
            attempt: 1,
            instance_id: "i-123",
            command_id: "cmd-123",
            result_s3_key: "results/us7000sonari/1800000000123.json",
        });

        expect(polled).toMatchObject({ command_status: "PENDING" });
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            runner_phase: "polling_command",
            runner_instance_id: "i-123",
            runner_command_id: "cmd-123",
            runner_result_s3_key: "results/us7000sonari/1800000000123.json",
            runner_last_poll_at_ms: 1_800_000_030_123,
            updated_at_ms: 1_800_000_030_123,
        });
    });

    it("requires attempt metadata for repository-guarded workflow actions", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "disaster-us7000sonari-1",
            1_800_000_000_001,
        );
        const autoscaling = new RecordingAutoScalingClient();
        const ssm = new RecordingSsmClient();
        const handler = createRunnerControlHandler({
            autoscaling,
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_030_123,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "dispatch_tee_command",
                source_event_id: "us7000sonari",
                instance_id: "i-123",
            }),
        ).rejects.toThrow(/runner workflow attempt is required/);
        await expect(
            handler({
                action: "mark_failed",
                source_event_id: "us7000sonari",
            }),
        ).rejects.toThrow(/runner workflow attempt is required/);
        await expect(
            handler({
                action: "stop_instance",
                source_event_id: "us7000sonari",
            }),
        ).rejects.toThrow(/runner workflow attempt is required/);

        expect(ssm.commands).toEqual([]);
        expect(autoscaling.capacities).toEqual([]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "processing",
            runner_phase: "starting_instance",
        });
    });

    it("treats missing SSM command invocations as pending while command registration propagates", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "disaster-us7000sonari-1",
            1_800_000_000_001,
        );
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient({ invocationErrorName: "InvocationDoesNotExist" }),
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_030_123,
            config: baseConfig(),
        });

        const polled = await handler({
            action: "poll_command",
            source_event_id: "us7000sonari",
            attempt: 1,
            instance_id: "i-123",
            command_id: "cmd-123",
            result_s3_key: "results/us7000sonari/1800000000123.json",
        });

        expect(polled).toMatchObject({ command_status: "PENDING" });
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            runner_phase: "polling_command",
            runner_last_poll_at_ms: 1_800_000_030_123,
        });
    });

    it("does not let a superseded workflow attempt dispatch, fail, apply, or stop newer work", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markFailed(
            "us7000sonari",
            "AWS_RUNNER_TIMEOUT",
            1_800_000_000_000,
            1_800_000_000_000,
        );
        await repository.markWorkflowStarted(
            "us7000sonari",
            "disaster-us7000sonari-2",
            1_800_000_000_001,
        );
        const autoscaling = new RecordingAutoScalingClient();
        const ssm = new RecordingSsmClient();
        const handler = createRunnerControlHandler({
            autoscaling,
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_030_123,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "dispatch_tee_command",
                source_event_id: "us7000sonari",
                attempt: 1,
                instance_id: "i-123",
            }),
        ).rejects.toThrow(/stale runner workflow attempt/);
        await expect(
            handler({
                action: "apply_result",
                source_event_id: "us7000sonari",
                attempt: 1,
                result: pendingSourceResult("us7000sonari"),
            }),
        ).rejects.toThrow(/stale runner workflow attempt/);
        await expect(
            handler({
                action: "mark_failed",
                source_event_id: "us7000sonari",
                attempt: 1,
            }),
        ).rejects.toThrow(/stale runner workflow attempt/);
        await expect(
            handler({
                action: "stop_instance",
                source_event_id: "us7000sonari",
                attempt: 1,
            }),
        ).rejects.toThrow(/stale runner workflow attempt/);

        expect(ssm.commands).toEqual([]);
        expect(autoscaling.capacities).toEqual([]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "processing",
            retry_count: 1,
            runner_attempt: 2,
            runner_phase: "starting_instance",
        });
    });

    it("does not let a superseded workflow attempt relay finalized results", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markFailed(
            "us7000sonari",
            "AWS_RUNNER_TIMEOUT",
            1_800_000_000_000,
            1_800_000_000_000,
        );
        await repository.markWorkflowStarted(
            "us7000sonari",
            "disaster-us7000sonari-2",
            1_800_000_000_001,
        );
        const relayer = new RecordingRelayerAdapter();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            relayer,
            now: () => 1_800_000_030_123,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "relayer_preview_or_dry_run",
                source_event_id: "us7000sonari",
                attempt: 1,
                result: finalizedResult(),
            }),
        ).rejects.toThrow(/stale runner workflow attempt/);

        expect(relayer.inputs).toEqual([]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "processing",
            runner_attempt: 2,
            relayer_status: null,
        });
    });

    it("allows the current workflow attempt to stop capacity after applying a terminal result", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "disaster-us7000sonari-1",
            1_800_000_000_001,
        );
        await repository.applyRunnerResult(
            "us7000sonari",
            pendingSourceResult("us7000sonari"),
            1_800_000_030_000,
            1_800_000_060_000,
            1,
        );
        const autoscaling = new RecordingAutoScalingClient();
        const handler = createRunnerControlHandler({
            autoscaling,
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_030_123,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "stop_instance",
                source_event_id: "us7000sonari",
                attempt: 1,
            }),
        ).resolves.toMatchObject({ capacity: 0 });

        expect(autoscaling.capacities).toEqual([0]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "pending_source",
            runner_attempt: 1,
            runner_phase: "complete",
            runner_stopped_at_ms: 1_800_000_030_123,
        });
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
        expect(ssm.commands[0]).toContain(
            "'s3://sonari-results-$(touch bad)/results/us7000sonari/1800000000123.json'",
        );
        expect(ssm.commands[0]).not.toContain("$RESULT_S3_KEY'");
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
        await repository.markWorkflowStarted(
            "us7000sonari",
            "disaster-us7000sonari-1",
            1_800_000_000_001,
        );
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

        await handler({
            action: "apply_result",
            source_event_id: "us7000sonari",
            attempt: 1,
            result,
        });
        const relayer = await handler({
            action: "relayer_preview_or_dry_run",
            source_event_id: "us7000sonari",
            attempt: 1,
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

function finalizedResult(): TeeCoreResult {
    return {
        status: "finalized",
        payload: {
            intent: BCS_ENUMS.intent.SONARI_EARTHQUAKE_ORACLE,
            oracle_version: 1,
            event_uid: "us7000sonari",
            hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
            status: BCS_ENUMS.onchainStatus.FINALIZED,
            event_revision: 1,
            occurred_at_ms: 1_800_000_000_000,
            observed_at_ms: 1_800_000_000_000,
            source_updated_at_ms: 1_800_000_000_000,
            primary_source: BCS_ENUMS.primarySource.USGS,
            severity_band: 2,
            source_set_hash: `0x${"11".repeat(32)}`,
            raw_data_hash: `0x${"22".repeat(32)}`,
            raw_data_uri: "walrus://raw",
            affected_cells_root: `0x${"33".repeat(32)}`,
            affected_cells_uri: "walrus://cells",
            affected_cells_data_hash: `0x${"44".repeat(32)}`,
            geo_resolution: 7,
            cells_generation_method:
                BCS_ENUMS.cellsGenerationMethod.SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
            cell_metric: BCS_ENUMS.cellMetric.USGS_MMI,
            cell_aggregation: BCS_ENUMS.cellAggregation.GRID_POINT_P90,
            intensity_scale: BCS_ENUMS.intensityScale.MMI_X100,
            max_cell_band: 2,
            affected_cell_count: 1,
            min_claim_band: 1,
            freshness_deadline_ms: 1_800_000_060_000,
        },
        payload_bcs_hex: "0x01",
        signature: "0xsig",
        public_key: "0xpub",
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

    constructor(
        private readonly options: {
            invocationStatus?: string;
            onlineManagedInstanceIds?: string[];
            invocationErrorName?: string;
        } = {},
    ) {}

    async listOnlineManagedInstanceIds(input: { instanceIds: string[] }): Promise<Set<string>> {
        const online = new Set(this.options.onlineManagedInstanceIds ?? input.instanceIds);
        return new Set(input.instanceIds.filter((instanceId) => online.has(instanceId)));
    }

    async sendCommand(input: { shellCommand: string }): Promise<{ commandId: string }> {
        this.commands.push(input.shellCommand);
        return { commandId: "cmd-123" };
    }

    async getCommandInvocation(): Promise<{ status: string }> {
        if (this.options.invocationErrorName !== undefined) {
            throw Object.assign(new Error(this.options.invocationErrorName), {
                name: this.options.invocationErrorName,
            });
        }
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

class RecordingRelayerAdapter implements RelayerAdapter {
    readonly mode = "preview" as const;
    readonly inputs: TeeCoreResult[] = [];

    async relay(input: TeeCoreResult): Promise<{ ok: true; value: RelayerSuccess }> {
        this.inputs.push(input);
        return {
            ok: true,
            value: {
                mode: this.mode,
                request: {
                    target: "0xtarget",
                    registry: "0xregistry",
                    verifierRegistry: "0xverifier",
                    clock: "0x6",
                    arguments: ["0xtarget", "0xregistry", "0xverifier", [], [], []],
                    submitRequest: {
                        target: "0xtarget",
                        registry: "0xregistry",
                        verifierRegistry: "0xverifier",
                        clock: "0x6",
                        arguments: ["0xtarget", "0xregistry", "0xverifier", [], [], []],
                    },
                },
            },
        };
    }
}
