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
import { encodeIdentityVerificationResultBcsHex } from "@sonari/membership-verifier-shared";
import {
    DEFAULT_RETRY_BACKOFF_MS,
    DynamoDbVerificationJobRepository,
    type IdentityVerifyRequest,
    parseIdentityVerifyRequest,
    type VerificationJobRepository,
    type VerificationJobRow,
} from "./index.js";

export interface RunnerWorkflowConfig {
    readonly autoScalingGroupName: string;
    readonly resultBucket: string;
    readonly nitroEnclaveProcessCommand: string;
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

export type MembershipTeeResult = VerifiedMembershipTeeResult | StatusOnlyMembershipTeeResult;

export interface VerifiedMembershipTeeResult extends IdentityVerificationResultFields {
    readonly status: "verified";
    readonly payload_bcs_hex: string;
    readonly signature: string;
    readonly public_key: string;
}

export interface StatusOnlyMembershipTeeResult {
    readonly status: "pending_source" | "rejected" | "unsupported";
    readonly error_code: string;
}

interface IdentityVerificationResultFields {
    readonly intent: string;
    readonly verifier_family: "identity";
    readonly verifier_version: number;
    readonly registry_id: string;
    readonly membership_id: string;
    readonly owner: string;
    readonly provider: "kyc" | "world_id";
    readonly verified: boolean;
    readonly duplicate_key_hash: string;
    readonly evidence_hash: string;
    readonly issued_at_ms: number;
    readonly expires_at_ms: number;
    readonly terms_version: number;
    readonly signed_statement_hash: string;
}

export type RunnerControlEvent =
    | { action: "start_instance"; job_id: string; attempt?: number | undefined }
    | { action: "find_ready_instance"; job_id: string; attempt?: number | undefined }
    | {
          action: "dispatch_tee_command";
          job_id: string;
          attempt?: number | undefined;
          instance_id: string;
      }
    | {
          action: "poll_command";
          job_id: string;
          attempt?: number | undefined;
          instance_id: string;
          command_id: string;
          result_s3_key?: string | undefined;
          command_poll_count?: number | undefined;
      }
    | {
          action: "read_result";
          job_id: string;
          attempt?: number | undefined;
          result_s3_key: string;
      }
    | {
          action: "apply_result";
          job_id: string;
          attempt?: number | undefined;
          result: MembershipTeeResult;
      }
    | {
          action: "mark_failed";
          job_id: string;
          attempt?: number | undefined;
          error_code?: string | undefined;
          message?: string | undefined;
      }
    | { action: "stop_instance"; job_id: string; attempt?: number | undefined };

export type RunnerControlResult =
    | { job_id: string; attempt?: number | undefined; capacity: number }
    | { job_id: string; attempt?: number | undefined; instance_id: string }
    | {
          job_id: string;
          attempt?: number | undefined;
          instance_id: string;
          command_id: string;
          result_s3_key: string;
          command_poll_count: number;
      }
    | {
          job_id: string;
          attempt?: number | undefined;
          instance_id?: string | undefined;
          command_id?: string | undefined;
          result_s3_key?: string | undefined;
          command_poll_count?: number | undefined;
          command_status: "PENDING" | "SUCCEEDED" | "FAILED";
      }
    | { job_id: string; attempt?: number | undefined; result: MembershipTeeResult }
    | {
          job_id: string;
          attempt?: number | undefined;
          applied: true;
          result: MembershipTeeResult;
      }
    | { job_id: string; attempt?: number | undefined; failed: true };

export interface RunnerControlHandlerOptions {
    readonly autoscaling: AutoScalingClientLike;
    readonly ec2: Ec2ClientLike;
    readonly ssm: SsmClientLike;
    readonly s3: S3ClientLike;
    readonly repository?: VerificationJobRepository | undefined;
    readonly now?: (() => number) | undefined;
    readonly config: RunnerWorkflowConfig;
}

export function createRunnerControlHandler(options: RunnerControlHandlerOptions) {
    return async function runnerControlHandler(
        event: RunnerControlEvent,
    ): Promise<RunnerControlResult> {
        switch (event.action) {
            case "start_instance":
                await requireCurrentWorkflowAttempt(options, event, true);
                await options.autoscaling.setDesiredCapacity({
                    autoScalingGroupName: options.config.autoScalingGroupName,
                    desiredCapacity: 1,
                });
                return {
                    job_id: event.job_id,
                    attempt: event.attempt,
                    capacity: 1,
                };
            case "stop_instance":
                await options.autoscaling.setDesiredCapacity({
                    autoScalingGroupName: options.config.autoScalingGroupName,
                    desiredCapacity: 0,
                });
                return {
                    job_id: event.job_id,
                    attempt: event.attempt,
                    capacity: 0,
                };
            case "find_ready_instance": {
                const instanceId = await findReadyInstance(
                    options.ec2,
                    options.ssm,
                    options.config.autoScalingGroupName,
                );
                await requireCurrentWorkflowAttempt(options, event, true);
                return {
                    job_id: event.job_id,
                    attempt: event.attempt,
                    instance_id: instanceId,
                };
            }
            case "dispatch_tee_command": {
                const nowMs = options.now?.() ?? Date.now();
                const row = await requireCurrentWorkflowAttempt(options, event, true);
                const requestJson = readValidatedRequestJson(row);
                const resultS3Key = `results/${event.job_id}/${nowMs}.json`;
                const shellCommand = buildSsmShellCommand({
                    jobId: event.job_id,
                    requestJson,
                    dispatchTimestampMs: nowMs,
                    resultBucket: options.config.resultBucket,
                    resultS3Key,
                    nitroEnclaveProcessCommand: options.config.nitroEnclaveProcessCommand,
                });
                const sent = await options.ssm.sendCommand({
                    instanceId: event.instance_id,
                    shellCommand,
                });
                await requireCurrentWorkflowAttempt(options, event, true);
                return {
                    job_id: event.job_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: sent.commandId,
                    result_s3_key: resultS3Key,
                    command_poll_count: 0,
                };
            }
            case "poll_command": {
                await requireCurrentWorkflowAttempt(options, event, true);
                const commandStatus = await pollCommandStatus(options.ssm, {
                    instanceId: event.instance_id,
                    commandId: event.command_id,
                });
                const commandPollCount =
                    commandStatus === "PENDING"
                        ? (event.command_poll_count ?? 0) + 1
                        : (event.command_poll_count ?? 0);
                return {
                    job_id: event.job_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: event.command_id,
                    result_s3_key: event.result_s3_key,
                    command_poll_count: commandPollCount,
                    command_status: commandStatus,
                };
            }
            case "read_result": {
                const row = await requireCurrentWorkflowAttempt(options, event, true);
                const text = await options.s3.getObjectText({
                    bucket: options.config.resultBucket,
                    key: event.result_s3_key,
                });
                return {
                    job_id: event.job_id,
                    attempt: event.attempt,
                    result: parseTeeResult(text, readValidatedRequest(row)),
                };
            }
            case "apply_result": {
                const repository = requireRepository(options);
                await requireCurrentWorkflowAttempt(options, event, true);
                const nowMs = options.now?.() ?? Date.now();
                if (event.result.status === "pending_source") {
                    const updated = await repository.markRetry(
                        event.job_id,
                        nowMs,
                        nowMs + DEFAULT_RETRY_BACKOFF_MS,
                        event.result.error_code,
                    );
                    if (!updated) {
                        throw new Error("stale runner workflow attempt");
                    }
                    return {
                        job_id: event.job_id,
                        attempt: event.attempt,
                        applied: true,
                        result: event.result,
                    };
                }
                if (event.result.status === "rejected" || event.result.status === "unsupported") {
                    const updated = await repository.markFailed(
                        event.job_id,
                        nowMs,
                        event.result.error_code,
                        event.result.error_code,
                    );
                    if (!updated) {
                        throw new Error("stale runner workflow attempt");
                    }
                    return {
                        job_id: event.job_id,
                        attempt: event.attempt,
                        applied: true,
                        result: event.result,
                    };
                }
                return {
                    job_id: event.job_id,
                    attempt: event.attempt,
                    applied: true,
                    result: event.result,
                };
            }
            case "mark_failed": {
                const repository = requireRepository(options);
                await requireCurrentWorkflowAttempt(options, event, true);
                const nowMs = options.now?.() ?? Date.now();
                const errorCode = readRunnerFailureErrorCode(event.error_code);
                const updated = await repository.markFailed(
                    event.job_id,
                    nowMs,
                    errorCode,
                    event.message ?? errorCode,
                );
                if (!updated) {
                    throw new Error("stale runner workflow attempt");
                }
                return {
                    job_id: event.job_id,
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
    return createRunnerControlHandler({
        autoscaling: new AwsAutoScalingClient(),
        ec2: new AwsEc2Client(),
        ssm: new AwsSsmClient(),
        s3: new AwsS3Client(),
        repository: new DynamoDbVerificationJobRepository(
            requiredEnv("VERIFICATION_JOBS_TABLE_NAME"),
        ),
        config: {
            autoScalingGroupName: requiredEnv("RUNNER_ASG_NAME"),
            resultBucket: requiredEnv("RESULT_BUCKET"),
            nitroEnclaveProcessCommand: requiredEnv("NITRO_ENCLAVE_PROCESS_COMMAND"),
        },
    })(event);
}

function buildSsmShellCommand(input: {
    jobId: string;
    requestJson: string;
    dispatchTimestampMs: number;
    resultBucket: string;
    resultS3Key: string;
    nitroEnclaveProcessCommand: string;
}): string {
    const tempResultPath = `/tmp/sonari-membership-tee-result-${input.jobId}-${input.dispatchTimestampMs}.json`;
    const commandInvocation = parseNitroEnclaveProcessCommand(input.nitroEnclaveProcessCommand)
        .map(shellSingleQuote)
        .join(" ");
    return [
        "set -euo pipefail",
        "source /opt/sonari/runner.env",
        "systemctl is-active --quiet nitro-enclaves-allocator.service",
        "systemctl is-active --quiet sonari-world-id-vsock-proxy.service",
        buildRequiredShellEnvCheck("SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE"),
        buildRequiredShellEnvCheck("SONARI_SIGNING_MATERIAL_KMS_KEY_ID"),
        buildRequiredShellEnvCheck("SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"),
        buildRequiredShellEnvCheck("SONARI_NITRO_RUN_ENCLAVE_ARGS"),
        buildRequiredShellEnvCheck("SONARI_ENCLAVE_STDIO_BRIDGE"),
        buildRequiredShellEnvCheck("SONARI_WORLD_ID_API_BASE"),
        buildRequiredShellEnvCheck("SONARI_WORLD_ID_APP_ID"),
        buildRequiredShellEnvCheck("NITRO_ENCLAVE_PROCESS_COMMAND"),
        'test -s "$SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE"',
        'test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"',
        'test -x "$SONARI_ENCLAVE_STDIO_BRIDGE"',
        "export SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE SONARI_SIGNING_MATERIAL_KMS_KEY_ID SONARI_MEMBERSHIP_IDENTITY_EIF_PATH SONARI_NITRO_RUN_ENCLAVE_ARGS SONARI_ENCLAVE_STDIO_BRIDGE SONARI_WORLD_ID_API_BASE SONARI_WORLD_ID_APP_ID NITRO_ENCLAVE_PROCESS_COMMAND",
        `RESULT_S3_KEY=${shellSingleQuote(input.resultS3Key)}`,
        `printf '%s' ${shellSingleQuote(input.requestJson)} | ${commandInvocation} > ${shellSingleQuote(tempResultPath)}`,
        `aws s3 cp ${shellSingleQuote(tempResultPath)} ${shellSingleQuote(`s3://${input.resultBucket}/${input.resultS3Key}`)}`,
    ].join("\n");
}

export function buildRunnerBootstrapReadinessShellCommand(): string {
    return [
        "set -euo pipefail",
        "test -f /opt/sonari/bootstrap-complete",
        "test -s /opt/sonari/runner.env",
        "source /opt/sonari/runner.env",
        buildRequiredShellEnvCheck("SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE"),
        buildRequiredShellEnvCheck("SONARI_SIGNING_MATERIAL_KMS_KEY_ID"),
        buildRequiredShellEnvCheck("SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"),
        buildRequiredShellEnvCheck("SONARI_NITRO_RUN_ENCLAVE_ARGS"),
        buildRequiredShellEnvCheck("SONARI_ENCLAVE_STDIO_BRIDGE"),
        buildRequiredShellEnvCheck("SONARI_WORLD_ID_API_BASE"),
        buildRequiredShellEnvCheck("SONARI_WORLD_ID_APP_ID"),
        buildRequiredShellEnvCheck("NITRO_ENCLAVE_PROCESS_COMMAND"),
        'test -s "$SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE"',
        'test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"',
        'test -x "$SONARI_ENCLAVE_STDIO_BRIDGE"',
        "systemctl is-active --quiet nitro-enclaves-allocator.service",
        "systemctl is-active --quiet sonari-world-id-vsock-proxy.service",
    ].join("\n");
}

function buildRequiredShellEnvCheck(name: string, message = `${name} is required`): string {
    return `: "\${${name}:?${message}}"`;
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
    throw new Error("No running SSM-managed membership runner instance is bootstrap-ready");
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

function normalizeCommandStatus(status: string): "PENDING" | "SUCCEEDED" | "FAILED" {
    if (status === "Success") {
        return "SUCCEEDED";
    }
    if (status === "Pending" || status === "InProgress" || status === "Delayed") {
        return "PENDING";
    }
    return "FAILED";
}

function isTransientCommandInvocationLookupError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "InvocationDoesNotExist"
    );
}

function parseTeeResult(text: string, request: IdentityVerifyRequest): MembershipTeeResult {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || typeof parsed.status !== "string") {
        throw new Error("invalid membership TEE result");
    }
    if (
        parsed.status === "pending_source" ||
        parsed.status === "rejected" ||
        parsed.status === "unsupported"
    ) {
        const keys = Object.keys(parsed);
        if (
            keys.length !== 2 ||
            !keys.includes("status") ||
            !keys.includes("error_code") ||
            typeof parsed.error_code !== "string" ||
            parsed.error_code.length === 0
        ) {
            throw new Error("invalid status-only membership TEE result");
        }
        return {
            status: parsed.status,
            error_code: parsed.error_code,
        };
    }
    if (parsed.status !== "verified") {
        throw new Error("invalid membership TEE result status");
    }
    const result = parseVerifiedTeeResult(parsed);
    assertVerifiedResultMatchesRequest(result, request);
    return result;
}

function parseVerifiedTeeResult(input: Record<string, unknown>): VerifiedMembershipTeeResult {
    const payload = pickIdentityPayloadFields(input);
    if (payload.verified !== true) {
        throw new Error("verified membership TEE result must have verified=true");
    }
    const expectedPayloadBcsHex = encodeIdentityVerificationResultBcsHex(payload);
    const payloadBcsHex = parseHex(input.payload_bcs_hex, "payload_bcs_hex");
    if (payloadBcsHex !== expectedPayloadBcsHex) {
        throw new Error("verified membership TEE result payload_bcs_hex mismatch");
    }
    return {
        status: "verified",
        ...payload,
        payload_bcs_hex: payloadBcsHex,
        signature: parseFixedHex(input.signature, "signature", 64),
        public_key: parseFixedHex(input.public_key, "public_key", 32),
    };
}

function pickIdentityPayloadFields(
    input: Record<string, unknown>,
): IdentityVerificationResultFields {
    return {
        intent: parseString(input.intent, "intent"),
        verifier_family: parseVerifierFamily(input.verifier_family),
        verifier_version: parseSafeU64(input.verifier_version, "verifier_version"),
        registry_id: parseHex32(input.registry_id, "registry_id"),
        membership_id: parseHex32(input.membership_id, "membership_id"),
        owner: parseHex32(input.owner, "owner"),
        provider: parseProvider(input.provider),
        verified: parseBoolean(input.verified, "verified"),
        duplicate_key_hash: parseHex32(input.duplicate_key_hash, "duplicate_key_hash"),
        evidence_hash: parseHex32(input.evidence_hash, "evidence_hash"),
        issued_at_ms: parseSafeU64(input.issued_at_ms, "issued_at_ms"),
        expires_at_ms: parseSafeU64(input.expires_at_ms, "expires_at_ms"),
        terms_version: parseSafeU64(input.terms_version, "terms_version"),
        signed_statement_hash: parseHex32(input.signed_statement_hash, "signed_statement_hash"),
    };
}

function assertVerifiedResultMatchesRequest(
    result: VerifiedMembershipTeeResult,
    request: IdentityVerifyRequest,
): void {
    if (
        result.registry_id !== request.registry_id ||
        result.membership_id !== request.membership_id ||
        result.owner !== request.owner ||
        result.provider !== request.provider ||
        result.terms_version !== request.terms_version ||
        result.signed_statement_hash !== request.signed_statement_hash
    ) {
        throw new Error("membership TEE result does not match verification job request");
    }
}

function readValidatedRequest(row: VerificationJobRow): IdentityVerifyRequest {
    const parsed = JSON.parse(row.request_json) as unknown;
    const request = parseIdentityVerifyRequest(parsed);
    if (!request.ok) {
        throw new Error(`stored verification job request is malformed: ${request.message}`);
    }
    return request.value;
}

function readValidatedRequestJson(row: VerificationJobRow): string {
    readValidatedRequest(row);
    return row.request_json;
}

async function requireCurrentWorkflowAttempt(
    options: RunnerControlHandlerOptions,
    event: { job_id: string; attempt?: number | undefined },
    requireProcessing: boolean,
): Promise<VerificationJobRow> {
    const repository = options.repository;
    if (repository === undefined) {
        throw new Error("verification job repository is required for membership runner workflow");
    }
    if (event.attempt === undefined) {
        throw new Error("runner workflow attempt is required");
    }
    const row = await repository.get(event.job_id);
    if (row === null) {
        throw new Error("verification job not found");
    }
    const expectedExecutionName = workflowExecutionName(event.job_id, event.attempt);
    if (
        row.workflow_execution_name !== expectedExecutionName ||
        row.retry_count + 1 !== event.attempt ||
        (requireProcessing && row.status !== "processing")
    ) {
        throw new Error("stale runner workflow attempt");
    }
    return row;
}

function workflowExecutionName(jobId: string, attempt: number): string {
    return `membership-${jobId}-${attempt}`;
}

function readRunnerFailureErrorCode(errorCode: string | undefined): string {
    if (errorCode === undefined || errorCode.length === 0) {
        return "AWS_MEMBERSHIP_RUNNER_PROCESS_FAILED";
    }
    return errorCode;
}

function parseNitroEnclaveProcessCommand(command: string): string[] {
    const words: string[] = [];
    let current = "";
    let quote: "'" | '"' | undefined;
    let wordStarted = false;

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (char === undefined) {
            throw new Error("invalid NITRO_ENCLAVE_PROCESS_COMMAND");
        }
        if (quote === "'") {
            if (char === "'") {
                quote = undefined;
            } else {
                current += char;
            }
            continue;
        }
        if (quote === '"') {
            if (char === '"') {
                quote = undefined;
                continue;
            }
            if (char === "\\") {
                const next = command[index + 1];
                if (next === undefined) {
                    throw new Error("invalid NITRO_ENCLAVE_PROCESS_COMMAND: trailing escape");
                }
                current += next;
                index += 1;
                continue;
            }
            current += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            wordStarted = true;
            continue;
        }
        if (char === "\\") {
            const next = command[index + 1];
            if (next === undefined) {
                throw new Error("invalid NITRO_ENCLAVE_PROCESS_COMMAND: trailing escape");
            }
            current += next;
            wordStarted = true;
            index += 1;
            continue;
        }
        if (/\s/.test(char)) {
            if (wordStarted) {
                words.push(current);
                current = "";
                wordStarted = false;
            }
            continue;
        }
        current += char;
        wordStarted = true;
    }

    if (quote !== undefined) {
        throw new Error("invalid NITRO_ENCLAVE_PROCESS_COMMAND: unterminated quote");
    }
    if (wordStarted) {
        words.push(current);
    }
    if (words.length === 0 || words[0]?.length === 0) {
        throw new Error("invalid NITRO_ENCLAVE_PROCESS_COMMAND: command is empty");
    }
    return words;
}

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function requireRepository(options: RunnerControlHandlerOptions): VerificationJobRepository {
    if (options.repository === undefined) {
        throw new Error("verification job repository is required for this runner workflow action");
    }
    return options.repository;
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseString(input: unknown, field: string): string {
    if (typeof input !== "string" || input.length === 0) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return input;
}

function parseVerifierFamily(input: unknown): "identity" {
    if (input !== "identity") {
        throw new Error("verifier_family must be identity");
    }
    return input;
}

function parseProvider(input: unknown): "kyc" | "world_id" {
    if (input !== "kyc" && input !== "world_id") {
        throw new Error("provider must be kyc or world_id");
    }
    return input;
}

function parseBoolean(input: unknown, field: string): boolean {
    if (typeof input !== "boolean") {
        throw new Error(`${field} must be a boolean`);
    }
    return input;
}

function parseSafeU64(input: unknown, field: string): number {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
        throw new Error(`${field} must be a safe unsigned integer`);
    }
    return input;
}

function parseHex(input: unknown, field: string): string {
    if (typeof input !== "string" || !/^0x[0-9a-fA-F]+$/.test(input)) {
        throw new Error(`${field} must be a 0x-prefixed hex string`);
    }
    return input;
}

function parseFixedHex(input: unknown, field: string, byteLength: number): string {
    const value = parseHex(input, field);
    if (value.length !== 2 + byteLength * 2) {
        throw new Error(`${field} must be ${byteLength} bytes`);
    }
    return value;
}

function parseHex32(input: unknown, field: string): string {
    return parseFixedHex(input, field, 32);
}

async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}
