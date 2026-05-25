import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
    SetDesiredCapacityCommand,
} from "@aws-sdk/client-auto-scaling";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
    DescribeInstanceInformationCommand,
    GetCommandInvocationCommand,
    SendCommandCommand,
    SSMClient,
} from "@aws-sdk/client-ssm";
import { type TeeCoreResult, validateRelayerSubmitInput } from "@sonari/oracle-shared";
import { FAILED_RETRY_BACKOFF_MS, HOUR_MS } from "./constants.js";
import { buildDisasterVerifierRequest } from "./index.js";
import { DirectRelayerAdapter, type RelayerAdapter, type RelayerMode } from "./relayer_preview.js";
import { assertValidUsgsSourceEventId } from "./source_event_id.js";
import { DynamoDbStateRepository, type StateRepository } from "./state.js";

export interface RunnerWorkflowConfig {
    autoScalingGroupName: string;
    resultBucket: string;
    nitroEnclaveProcessCommand: string;
    eventsTableName?: string;
    relayer?: {
        mode: RelayerMode;
        target: string;
        registry: string;
        verifierRegistry: string;
        grpcUrl?: string;
        senderAddress?: string;
    };
}

export interface AutoScalingClientLike {
    setDesiredCapacity(input: {
        autoScalingGroupName: string;
        desiredCapacity: number;
    }): Promise<void>;
}

export interface Ec2ClientLike {
    listRunnerInstances(input: {
        autoScalingGroupName: string;
    }): Promise<Array<{ instanceId: string; state: string }>>;
}

export interface SsmClientLike {
    listOnlineManagedInstanceIds(input: { instanceIds: string[] }): Promise<Set<string>>;
    checkRunnerBootstrapReady(instanceId: string): Promise<boolean>;
    sendCommand(input: {
        instanceId: string;
        shellCommand: string;
    }): Promise<{ commandId: string }>;
    getCommandInvocation(input: {
        instanceId: string;
        commandId: string;
    }): Promise<{ status: string }>;
}

export interface S3ClientLike {
    getObjectText(input: { bucket: string; key: string }): Promise<string>;
}

export type RunnerControlEvent =
    | { action: "start_instance"; source_event_id: string; attempt?: number | undefined }
    | { action: "find_ready_instance"; source_event_id: string; attempt?: number | undefined }
    | {
          action: "dispatch_tee_command";
          source_event_id: string;
          attempt?: number | undefined;
          instance_id: string;
      }
    | {
          action: "poll_command";
          source_event_id: string;
          attempt?: number | undefined;
          instance_id: string;
          command_id: string;
          result_s3_key?: string;
          command_poll_count?: number | undefined;
      }
    | {
          action: "read_result";
          source_event_id: string;
          attempt?: number | undefined;
          result_s3_key: string;
      }
    | {
          action: "apply_result";
          source_event_id: string;
          attempt?: number | undefined;
          result: TeeCoreResult;
      }
    | {
          action: "relayer_preview_or_dry_run";
          source_event_id: string;
          attempt?: number | undefined;
          result: TeeCoreResult;
      }
    | {
          action: "mark_failed";
          source_event_id: string;
          attempt?: number | undefined;
          error_code?: string;
          message?: string;
      }
    | { action: "stop_instance"; source_event_id: string; attempt?: number | undefined };

export type RunnerControlResult =
    | { source_event_id: string; attempt?: number | undefined; capacity: number }
    | { source_event_id: string; attempt?: number | undefined; instance_id: string }
    | {
          source_event_id: string;
          attempt?: number | undefined;
          instance_id: string;
          command_id: string;
          result_s3_key: string;
          command_poll_count: number;
      }
    | {
          source_event_id: string;
          attempt?: number | undefined;
          instance_id?: string;
          command_id?: string;
          result_s3_key?: string;
          command_poll_count?: number;
          command_status: "PENDING" | "SUCCEEDED" | "FAILED";
      }
    | { source_event_id: string; attempt?: number | undefined; result: TeeCoreResult }
    | {
          source_event_id: string;
          attempt?: number | undefined;
          applied: true;
          result: TeeCoreResult;
      }
    | {
          source_event_id: string;
          attempt?: number | undefined;
          relayer: "skipped" | "succeeded" | "failed";
          result: TeeCoreResult;
      }
    | { source_event_id: string; attempt?: number | undefined; failed: true };

export interface RunnerControlHandlerOptions {
    autoscaling: AutoScalingClientLike;
    ec2: Ec2ClientLike;
    ssm: SsmClientLike;
    s3: S3ClientLike;
    repository?: StateRepository;
    relayer?: RelayerAdapter;
    now?: () => number;
    config: RunnerWorkflowConfig;
}

export function createRunnerControlHandler(options: RunnerControlHandlerOptions) {
    return async function runnerControlHandler(
        event: RunnerControlEvent,
    ): Promise<RunnerControlResult> {
        switch (event.action) {
            case "start_instance":
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "starting_instance",
                });
                await options.autoscaling.setDesiredCapacity({
                    autoScalingGroupName: options.config.autoScalingGroupName,
                    desiredCapacity: 1,
                });
                return {
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    capacity: 1,
                };
            case "stop_instance":
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "stopping_instance",
                    allowNonProcessing: true,
                });
                await options.autoscaling.setDesiredCapacity({
                    autoScalingGroupName: options.config.autoScalingGroupName,
                    desiredCapacity: 0,
                });
                if (options.repository !== undefined && event.attempt !== undefined) {
                    const stopped = await options.repository.markWorkflowStopped(
                        event.source_event_id,
                        event.attempt,
                        options.now?.() ?? Date.now(),
                    );
                    if (!stopped) {
                        throw new Error("stale runner workflow attempt");
                    }
                }
                return {
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    capacity: 0,
                };
            case "find_ready_instance": {
                const instanceId = await findReadyInstance(
                    options.ec2,
                    options.ssm,
                    options.config.autoScalingGroupName,
                );
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "waiting_for_instance",
                    instanceId,
                });
                return {
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    instance_id: instanceId,
                };
            }
            case "dispatch_tee_command": {
                assertValidUsgsSourceEventId(event.source_event_id);
                const dispatchTimestampMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "dispatching_command",
                    instanceId: event.instance_id,
                    nowMs: dispatchTimestampMs,
                });
                const resultS3Key = `results/${event.source_event_id}/${dispatchTimestampMs}.json`;
                const command = buildSsmShellCommand({
                    sourceEventId: event.source_event_id,
                    dispatchTimestampMs,
                    resultBucket: options.config.resultBucket,
                    resultS3Key,
                    nitroEnclaveProcessCommand: options.config.nitroEnclaveProcessCommand,
                });
                const sent = await options.ssm.sendCommand({
                    instanceId: event.instance_id,
                    shellCommand: command,
                });
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "dispatching_command",
                    instanceId: event.instance_id,
                    commandId: sent.commandId,
                    resultS3Key,
                    nowMs: dispatchTimestampMs,
                });
                return {
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: sent.commandId,
                    result_s3_key: resultS3Key,
                    command_poll_count: 0,
                };
            }
            case "poll_command": {
                const pollTimestampMs = options.now?.() ?? Date.now();
                const commandStatus = await pollCommandStatus(options.ssm, {
                    instanceId: event.instance_id,
                    commandId: event.command_id,
                });
                const commandPollCount =
                    commandStatus === "PENDING"
                        ? (event.command_poll_count ?? 0) + 1
                        : (event.command_poll_count ?? 0);
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "polling_command",
                    instanceId: event.instance_id,
                    commandId: event.command_id,
                    resultS3Key: event.result_s3_key,
                    lastPollAtMs: pollTimestampMs,
                    nowMs: pollTimestampMs,
                });
                return {
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: event.command_id,
                    result_s3_key: event.result_s3_key,
                    command_poll_count: commandPollCount,
                    command_status: commandStatus,
                };
            }
            case "read_result": {
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "reading_result",
                    resultS3Key: event.result_s3_key,
                });
                const text = await options.s3.getObjectText({
                    bucket: options.config.resultBucket,
                    key: event.result_s3_key,
                });
                return {
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    result: parseTeeResult(text),
                };
            }
            case "apply_result": {
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "applying_result",
                    nowMs,
                });
                const applied = await repository.applyRunnerResult(
                    event.source_event_id,
                    event.result,
                    nowMs,
                    isPendingTeeResult(event.result) ? nowMs + HOUR_MS : undefined,
                    event.attempt,
                );
                if (!applied) {
                    throw new Error("stale runner workflow attempt");
                }
                return {
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    applied: true,
                    result: event.result,
                };
            }
            case "relayer_preview_or_dry_run": {
                const repository = requireRepository(options);
                const relayer = options.relayer ?? buildRelayerFromConfig(options.config);
                if (relayer === undefined || event.result.status !== "finalized") {
                    return {
                        source_event_id: event.source_event_id,
                        attempt: event.attempt,
                        relayer: "skipped",
                        result: event.result,
                    };
                }
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "complete",
                    allowNonProcessing: true,
                });
                const nowMs = options.now?.() ?? Date.now();
                const result = await relayer.relay(event.result);
                if (result.ok) {
                    await requireCurrentWorkflowAttempt(options, event, {
                        phase: "complete",
                        nowMs,
                        allowNonProcessing: true,
                    });
                    const marked = await repository.markRelayerSucceeded(
                        event.source_event_id,
                        result.value,
                        nowMs,
                        event.attempt,
                    );
                    if (!marked) {
                        throw new Error("stale runner workflow attempt");
                    }
                    return {
                        source_event_id: event.source_event_id,
                        attempt: event.attempt,
                        relayer: "succeeded",
                        result: event.result,
                    };
                }
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "complete",
                    nowMs,
                    allowNonProcessing: true,
                });
                const marked = await repository.markRelayerFailed(
                    event.source_event_id,
                    relayer.mode,
                    result.error_code,
                    result.message,
                    nowMs,
                    event.attempt,
                );
                if (!marked) {
                    throw new Error("stale runner workflow attempt");
                }
                return {
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    relayer: "failed",
                    result: event.result,
                };
            }
            case "mark_failed": {
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "complete",
                    nowMs,
                    allowNonProcessing: true,
                });
                const marked = await repository.markFailed(
                    event.source_event_id,
                    "AWS_RUNNER_PROCESS_FAILED",
                    nowMs,
                    nowMs + FAILED_RETRY_BACKOFF_MS,
                    event.message ?? event.error_code ?? "runner workflow failed",
                    event.attempt,
                );
                if (!marked) {
                    throw new Error("stale runner workflow attempt");
                }
                return {
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    failed: true,
                };
            }
        }
    };
}

class AwsAutoScalingClient implements AutoScalingClientLike {
    private readonly client = new AutoScalingClient({});

    async setDesiredCapacity(input: {
        autoScalingGroupName: string;
        desiredCapacity: number;
    }): Promise<void> {
        await this.client.send(
            new SetDesiredCapacityCommand({
                AutoScalingGroupName: input.autoScalingGroupName,
                DesiredCapacity: input.desiredCapacity,
                HonorCooldown: false,
            }),
        );
    }
}

class AwsEc2Client implements Ec2ClientLike {
    private readonly autoscaling = new AutoScalingClient({});
    private readonly ec2 = new EC2Client({});

    async listRunnerInstances(input: {
        autoScalingGroupName: string;
    }): Promise<Array<{ instanceId: string; state: string }>> {
        const group = await this.autoscaling.send(
            new DescribeAutoScalingGroupsCommand({
                AutoScalingGroupNames: [input.autoScalingGroupName],
            }),
        );
        const instanceIds =
            group.AutoScalingGroups?.[0]?.Instances?.map((instance) => instance.InstanceId).filter(
                isNonEmptyString,
            ) ?? [];
        if (instanceIds.length === 0) {
            return [];
        }
        const reservations = await this.ec2.send(
            new DescribeInstancesCommand({ InstanceIds: instanceIds }),
        );
        return (reservations.Reservations ?? []).flatMap((reservation) =>
            (reservation.Instances ?? []).flatMap((instance) =>
                instance.InstanceId === undefined
                    ? []
                    : [
                          {
                              instanceId: instance.InstanceId,
                              state: instance.State?.Name ?? "unknown",
                          },
                      ],
            ),
        );
    }
}

class AwsSsmClient implements SsmClientLike {
    private readonly client = new SSMClient({});

    async listOnlineManagedInstanceIds(input: { instanceIds: string[] }): Promise<Set<string>> {
        if (input.instanceIds.length === 0) {
            return new Set();
        }
        const result = await this.client.send(
            new DescribeInstanceInformationCommand({
                Filters: [
                    {
                        Key: "InstanceIds",
                        Values: input.instanceIds,
                    },
                ],
            }),
        );
        return new Set(
            (result.InstanceInformationList ?? [])
                .filter((instance) => instance.PingStatus === "Online")
                .map((instance) => instance.InstanceId)
                .filter(isNonEmptyString),
        );
    }

    async checkRunnerBootstrapReady(instanceId: string): Promise<boolean> {
        const sent = await this.sendCommand({
            instanceId,
            shellCommand: buildRunnerBootstrapReadinessShellCommand(),
        });
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const status = await pollCommandStatus(this, {
                instanceId,
                commandId: sent.commandId,
            });
            if (status === "SUCCEEDED") {
                return true;
            }
            if (status === "FAILED") {
                return false;
            }
            if (attempt < 4) {
                await sleep(1_000);
            }
        }
        return false;
    }

    async sendCommand(input: {
        instanceId: string;
        shellCommand: string;
    }): Promise<{ commandId: string }> {
        const result = await this.client.send(
            new SendCommandCommand({
                DocumentName: "AWS-RunShellScript",
                InstanceIds: [input.instanceId],
                Parameters: { commands: [input.shellCommand] },
            }),
        );
        if (result.Command?.CommandId === undefined) {
            throw new Error("SSM sendCommand did not return CommandId");
        }
        return { commandId: result.Command.CommandId };
    }

    async getCommandInvocation(input: {
        instanceId: string;
        commandId: string;
    }): Promise<{ status: string }> {
        const result = await this.client.send(
            new GetCommandInvocationCommand({
                InstanceId: input.instanceId,
                CommandId: input.commandId,
            }),
        );
        return { status: result.Status ?? "Unknown" };
    }
}

class AwsS3Client implements S3ClientLike {
    private readonly client = new S3Client({});

    async getObjectText(input: { bucket: string; key: string }): Promise<string> {
        const result = await this.client.send(
            new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
        );
        if (result.Body === undefined) {
            throw new Error(`S3 object was empty: ${input.key}`);
        }
        return result.Body.transformToString();
    }
}

export async function handler(event: RunnerControlEvent): Promise<RunnerControlResult> {
    const relayer = readRelayerConfigFromEnv();
    const config: RunnerWorkflowConfig = {
        autoScalingGroupName: requiredEnv("RUNNER_ASG_NAME"),
        resultBucket: requiredEnv("RESULT_BUCKET"),
        nitroEnclaveProcessCommand: requiredEnv("NITRO_ENCLAVE_PROCESS_COMMAND"),
        ...(relayer === undefined ? {} : { relayer }),
    };
    return createRunnerControlHandler({
        autoscaling: new AwsAutoScalingClient(),
        ec2: new AwsEc2Client(),
        ssm: new AwsSsmClient(),
        s3: new AwsS3Client(),
        repository: new DynamoDbStateRepository(requiredEnv("EVENTS_TABLE_NAME")),
        config,
    })(event);
}

function buildSsmShellCommand(input: {
    sourceEventId: string;
    dispatchTimestampMs: number;
    resultBucket: string;
    resultS3Key: string;
    nitroEnclaveProcessCommand: string;
}): string {
    const tempResultPath = `/tmp/sonari-tee-result-${input.sourceEventId}-${input.dispatchTimestampMs}.json`;
    return [
        "set -euo pipefail",
        "source /opt/sonari/runner.env",
        buildRequiredShellEnvCheck("SONARI_TEE_SIGNING_KEY_SEED_FILE"),
        buildRequiredShellEnvCheck("SONARI_WALRUS_CONFIG"),
        buildRequiredShellEnvCheck("SONARI_WALRUS_AGGREGATOR_URL"),
        "export SONARI_TEE_SIGNING_KEY_SEED_FILE SONARI_WALRUS_CONFIG SONARI_WALRUS_AGGREGATOR_URL",
        `RESULT_S3_KEY=${shellSingleQuote(input.resultS3Key)}`,
        `NITRO_ENCLAVE_PROCESS_COMMAND=${shellSingleQuote(input.nitroEnclaveProcessCommand)}`,
        "export NITRO_ENCLAVE_PROCESS_COMMAND",
        `printf '%s' ${shellSingleQuote(JSON.stringify(buildDisasterVerifierRequest(input.sourceEventId)))} | "$NITRO_ENCLAVE_PROCESS_COMMAND" > ${shellSingleQuote(tempResultPath)}`,
        `aws s3 cp ${shellSingleQuote(tempResultPath)} ${shellSingleQuote(`s3://${input.resultBucket}/${input.resultS3Key}`)}`,
    ].join("\n");
}

export function buildRunnerBootstrapReadinessShellCommand(): string {
    return [
        "set -euo pipefail",
        "test -f /opt/sonari/bootstrap-complete",
        "test -s /opt/sonari/runner.env",
        "source /opt/sonari/runner.env",
        buildRequiredShellEnvCheck("RUNNER_TOKEN_FILE"),
        buildRequiredShellEnvCheck("SONARI_TEE_SIGNING_KEY_SEED_FILE"),
        buildRequiredShellEnvCheck("SONARI_WALRUS_CONFIG"),
        buildRequiredShellEnvCheck("SONARI_WALRUS_AGGREGATOR_URL"),
        'test -s "$RUNNER_TOKEN_FILE"',
        'test -s "$SONARI_TEE_SIGNING_KEY_SEED_FILE"',
        'test -s "$SONARI_WALRUS_CONFIG"',
        "systemctl is-active --quiet nitro-enclaves-allocator.service",
    ].join("\n");
}

function buildRequiredShellEnvCheck(name: string): string {
    return `: "\${${name}:?${name} is required}"`;
}

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

async function findReadyInstance(
    ec2: Ec2ClientLike,
    ssm: SsmClientLike,
    autoScalingGroupName: string,
): Promise<string> {
    const instances = await ec2.listRunnerInstances({ autoScalingGroupName });
    const runningIds = instances
        .filter((instance) => instance.state === "running")
        .map((instance) => instance.instanceId);
    const onlineManagedInstanceIds = await ssm.listOnlineManagedInstanceIds({
        instanceIds: runningIds,
    });
    for (const instanceId of runningIds) {
        if (!onlineManagedInstanceIds.has(instanceId)) {
            continue;
        }
        if (await ssm.checkRunnerBootstrapReady(instanceId)) {
            return instanceId;
        }
    }
    const ready = undefined;
    if (ready === undefined) {
        throw new Error("No running SSM-managed runner instance is bootstrap-ready");
    }
    return ready;
}

function normalizeCommandStatus(status: string): "PENDING" | "SUCCEEDED" | "FAILED" {
    if (status === "Success") {
        return "SUCCEEDED";
    }
    if (status === "Pending" || status === "InProgress" || status === "Delayed") {
        return "PENDING";
    }
    return "FAILED";
}

async function pollCommandStatus(
    ssm: SsmClientLike,
    input: { instanceId: string; commandId: string },
): Promise<"PENDING" | "SUCCEEDED" | "FAILED"> {
    try {
        const invocation = await ssm.getCommandInvocation(input);
        return normalizeCommandStatus(invocation.status);
    } catch (error) {
        if (isTransientCommandInvocationLookupError(error)) {
            return "PENDING";
        }
        throw error;
    }
}

function isTransientCommandInvocationLookupError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "InvocationDoesNotExist"
    );
}

function parseTeeResult(text: string): TeeCoreResult {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && parsed.status === "finalized") {
        const validation = validateRelayerSubmitInput(parsed);
        if (!validation.ok) {
            throw new Error(`invalid finalized TEE result: ${validation.message}`);
        }
        return validation.value;
    }
    if (
        isRecord(parsed) &&
        (parsed.status === "pending_source" ||
            parsed.status === "pending_mmi" ||
            parsed.status === "rejected") &&
        typeof parsed.source_event_id === "string" &&
        typeof parsed.error_code === "string"
    ) {
        return parsed as TeeCoreResult;
    }
    throw new Error("invalid TEE result");
}

function isPendingTeeResult(result: TeeCoreResult): boolean {
    return result.status === "pending_source" || result.status === "pending_mmi";
}

function requireRepository(options: RunnerControlHandlerOptions): StateRepository {
    if (options.repository === undefined) {
        throw new Error("state repository is required for this runner workflow action");
    }
    return options.repository;
}

async function requireCurrentWorkflowAttempt(
    options: RunnerControlHandlerOptions,
    event: { source_event_id: string; attempt?: number | undefined },
    input: {
        phase: Parameters<StateRepository["updateRunnerWorkflowProgress"]>[0]["phase"];
        nowMs?: number;
        instanceId?: string | undefined;
        commandId?: string | undefined;
        resultS3Key?: string | undefined;
        lastPollAtMs?: number | undefined;
        allowNonProcessing?: boolean | undefined;
    },
): Promise<void> {
    if (options.repository === undefined) {
        return;
    }
    if (event.attempt === undefined) {
        throw new Error("runner workflow attempt is required");
    }
    const updated = await options.repository.updateRunnerWorkflowProgress({
        sourceEventId: event.source_event_id,
        attempt: event.attempt,
        phase: input.phase,
        nowMs: input.nowMs ?? options.now?.() ?? Date.now(),
        instanceId: input.instanceId,
        commandId: input.commandId,
        resultS3Key: input.resultS3Key,
        lastPollAtMs: input.lastPollAtMs,
        allowNonProcessing: input.allowNonProcessing,
    });
    if (!updated) {
        throw new Error("stale runner workflow attempt");
    }
}

function buildRelayerFromConfig(config: RunnerWorkflowConfig): RelayerAdapter | undefined {
    if (config.relayer === undefined) {
        return undefined;
    }
    return new DirectRelayerAdapter(config.relayer);
}

function readRelayerConfigFromEnv(): RunnerWorkflowConfig["relayer"] {
    const mode = process.env.RELAYER_MODE;
    if (mode === undefined || mode.length === 0) {
        return undefined;
    }
    if (mode !== "preview" && mode !== "dry_run" && mode !== "submit") {
        throw new Error(`Unsupported RELAYER_MODE: ${mode}`);
    }
    const config: NonNullable<RunnerWorkflowConfig["relayer"]> = {
        mode,
        target: requiredEnv("RELAYER_TARGET"),
        registry: requiredEnv("RELAYER_REGISTRY"),
        verifierRegistry: requiredEnv("RELAYER_VERIFIER_REGISTRY"),
    };
    if (process.env.RELAYER_GRPC_URL !== undefined) {
        config.grpcUrl = process.env.RELAYER_GRPC_URL;
    }
    if (process.env.RELAYER_SENDER_ADDRESS !== undefined) {
        config.senderAddress = process.env.RELAYER_SENDER_ADDRESS;
    }
    return config;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isNonEmptyString(input: string | undefined): input is string {
    return input !== undefined && input.length > 0;
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
