import { createHash } from "node:crypto";
import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
    SetDesiredCapacityCommand,
} from "@aws-sdk/client-auto-scaling";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
    DescribeInstanceInformationCommand,
    GetCommandInvocationCommand,
    SendCommandCommand,
    SSMClient,
} from "@aws-sdk/client-ssm";
import { encodeIdentityVerificationResultBcsHex } from "@sonari/membership-verifier-shared";
import {
    dispatchRunnerCommand,
    type EnclaveAttestationResult,
    type EnclaveVerificationMetadata,
    findReadyRunnerInstance,
    MEMBERSHIP_IDENTITY_VERIFIER_KIND,
    parseExpectedVerifierKind,
    pollRunnerCommand,
    readEnclaveAttestation,
    readRunnerResultText,
    requireRegistrationMetadata,
    setRunnerDesiredCapacity,
    withVerifierKind,
} from "@sonari/verifier-contracts";
import {
    DEFAULT_RETRY_BACKOFF_MS,
    DynamoDbVerificationJobRepository,
    type IdentityVerifyRequest,
    parseIdentityVerifyRequest,
    type VerificationJobRepository,
    type VerificationJobRow,
} from "./index.js";
import {
    createEd25519SuiSignerFromPrivateKey,
    dryRunIdentityVerificationSubmit,
    IDENTITY_VERIFIER_VERSION,
    type IdentityVerificationDryRunSuccess,
    type IdentityVerificationRelayerMode,
    type IdentityVerificationSigner,
    type IdentityVerificationSubmitClient,
    type IdentityVerificationSubmitConfig,
    type IdentityVerificationSubmitSuccess,
    type IdentityVerificationSubmitTransaction,
    type IdentityVerificationSuiResult,
    SuiEnclaveRegistrationAdapter,
    type SuiEnclaveRegistrationConfig,
    type SuiNetwork,
    submitIdentityVerificationPayload,
} from "./sui_submission.js";

export interface RunnerWorkflowConfig {
    readonly autoScalingGroupName: string;
    readonly resultBucket: string;
    readonly nitroEnclaveProcessCommand: string;
    readonly suiSubmission?: RunnerSuiSubmissionConfig | undefined;
}

export interface RunnerSuiSubmissionConfig {
    readonly mode: IdentityVerificationRelayerMode;
    readonly packageId: string;
    readonly pauseStateId: string;
    readonly identityRegistryId: string;
    readonly membershipRegistryId: string;
    readonly verifierRegistryId: string;
    readonly clockId: string;
    readonly network?: SuiNetwork | undefined;
    readonly grpcUrl?: string | undefined;
    readonly senderAddress?: string | undefined;
    readonly allowSubmit?: boolean | undefined;
    readonly configurationError?: string | undefined;
    readonly loadSigner?: (() => Promise<IdentityVerificationSigner>) | undefined;
    readonly client?: IdentityVerificationSubmitClient | undefined;
    readonly transaction?: IdentityVerificationSubmitTransaction | undefined;
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

export interface RelayerSignerSecretReader {
    getSecretString(secretArn: string): Promise<string>;
}

export interface SignedIdentityPayloadForRelayer {
    readonly status: "verified";
    readonly payload_bcs_hex: string;
    readonly signature: string;
    readonly public_key: string;
    readonly membership_id: string;
}

export interface SuiSubmissionAdapter {
    dryRun(
        result: SignedIdentityPayloadForRelayer,
    ): Promise<IdentityVerificationSuiResult<IdentityVerificationDryRunSuccess>>;
    submit(
        result: SignedIdentityPayloadForRelayer,
    ): Promise<IdentityVerificationSuiResult<IdentityVerificationSubmitSuccess>>;
}

export interface SuiDryRunHandoffRecord {
    readonly signed_payload: SignedIdentityPayloadForRelayer;
    readonly request: IdentityVerificationDryRunSuccess["request"];
    readonly transaction_bytes: number[];
    readonly effects: Record<string, unknown>;
}

export const MEMBERSHIP_IDENTITY_VERIFIER_CONFIG_KEY = 2;

export interface EnclaveRegistrationAdapter {
    register(input: {
        jobId: string;
        attestationDocumentHex: string;
        publicKey: string;
    }): Promise<EnclaveVerificationMetadata>;
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

type RunnerControlVerifierKind = {
    verifier_kind?: typeof MEMBERSHIP_IDENTITY_VERIFIER_KIND | undefined;
};

export type RunnerControlEvent = RunnerControlVerifierKind &
    (
        | { action: "start_instance"; job_id: string; attempt?: number | undefined }
        | { action: "find_ready_instance"; job_id: string; attempt?: number | undefined }
        | {
              action: "dispatch_get_attestation_command";
              job_id: string;
              attempt?: number | undefined;
              instance_id: string;
          }
        | {
              action: "read_attestation_result";
              job_id: string;
              attempt?: number | undefined;
              result_s3_key: string;
          }
        | {
              action: "register_enclave_instance";
              job_id: string;
              attempt?: number | undefined;
              attestation: EnclaveAttestationResult;
          }
        | {
              action: "dispatch_process_data_command";
              job_id: string;
              attempt?: number | undefined;
              instance_id: string;
              registration_metadata: EnclaveVerificationMetadata;
          }
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
              action: "dry_run_sui_submission";
              job_id: string;
              attempt?: number | undefined;
              result: MembershipTeeResult;
          }
        | {
              action: "submit_sui_submission";
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
        | { action: "stop_instance"; job_id: string; attempt?: number | undefined }
    );

export type RunnerControlResult = RunnerControlVerifierKind &
    (
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
              attestation: EnclaveAttestationResult;
          }
        | {
              job_id: string;
              attempt?: number | undefined;
              registration_metadata: EnclaveVerificationMetadata;
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
        | {
              job_id: string;
              attempt?: number | undefined;
              sui_submission: "skipped" | "succeeded" | "failed";
              result: MembershipTeeResult;
              tx_digest?: string | undefined;
          }
        | { job_id: string; attempt?: number | undefined; failed: true }
    );

export interface RunnerControlHandlerOptions {
    readonly autoscaling: AutoScalingClientLike;
    readonly ec2: Ec2ClientLike;
    readonly ssm: SsmClientLike;
    readonly s3: S3ClientLike;
    readonly repository?: VerificationJobRepository | undefined;
    readonly suiSubmission?: SuiSubmissionAdapter | undefined;
    readonly enclaveRegistration?: EnclaveRegistrationAdapter | undefined;
    readonly now?: (() => number) | undefined;
    readonly config: RunnerWorkflowConfig;
}

export function createRunnerControlHandler(options: RunnerControlHandlerOptions) {
    return async function runnerControlHandler(
        event: RunnerControlEvent,
    ): Promise<RunnerControlResult> {
        const verifierKind = parseExpectedVerifierKind(
            (event as { verifier_kind?: unknown }).verifier_kind,
            MEMBERSHIP_IDENTITY_VERIFIER_KIND,
        );
        const retainVerifierKind = (output: RunnerControlResult): RunnerControlResult =>
            withVerifierKind(verifierKind, output) as RunnerControlResult;
        switch (event.action) {
            case "start_instance":
                await requireCurrentWorkflowAttempt(options, event, true);
                await setRunnerDesiredCapacity(options.autoscaling, {
                    autoScalingGroupName: options.config.autoScalingGroupName,
                    desiredCapacity: 1,
                });
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    capacity: 1,
                });
            case "stop_instance":
                await setRunnerDesiredCapacity(options.autoscaling, {
                    autoScalingGroupName: options.config.autoScalingGroupName,
                    desiredCapacity: 0,
                });
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    capacity: 0,
                });
            case "find_ready_instance": {
                const instanceId = await findReadyRunnerInstance(options.ec2, options.ssm, {
                    autoScalingGroupName: options.config.autoScalingGroupName,
                    runnerLabel: "membership runner",
                });
                await requireCurrentWorkflowAttempt(options, event, true);
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    instance_id: instanceId,
                });
            }
            case "dispatch_get_attestation_command": {
                const nowMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, true);
                const dispatched = await dispatchRunnerCommand(options.ssm, {
                    workflowId: event.job_id,
                    instanceId: event.instance_id,
                    dispatchTimestampMs: nowMs,
                    buildShellCommand: (resultS3Key) =>
                        buildSsmShellCommand({
                            jobId: event.job_id,
                            teeInput: { action: "get_attestation" },
                            dispatchTimestampMs: nowMs,
                            resultBucket: options.config.resultBucket,
                            resultS3Key,
                            nitroEnclaveProcessCommand: options.config.nitroEnclaveProcessCommand,
                        }),
                });
                await requireCurrentWorkflowAttempt(options, event, true);
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: dispatched.commandId,
                    result_s3_key: dispatched.resultS3Key,
                    command_poll_count: dispatched.commandPollCount,
                });
            }
            case "read_attestation_result": {
                await requireCurrentWorkflowAttempt(options, event, true);
                const text = await readRunnerResultText(options.s3, {
                    bucket: options.config.resultBucket,
                    key: event.result_s3_key,
                });
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    attestation: readEnclaveAttestation(JSON.parse(text) as unknown),
                });
            }
            case "register_enclave_instance": {
                const registrar = options.enclaveRegistration ?? LOCAL_ENCLAVE_REGISTRATION_ADAPTER;
                const attestation = readEnclaveAttestation(event.attestation);
                await requireCurrentWorkflowAttempt(options, event, true);
                const registered = requireRegistrationMetadata(
                    await registrar.register({
                        jobId: event.job_id,
                        attestationDocumentHex: attestation.attestation_document_hex,
                        publicKey: attestation.public_key,
                    }),
                    MEMBERSHIP_IDENTITY_VERIFIER_CONFIG_KEY,
                );
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    registration_metadata: registered,
                });
            }
            case "dispatch_process_data_command": {
                const nowMs = options.now?.() ?? Date.now();
                const row = await requireCurrentWorkflowAttempt(options, event, true);
                const requestJson = readValidatedRequestJson(row);
                const registrationMetadata = requireRegistrationMetadata(
                    event.registration_metadata,
                    MEMBERSHIP_IDENTITY_VERIFIER_CONFIG_KEY,
                );
                const dispatched = await dispatchRunnerCommand(options.ssm, {
                    workflowId: event.job_id,
                    instanceId: event.instance_id,
                    dispatchTimestampMs: nowMs,
                    buildShellCommand: (resultS3Key) =>
                        buildSsmShellCommand({
                            jobId: event.job_id,
                            teeInput: {
                                action: "process_data",
                                payload: JSON.parse(requestJson) as unknown,
                                registration_metadata: registrationMetadata,
                            },
                            dispatchTimestampMs: nowMs,
                            resultBucket: options.config.resultBucket,
                            resultS3Key,
                            nitroEnclaveProcessCommand: options.config.nitroEnclaveProcessCommand,
                        }),
                });
                await requireCurrentWorkflowAttempt(options, event, true);
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: dispatched.commandId,
                    result_s3_key: dispatched.resultS3Key,
                    command_poll_count: dispatched.commandPollCount,
                });
            }
            case "dispatch_tee_command": {
                const nowMs = options.now?.() ?? Date.now();
                const row = await requireCurrentWorkflowAttempt(options, event, true);
                const requestJson = readValidatedRequestJson(row);
                const dispatched = await dispatchRunnerCommand(options.ssm, {
                    workflowId: event.job_id,
                    instanceId: event.instance_id,
                    dispatchTimestampMs: nowMs,
                    buildShellCommand: (resultS3Key) =>
                        buildSsmShellCommand({
                            jobId: event.job_id,
                            teeInput: JSON.parse(requestJson) as unknown,
                            dispatchTimestampMs: nowMs,
                            resultBucket: options.config.resultBucket,
                            resultS3Key,
                            nitroEnclaveProcessCommand: options.config.nitroEnclaveProcessCommand,
                        }),
                });
                await requireCurrentWorkflowAttempt(options, event, true);
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: dispatched.commandId,
                    result_s3_key: dispatched.resultS3Key,
                    command_poll_count: dispatched.commandPollCount,
                });
            }
            case "poll_command": {
                await requireCurrentWorkflowAttempt(options, event, true);
                const polled = await pollRunnerCommand(options.ssm, {
                    instanceId: event.instance_id,
                    commandId: event.command_id,
                    commandPollCount: event.command_poll_count,
                });
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: event.command_id,
                    result_s3_key: event.result_s3_key,
                    command_poll_count: polled.commandPollCount,
                    command_status: polled.commandStatus,
                });
            }
            case "read_result": {
                const row = await requireCurrentWorkflowAttempt(options, event, true);
                const text = await readRunnerResultText(options.s3, {
                    bucket: options.config.resultBucket,
                    key: event.result_s3_key,
                });
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    result: parseTeeResult(text, readValidatedRequest(row)),
                });
            }
            case "apply_result": {
                const repository = requireRepository(options);
                await requireCurrentWorkflowAttempt(options, event, true);
                const nowMs = options.now?.() ?? Date.now();
                const result = event.result;
                if (result.status === "pending_source") {
                    const updated = await repository.markRetry(
                        event.job_id,
                        nowMs,
                        nowMs + DEFAULT_RETRY_BACKOFF_MS,
                        result.error_code,
                    );
                    if (!updated) {
                        throw new Error("stale runner workflow attempt");
                    }
                    return retainVerifierKind({
                        job_id: event.job_id,
                        attempt: event.attempt,
                        applied: true,
                        result,
                    });
                }
                if (result.status === "rejected" || result.status === "unsupported") {
                    const updated = await repository.markFailed(
                        event.job_id,
                        nowMs,
                        result.error_code,
                        result.error_code,
                    );
                    if (!updated) {
                        throw new Error("stale runner workflow attempt");
                    }
                    return retainVerifierKind({
                        job_id: event.job_id,
                        attempt: event.attempt,
                        applied: true,
                        result,
                    });
                }
                if (result.status === "verified") {
                    const updated = await repository.markCompleted(
                        event.job_id,
                        nowMs,
                        teeOnlyCompletionDigest(result),
                    );
                    if (!updated) {
                        throw new Error("stale runner workflow attempt");
                    }
                    return retainVerifierKind({
                        job_id: event.job_id,
                        attempt: event.attempt,
                        applied: true,
                        result,
                    });
                }
                throw new Error("unknown membership TEE result status");
            }
            case "dry_run_sui_submission": {
                await requireCurrentWorkflowAttempt(options, event, true);
                if (event.result.status !== "verified") {
                    return retainVerifierKind({
                        job_id: event.job_id,
                        attempt: event.attempt,
                        sui_submission: "skipped",
                        result: event.result,
                    });
                }
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                const submitter = options.suiSubmission ?? buildSuiSubmissionFromConfig(options);
                if (submitter === undefined) {
                    await markSuiSubmissionFailed(
                        repository,
                        event,
                        nowMs,
                        "RELAYER_SUBMIT_FAILED",
                        "Sui submission config is required",
                    );
                    return retainVerifierKind({
                        job_id: event.job_id,
                        attempt: event.attempt,
                        sui_submission: "failed",
                        result: event.result,
                    });
                }
                const signedPayload = signedPayloadForRelayer(event.result);
                const result = await submitter.dryRun(signedPayload);
                if (result.ok) {
                    const updated = await repository.markSuiDryRunSucceeded(
                        event.job_id,
                        nowMs,
                        JSON.stringify(suiDryRunHandoffRecord(signedPayload, result.value)),
                    );
                    if (!updated) {
                        throw new Error("stale runner workflow attempt");
                    }
                    return retainVerifierKind({
                        job_id: event.job_id,
                        attempt: event.attempt,
                        sui_submission: "succeeded",
                        result: event.result,
                    });
                }
                await markSuiSubmissionFailed(
                    repository,
                    event,
                    nowMs,
                    result.error_code,
                    result.message,
                );
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    sui_submission: "failed",
                    result: event.result,
                });
            }
            case "submit_sui_submission": {
                await requireCurrentWorkflowAttempt(options, event, true);
                if (event.result.status !== "verified") {
                    return retainVerifierKind({
                        job_id: event.job_id,
                        attempt: event.attempt,
                        sui_submission: "skipped",
                        result: event.result,
                    });
                }
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                const submitter = options.suiSubmission ?? buildSuiSubmissionFromConfig(options);
                if (submitter === undefined) {
                    await markSuiSubmissionFailed(
                        repository,
                        event,
                        nowMs,
                        "RELAYER_SUBMIT_FAILED",
                        "Sui submission config is required",
                    );
                    return retainVerifierKind({
                        job_id: event.job_id,
                        attempt: event.attempt,
                        sui_submission: "failed",
                        result: event.result,
                    });
                }
                const result = await submitter.submit(signedPayloadForRelayer(event.result));
                if (!result.ok) {
                    await markSuiSubmissionFailed(
                        repository,
                        event,
                        nowMs,
                        result.error_code,
                        result.message,
                    );
                    return retainVerifierKind({
                        job_id: event.job_id,
                        attempt: event.attempt,
                        sui_submission: "failed",
                        result: event.result,
                    });
                }
                const updated = await repository.markCompleted(
                    event.job_id,
                    nowMs,
                    result.value.digest,
                );
                if (!updated) {
                    throw new Error("stale runner workflow attempt");
                }
                const row = await repository.get(event.job_id);
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    sui_submission: "succeeded",
                    result: event.result,
                    tx_digest: row?.tx_digest ?? result.value.digest,
                });
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
                return retainVerifierKind({
                    job_id: event.job_id,
                    attempt: event.attempt,
                    failed: true,
                });
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
            const { commandStatus } = await pollRunnerCommand(this, {
                instanceId,
                commandId: sent.commandId,
            });
            if (commandStatus === "SUCCEEDED") {
                return true;
            }
            if (commandStatus === "FAILED") {
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

function teeOnlyCompletionDigest(result: VerifiedMembershipTeeResult): string {
    const digest = createHash("sha256").update(result.payload_bcs_hex).digest("hex");
    return `tee-result:${digest}`;
}

class LocalEnclaveRegistrationAdapter implements EnclaveRegistrationAdapter {
    async register(input: {
        jobId: string;
        attestationDocumentHex: string;
        publicKey: string;
    }): Promise<EnclaveVerificationMetadata> {
        return {
            verifier_config_key: MEMBERSHIP_IDENTITY_VERIFIER_CONFIG_KEY,
            verifier_config_version: IDENTITY_VERIFIER_VERSION,
            enclave_instance_public_key: input.publicKey,
        };
    }
}

const LOCAL_ENCLAVE_REGISTRATION_ADAPTER = new LocalEnclaveRegistrationAdapter();

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

class AwsRelayerSignerSecretReader implements RelayerSignerSecretReader {
    private readonly client = new SecretsManagerClient({});

    async getSecretString(secretArn: string): Promise<string> {
        const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretArn }));
        if (!isNonEmptyString(result.SecretString)) {
            throw new Error("RELAYER_SIGNER_SECRET_ARN did not contain a string secret");
        }
        return result.SecretString;
    }
}

function buildEnclaveRegistrationAdapter(secretReader: RelayerSignerSecretReader): {
    enclaveRegistration?: EnclaveRegistrationAdapter;
} {
    const config = readEnclaveRegistrationConfigFromEnv(secretReader);
    if (config === undefined || !config.allowSubmit) {
        return {};
    }
    return { enclaveRegistration: new SuiEnclaveRegistrationAdapter(config) };
}

export async function handler(event: RunnerControlEvent): Promise<RunnerControlResult> {
    parseExpectedVerifierKind(
        (event as { verifier_kind?: unknown }).verifier_kind,
        MEMBERSHIP_IDENTITY_VERIFIER_KIND,
    );
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
            suiSubmission: readSuiSubmissionConfigFromEnv(new AwsRelayerSignerSecretReader()),
        },
        ...buildEnclaveRegistrationAdapter(new AwsRelayerSignerSecretReader()),
    })(event);
}

function buildSsmShellCommand(input: {
    jobId: string;
    teeInput: unknown;
    dispatchTimestampMs: number;
    resultBucket: string;
    resultS3Key: string;
    nitroEnclaveProcessCommand: string;
}): string {
    const tempResultPath = `/tmp/sonari-membership-tee-result-${input.jobId}-${input.dispatchTimestampMs}.json`;
    const commandInvocation = parseNitroEnclaveProcessCommand(input.nitroEnclaveProcessCommand)
        .map(shellSingleQuote)
        .join(" ");
    const teeInput = input.teeInput;
    return [
        "set -euo pipefail",
        "source /opt/sonari/runner.env",
        "systemctl is-active --quiet nitro-enclaves-allocator.service",
        "systemctl is-active --quiet sonari-world-id-vsock-proxy.service",
        buildRequiredShellEnvCheck("SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"),
        buildRequiredShellEnvCheck("SONARI_NITRO_RUN_ENCLAVE_ARGS"),
        buildRequiredShellEnvCheck("SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID"),
        buildRequiredShellEnvCheck("SONARI_WORLD_ID_API_BASE"),
        buildRequiredShellEnvCheck("SONARI_WORLD_ID_EGRESS_PROXY_URL"),
        buildRequiredShellEnvCheck("SONARI_WORLD_ID_APP_ID"),
        buildRequiredShellEnvCheck("NITRO_ENCLAVE_PROCESS_COMMAND"),
        'test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"',
        "export SONARI_MEMBERSHIP_IDENTITY_EIF_PATH SONARI_NITRO_RUN_ENCLAVE_ARGS SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID SONARI_WORLD_ID_API_BASE SONARI_WORLD_ID_EGRESS_PROXY_URL SONARI_WORLD_ID_APP_ID NITRO_ENCLAVE_PROCESS_COMMAND",
        `export SONARI_VERIFIER_KIND=${MEMBERSHIP_IDENTITY_VERIFIER_KIND}`,
        `RESULT_S3_KEY=${shellSingleQuote(input.resultS3Key)}`,
        `printf '%s' ${shellSingleQuote(JSON.stringify(teeInput))} | ${commandInvocation} > ${shellSingleQuote(tempResultPath)}`,
        `aws s3 cp ${shellSingleQuote(tempResultPath)} ${shellSingleQuote(`s3://${input.resultBucket}/${input.resultS3Key}`)}`,
    ].join("\n");
}

export function buildRunnerBootstrapReadinessShellCommand(): string {
    return [
        "set -euo pipefail",
        "test -f /opt/sonari/bootstrap-complete",
        "test -s /opt/sonari/runner.env",
        "source /opt/sonari/runner.env",
        buildRequiredShellEnvCheck("SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"),
        buildRequiredShellEnvCheck("SONARI_NITRO_RUN_ENCLAVE_ARGS"),
        buildRequiredShellEnvCheck("SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID"),
        buildRequiredShellEnvCheck("SONARI_WORLD_ID_API_BASE"),
        buildRequiredShellEnvCheck("SONARI_WORLD_ID_EGRESS_PROXY_URL"),
        buildRequiredShellEnvCheck("SONARI_WORLD_ID_APP_ID"),
        buildRequiredShellEnvCheck("NITRO_ENCLAVE_PROCESS_COMMAND"),
        'test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"',
        "systemctl is-active --quiet nitro-enclaves-allocator.service",
        "systemctl is-active --quiet sonari-world-id-vsock-proxy.service",
    ].join("\n");
}

function buildRequiredShellEnvCheck(name: string, message = `${name} is required`): string {
    return `: "\${${name}:?${message}}"`;
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

class DirectSuiSubmissionAdapter implements SuiSubmissionAdapter {
    constructor(private readonly config: RunnerSuiSubmissionConfig) {}

    async dryRun(
        result: SignedIdentityPayloadForRelayer,
    ): Promise<IdentityVerificationSuiResult<IdentityVerificationDryRunSuccess>> {
        if (this.config.configurationError !== undefined) {
            return relayerSubmitFailed(this.config.configurationError);
        }
        if (this.config.mode !== "dry_run" && this.config.mode !== "submit") {
            return relayerSubmitFailed("dry_run requires IDENTITY_RELAYER_MODE=dry_run or submit");
        }
        return dryRunIdentityVerificationSubmit(result, this.submitConfig());
    }

    async submit(
        result: SignedIdentityPayloadForRelayer,
    ): Promise<IdentityVerificationSuiResult<IdentityVerificationSubmitSuccess>> {
        if (this.config.configurationError !== undefined) {
            return relayerSubmitFailed(this.config.configurationError);
        }
        if (this.config.mode !== "submit") {
            return relayerSubmitFailed("submit requires RELAYER_MODE=submit");
        }
        const signer = await this.config.loadSigner?.();
        return submitIdentityVerificationPayload(result, {
            ...this.submitConfig(),
            ...(signer === undefined ? {} : { signer }),
        });
    }

    private submitConfig(): IdentityVerificationSubmitConfig {
        return {
            packageId: this.config.packageId,
            pauseStateId: this.config.pauseStateId,
            identityRegistryId: this.config.identityRegistryId,
            membershipRegistryId: this.config.membershipRegistryId,
            verifierRegistryId: this.config.verifierRegistryId,
            clockId: this.config.clockId,
            ...(this.config.network === undefined ? {} : { network: this.config.network }),
            ...(this.config.grpcUrl === undefined ? {} : { grpcUrl: this.config.grpcUrl }),
            ...(this.config.senderAddress === undefined
                ? {}
                : { senderAddress: this.config.senderAddress }),
            ...(this.config.allowSubmit === undefined
                ? {}
                : { allowSubmit: this.config.allowSubmit }),
            ...(this.config.client === undefined ? {} : { client: this.config.client }),
            ...(this.config.transaction === undefined
                ? {}
                : { transaction: this.config.transaction }),
        };
    }
}

function signedPayloadForRelayer(
    result: VerifiedMembershipTeeResult,
): SignedIdentityPayloadForRelayer {
    return {
        status: "verified",
        payload_bcs_hex: result.payload_bcs_hex,
        signature: result.signature,
        public_key: result.public_key,
        membership_id: result.membership_id,
    };
}

function suiDryRunHandoffRecord(
    signedPayload: SignedIdentityPayloadForRelayer,
    dryRun: IdentityVerificationDryRunSuccess,
): SuiDryRunHandoffRecord {
    return {
        signed_payload: signedPayload,
        request: dryRun.request,
        transaction_bytes: dryRun.transactionBytes,
        effects: dryRun.effects,
    };
}

function buildSuiSubmissionFromConfig(
    options: RunnerControlHandlerOptions,
): SuiSubmissionAdapter | undefined {
    const config = options.config.suiSubmission;
    return config === undefined ? undefined : new DirectSuiSubmissionAdapter(config);
}

export function readSuiSubmissionConfigFromEnv(
    secretReader: RelayerSignerSecretReader,
): RunnerSuiSubmissionConfig | undefined {
    const mode = process.env.IDENTITY_RELAYER_MODE;
    if (mode === undefined || mode.length === 0) {
        return undefined;
    }
    if (mode !== "dry_run" && mode !== "submit") {
        return {
            mode: "dry_run",
            packageId: "",
            pauseStateId: "",
            identityRegistryId: "",
            membershipRegistryId: "",
            verifierRegistryId: "",
            clockId: "0x6",
            configurationError: `Unsupported IDENTITY_RELAYER_MODE: ${mode}`,
        };
    }

    const packageId = process.env.SONARI_IDENTITY_PACKAGE_ID ?? "";
    const pauseStateId = process.env.SONARI_IDENTITY_PAUSE_STATE_ID ?? "";
    const identityRegistryId = process.env.SONARI_IDENTITY_REGISTRY_ID ?? "";
    const membershipRegistryId = process.env.SONARI_MEMBERSHIP_REGISTRY_ID ?? "";
    const verifierRegistryId = process.env.SONARI_VERIFIER_REGISTRY_ID ?? "";
    // SONARI_MEMBERSHIP_PASS_ID is removed: membershipPassId is resolved dynamically from
    // the verified result's membership_id field at submission time.
    const clockId = process.env.SONARI_SUI_CLOCK_ID ?? "0x6";
    let configurationError: string | undefined;
    const missingObjectFields = (
        [
            ["SONARI_IDENTITY_PACKAGE_ID", packageId],
            ["SONARI_IDENTITY_PAUSE_STATE_ID", pauseStateId],
            ["SONARI_IDENTITY_REGISTRY_ID", identityRegistryId],
            ["SONARI_MEMBERSHIP_REGISTRY_ID", membershipRegistryId],
            ["SONARI_VERIFIER_REGISTRY_ID", verifierRegistryId],
        ] satisfies Array<readonly [string, string]>
    )
        .filter(([, value]) => value.length === 0)
        .map(([name]) => name);
    if (missingObjectFields.length > 0) {
        configurationError = appendConfigurationError(
            configurationError,
            `${missingObjectFields.join(", ")} required for RELAYER_MODE=${mode}`,
        );
    }

    const network = readSuiNetwork(process.env.RELAYER_NETWORK);
    if (network === undefined) {
        configurationError = appendConfigurationError(
            configurationError,
            "RELAYER_NETWORK is required",
        );
    }
    const grpcUrl = process.env.RELAYER_GRPC_URL;
    const senderAddress = process.env.RELAYER_SENDER_ADDRESS;
    const allowSubmit = mode === "submit" ? process.env.RELAYER_ALLOW_SUBMIT === "true" : undefined;
    let loadSigner: (() => Promise<IdentityVerificationSigner>) | undefined;
    if (mode === "submit") {
        const signerSecretArn = process.env.RELAYER_SIGNER_SECRET_ARN;
        if (signerSecretArn !== undefined && signerSecretArn.length > 0) {
            loadSigner = async () =>
                createEd25519SuiSignerFromPrivateKey(
                    await secretReader.getSecretString(signerSecretArn),
                );
        }
    }
    return {
        mode,
        packageId,
        pauseStateId,
        identityRegistryId,
        membershipRegistryId,
        verifierRegistryId,
        clockId,
        ...(configurationError === undefined ? {} : { configurationError }),
        ...(network === undefined ? {} : { network }),
        ...(grpcUrl === undefined ? {} : { grpcUrl }),
        ...(senderAddress === undefined ? {} : { senderAddress }),
        ...(allowSubmit === undefined ? {} : { allowSubmit }),
        ...(loadSigner === undefined ? {} : { loadSigner }),
    };
}

export function readEnclaveRegistrationConfigFromEnv(
    secretReader: RelayerSignerSecretReader,
): SuiEnclaveRegistrationConfig | undefined {
    const mode = process.env.IDENTITY_RELAYER_MODE;
    if (mode === undefined || mode.length === 0 || mode !== "submit") {
        return undefined;
    }
    const packageId = process.env.SONARI_IDENTITY_PACKAGE_ID ?? "";
    const verifierRegistry = process.env.SONARI_VERIFIER_REGISTRY_ID ?? "";
    const allowSubmit = process.env.RELAYER_ALLOW_SUBMIT === "true";
    let configurationError: string | undefined;

    if (packageId.length === 0) {
        configurationError = appendConfigurationError(
            configurationError,
            "SONARI_IDENTITY_PACKAGE_ID is required for enclave registration",
        );
    }
    if (verifierRegistry.length === 0) {
        configurationError = appendConfigurationError(
            configurationError,
            "SONARI_VERIFIER_REGISTRY_ID is required for enclave registration",
        );
    }

    const target = `${packageId}::metadata_verifier::register_enclave_instance_for_config`;
    const network = readSuiNetwork(process.env.RELAYER_NETWORK);
    const grpcUrl = process.env.RELAYER_GRPC_URL;
    const instanceTtlMs = 24 * 60 * 60 * 1000; // 24 hours per enclave instance

    let loadSigner: (() => Promise<IdentityVerificationSigner>) | undefined;
    if (mode === "submit") {
        const signerSecretArn = process.env.RELAYER_SIGNER_SECRET_ARN;
        if (signerSecretArn !== undefined && signerSecretArn.length > 0) {
            loadSigner = async () =>
                createEd25519SuiSignerFromPrivateKey(
                    await secretReader.getSecretString(signerSecretArn),
                );
        }
    }

    return {
        target,
        verifierRegistry,
        allowSubmit,
        instanceTtlMs,
        ...(configurationError === undefined ? {} : { configurationError }),
        ...(network === undefined ? {} : { network }),
        ...(grpcUrl === undefined ? {} : { grpcUrl }),
        ...(loadSigner === undefined ? {} : { loadSigner }),
    };
}

async function markSuiSubmissionFailed(
    repository: VerificationJobRepository,
    event: { job_id: string; attempt?: number | undefined },
    nowMs: number,
    errorCode: string,
    message: string,
): Promise<void> {
    const updated = await repository.markFailed(event.job_id, nowMs, errorCode, message);
    if (!updated) {
        throw new Error("stale runner workflow attempt");
    }
}

function relayerSubmitFailed<T = never>(message: string): IdentityVerificationSuiResult<T> {
    return { ok: false, error_code: "RELAYER_SUBMIT_FAILED", message };
}

function appendConfigurationError(existing: string | undefined, next: string): string {
    return existing === undefined ? next : `${existing}; ${next}`;
}

function readSuiNetwork(value: string | undefined): SuiNetwork | undefined {
    return value === "mainnet" || value === "testnet" || value === "devnet" ? value : undefined;
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
