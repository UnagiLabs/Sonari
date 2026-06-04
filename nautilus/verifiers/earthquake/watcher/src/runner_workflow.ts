import { createHash } from "node:crypto";
import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
    SetDesiredCapacityCommand,
} from "@aws-sdk/client-auto-scaling";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
    DescribeInstanceInformationCommand,
    GetCommandInvocationCommand,
    SendCommandCommand,
    SSMClient,
} from "@aws-sdk/client-ssm";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
    buildRelayerRequestPreview,
    createEd25519SuiSignerFromPrivateKey,
    type RelayerResult,
    type RelayerSigner,
    type RelayerSubmitConfig,
    type RelayerSubmitSuccess,
    type SuiNetwork,
} from "@sonari/earthquake-relayer";
import {
    EARTHQUAKE_VERIFIER_CONFIG_KEY,
    type EarthquakeOraclePayload,
    type EnclaveVerificationMetadata,
    ERROR_CODES,
    type OracleErrorCode,
    type RawDataEntry,
    type RawDataManifest,
    type TeeCoreResult,
    validateRelayerSubmitInput,
} from "@sonari/earthquake-shared";
import {
    createSuiEnclaveRegistrationTransaction,
    dispatchRunnerCommand,
    EARTHQUAKE_VERIFIER_KIND,
    findReadyRunnerInstance,
    isHexBytes,
    normalizeHex,
    parseExpectedVerifierKind,
    parseHexByteVector,
    pollRunnerCommand,
    readEnclaveAttestation,
    readEnclaveRegistrationMetadata,
    readRunnerResultText,
    requireRegistrationMetadata,
    setRunnerDesiredCapacity,
    withVerifierKind,
} from "@sonari/verifier-contracts";
import { FAILED_RETRY_BACKOFF_MS, HOUR_MS } from "./constants.js";
import { buildEarthquakeVerifierRequest } from "./index.js";
import {
    DirectRelayerAdapter,
    type RelayerAdapter,
    type RelayerMode,
    type RelayerSuccess,
} from "./relayer_preview.js";
import { assertValidUsgsSourceEventId } from "./source_event_id.js";
import {
    DynamoDbStateRepository,
    type SourceArchiveStateUpdate,
    type StateRepository,
} from "./state.js";

const SOURCE_ARCHIVE_RETRY_BACKOFF_MS = FAILED_RETRY_BACKOFF_MS;
const SOURCE_FETCH_TIMEOUT_MS = 30_000;
const SOURCE_ARCHIVER_HTTP_TIMEOUT_MS = 55_000;

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
        network?: SuiNetwork;
        grpcUrl?: string;
        senderAddress?: string;
        allowSubmit?: boolean;
        configurationError?: string;
        loadSigner?: () => Promise<RelayerSigner>;
        submitPayload?: (
            input: unknown,
            config: RelayerSubmitConfig,
        ) => Promise<RelayerResult<RelayerSubmitSuccess>>;
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
    putObjectBytes?(input: { bucket: string; key: string; bytes: Uint8Array }): Promise<void>;
}

export interface SourceFetcherLike {
    fetchBytes(entry: RawDataEntry): Promise<Uint8Array>;
}

export interface WalrusSourceArchiverLike {
    archiveAndVerify(input: {
        entry: RawDataEntry;
        bytes: Uint8Array;
        artifactS3Key: string;
    }): Promise<{ walrusBlobId: string }>;
}

export interface SourceArchiveAdapter {
    fetcher: SourceFetcherLike;
    s3: Required<Pick<S3ClientLike, "putObjectBytes">>;
    walrus: WalrusSourceArchiverLike;
}

export interface RelayerSignerSecretReader {
    getSecretString(secretArn: string): Promise<string>;
}

export interface EnclaveAttestationResult {
    attestation_document_hex: string;
    public_key: string;
}

export interface EnclaveHealthCheckResult {
    status: "healthy";
    external_sources_reachable: boolean;
}

export interface EnclaveRegistrationAdapter {
    register(input: {
        sourceEventId: string;
        attestationDocumentHex: string;
        publicKey: string;
    }): Promise<EnclaveVerificationMetadata>;
}

export interface EnclaveRegistrationConfig {
    target: string;
    verifierRegistry: string;
    network?: SuiNetwork;
    grpcUrl?: string;
    allowSubmit: boolean;
    configurationError?: string;
    signer?: RelayerSigner;
    client?: EnclaveRegistrationClient;
    transaction?: unknown;
    loadSigner?: () => Promise<RelayerSigner>;
    instanceTtlMs: number;
    now?: () => number;
}

export interface EnclaveRegistrationClient {
    signAndExecuteTransaction(input: {
        transaction: unknown;
        signer: RelayerSigner;
        include: { effects: true; events: true };
    }): Promise<EnclaveRegistrationExecutionResponse>;
}

export interface EnclaveRegistrationExecutionStatus {
    success: boolean;
    error?: { message?: string } | string | null;
}

export interface EnclaveRegistrationTransactionResult {
    status?: EnclaveRegistrationExecutionStatus;
    effects?: Record<string, unknown>;
    events?: EnclaveRegistrationEvent[];
}

export interface EnclaveRegistrationEvent {
    type?: string;
    eventType?: string;
    json?: unknown;
    parsedJson?: unknown;
}

export type EnclaveRegistrationExecutionResponse =
    | {
          $kind: "Transaction";
          Transaction: EnclaveRegistrationTransactionResult;
          FailedTransaction?: never;
      }
    | {
          $kind: "FailedTransaction";
          Transaction?: never;
          FailedTransaction: EnclaveRegistrationTransactionResult;
      }
    | Record<string, unknown>;

export interface RelayerRecordSuccessInput {
    mode: RelayerMode;
    target: string;
    registry: string;
    verifierRegistry: string;
    digest?: string;
    objectId?: string;
}

type RunnerControlVerifierKind = {
    verifier_kind?: typeof EARTHQUAKE_VERIFIER_KIND | undefined;
};

export type RunnerControlEvent = RunnerControlVerifierKind &
    (
        | { action: "start_instance"; source_event_id: string; attempt?: number | undefined }
        | { action: "find_ready_instance"; source_event_id: string; attempt?: number | undefined }
        | {
              action: "dispatch_tee_command";
              source_event_id: string;
              attempt?: number | undefined;
              instance_id: string;
          }
        | {
              action: "dispatch_health_check_command";
              source_event_id: string;
              attempt?: number | undefined;
              instance_id: string;
          }
        | {
              action: "dispatch_get_attestation_command";
              source_event_id: string;
              attempt?: number | undefined;
              instance_id: string;
          }
        | {
              action: "read_health_check_result";
              source_event_id: string;
              attempt?: number | undefined;
              result_s3_key: string;
          }
        | {
              action: "read_attestation_result";
              source_event_id: string;
              attempt?: number | undefined;
              result_s3_key: string;
          }
        | {
              action: "register_enclave_instance";
              source_event_id: string;
              attempt?: number | undefined;
              attestation: EnclaveAttestationResult;
          }
        | {
              action: "dispatch_process_data_command";
              source_event_id: string;
              attempt?: number | undefined;
              instance_id: string;
              registration_metadata: EnclaveVerificationMetadata;
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
              action: "archive_sources";
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
              action: "record_relayer_success";
              source_event_id: string;
              attempt?: number | undefined;
              result: TeeCoreResult;
              relayer_success: RelayerRecordSuccessInput;
          }
        | {
              action: "mark_failed";
              source_event_id: string;
              attempt?: number | undefined;
              error_code?: string;
              message?: string;
          }
        | { action: "stop_instance"; source_event_id: string; attempt?: number | undefined }
    );

export type RunnerControlResult = RunnerControlVerifierKind &
    (
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
              registration_metadata: EnclaveVerificationMetadata;
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              health_check: EnclaveHealthCheckResult;
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              attestation: EnclaveAttestationResult;
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
              relayer: "skipped" | "failed";
              result: TeeCoreResult;
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              source_archive:
                  | "skipped"
                  | "success"
                  | "configuration_failed"
                  | "retryable_failed"
                  | "integrity_failed";
              source_artifact_s3_keys: string[];
              result: TeeCoreResult;
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              relayer: "succeeded";
              result: TeeCoreResult;
              relayer_success: RelayerRecordSuccessInput;
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              relayer: "recorded";
              result: TeeCoreResult;
          }
        | { source_event_id: string; attempt?: number | undefined; failed: true }
    );

export interface RunnerControlHandlerOptions {
    autoscaling: AutoScalingClientLike;
    ec2: Ec2ClientLike;
    ssm: SsmClientLike;
    s3: S3ClientLike;
    repository?: StateRepository;
    relayer?: RelayerAdapter;
    enclaveRegistration?: EnclaveRegistrationAdapter;
    sourceArchive?: SourceArchiveAdapter;
    now?: () => number;
    config: RunnerWorkflowConfig;
}

export function createRunnerControlHandler(options: RunnerControlHandlerOptions) {
    return async function runnerControlHandler(
        event: RunnerControlEvent,
    ): Promise<RunnerControlResult> {
        const verifierKind = parseExpectedVerifierKind(
            (event as { verifier_kind?: unknown }).verifier_kind,
            EARTHQUAKE_VERIFIER_KIND,
        );
        const retainVerifierKind = (output: RunnerControlResult): RunnerControlResult =>
            withVerifierKind(verifierKind, output) as RunnerControlResult;
        switch (event.action) {
            case "start_instance":
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "starting_instance",
                });
                await setRunnerDesiredCapacity(options.autoscaling, {
                    autoScalingGroupName: options.config.autoScalingGroupName,
                    desiredCapacity: 1,
                });
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    capacity: 1,
                });
            case "stop_instance":
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "stopping_instance",
                    allowNonProcessing: true,
                });
                await setRunnerDesiredCapacity(options.autoscaling, {
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
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    capacity: 0,
                });
            case "find_ready_instance": {
                const instanceId = await findReadyRunnerInstance(options.ec2, options.ssm, {
                    autoScalingGroupName: options.config.autoScalingGroupName,
                });
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "waiting_for_instance",
                    instanceId,
                });
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    instance_id: instanceId,
                });
            }
            case "dispatch_tee_command": {
                assertValidUsgsSourceEventId(event.source_event_id);
                const dispatchTimestampMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "dispatching_command",
                    instanceId: event.instance_id,
                    nowMs: dispatchTimestampMs,
                });
                const dispatched = await dispatchRunnerCommand(options.ssm, {
                    workflowId: event.source_event_id,
                    instanceId: event.instance_id,
                    dispatchTimestampMs,
                    buildShellCommand: (resultS3Key) =>
                        buildSsmShellCommand({
                            sourceEventId: event.source_event_id,
                            dispatchTimestampMs,
                            resultBucket: options.config.resultBucket,
                            resultS3Key,
                            nitroEnclaveProcessCommand: options.config.nitroEnclaveProcessCommand,
                        }),
                });
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "dispatching_command",
                    instanceId: event.instance_id,
                    commandId: dispatched.commandId,
                    resultS3Key: dispatched.resultS3Key,
                    nowMs: dispatchTimestampMs,
                });
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: dispatched.commandId,
                    result_s3_key: dispatched.resultS3Key,
                    command_poll_count: dispatched.commandPollCount,
                });
            }
            case "dispatch_health_check_command": {
                assertValidUsgsSourceEventId(event.source_event_id);
                const dispatchTimestampMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "health_checking",
                    instanceId: event.instance_id,
                    nowMs: dispatchTimestampMs,
                });
                const dispatched = await dispatchRunnerCommand(options.ssm, {
                    workflowId: event.source_event_id,
                    instanceId: event.instance_id,
                    dispatchTimestampMs,
                    buildShellCommand: (resultS3Key) =>
                        buildSsmShellCommand({
                            sourceEventId: event.source_event_id,
                            dispatchTimestampMs,
                            resultBucket: options.config.resultBucket,
                            resultS3Key,
                            nitroEnclaveProcessCommand: options.config.nitroEnclaveProcessCommand,
                            teeInput: { action: "health_check" },
                        }),
                });
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "health_checking",
                    instanceId: event.instance_id,
                    commandId: dispatched.commandId,
                    resultS3Key: dispatched.resultS3Key,
                    nowMs: dispatchTimestampMs,
                });
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: dispatched.commandId,
                    result_s3_key: dispatched.resultS3Key,
                    command_poll_count: dispatched.commandPollCount,
                });
            }
            case "dispatch_get_attestation_command": {
                assertValidUsgsSourceEventId(event.source_event_id);
                const dispatchTimestampMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "getting_attestation",
                    instanceId: event.instance_id,
                    nowMs: dispatchTimestampMs,
                });
                const dispatched = await dispatchRunnerCommand(options.ssm, {
                    workflowId: event.source_event_id,
                    instanceId: event.instance_id,
                    dispatchTimestampMs,
                    buildShellCommand: (resultS3Key) =>
                        buildSsmShellCommand({
                            sourceEventId: event.source_event_id,
                            dispatchTimestampMs,
                            resultBucket: options.config.resultBucket,
                            resultS3Key,
                            nitroEnclaveProcessCommand: options.config.nitroEnclaveProcessCommand,
                            teeInput: { action: "get_attestation" },
                        }),
                });
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "getting_attestation",
                    instanceId: event.instance_id,
                    commandId: dispatched.commandId,
                    resultS3Key: dispatched.resultS3Key,
                    nowMs: dispatchTimestampMs,
                });
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: dispatched.commandId,
                    result_s3_key: dispatched.resultS3Key,
                    command_poll_count: dispatched.commandPollCount,
                });
            }
            case "register_enclave_instance": {
                const registrar = options.enclaveRegistration;
                if (registrar === undefined) {
                    throw new Error("enclave registration is not configured");
                }
                const attestation = readEnclaveAttestation(event.attestation);
                const nowMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "registering_enclave",
                    nowMs,
                });
                const registered = requireRegistrationMetadata(
                    await registrar.register({
                        sourceEventId: event.source_event_id,
                        attestationDocumentHex: attestation.attestation_document_hex,
                        publicKey: attestation.public_key,
                    }),
                    EARTHQUAKE_VERIFIER_CONFIG_KEY,
                );
                if (
                    normalizeHex(registered.enclave_instance_public_key) !==
                    normalizeHex(attestation.public_key)
                ) {
                    throw new Error("registration metadata public key does not match attestation");
                }
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    registration_metadata: registered,
                });
            }
            case "dispatch_process_data_command": {
                assertValidUsgsSourceEventId(event.source_event_id);
                const registrationMetadata = requireRegistrationMetadata(
                    event.registration_metadata,
                    EARTHQUAKE_VERIFIER_CONFIG_KEY,
                );
                const dispatchTimestampMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "dispatching_command",
                    instanceId: event.instance_id,
                    nowMs: dispatchTimestampMs,
                });
                const dispatched = await dispatchRunnerCommand(options.ssm, {
                    workflowId: event.source_event_id,
                    instanceId: event.instance_id,
                    dispatchTimestampMs,
                    buildShellCommand: (resultS3Key) =>
                        buildSsmShellCommand({
                            sourceEventId: event.source_event_id,
                            dispatchTimestampMs,
                            resultBucket: options.config.resultBucket,
                            resultS3Key,
                            nitroEnclaveProcessCommand: options.config.nitroEnclaveProcessCommand,
                            registrationMetadata,
                        }),
                });
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "dispatching_command",
                    instanceId: event.instance_id,
                    commandId: dispatched.commandId,
                    resultS3Key: dispatched.resultS3Key,
                    nowMs: dispatchTimestampMs,
                });
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: dispatched.commandId,
                    result_s3_key: dispatched.resultS3Key,
                    command_poll_count: dispatched.commandPollCount,
                });
            }
            case "read_health_check_result": {
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "health_checking",
                    resultS3Key: event.result_s3_key,
                });
                const text = await readRunnerResultText(options.s3, {
                    bucket: options.config.resultBucket,
                    key: event.result_s3_key,
                });
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    health_check: readEnclaveHealthCheck(JSON.parse(text) as unknown),
                });
            }
            case "read_attestation_result": {
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "getting_attestation",
                    resultS3Key: event.result_s3_key,
                });
                const text = await readRunnerResultText(options.s3, {
                    bucket: options.config.resultBucket,
                    key: event.result_s3_key,
                });
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    attestation: readEnclaveAttestation(JSON.parse(text) as unknown),
                });
            }
            case "poll_command": {
                const pollTimestampMs = options.now?.() ?? Date.now();
                const polled = await pollRunnerCommand(options.ssm, {
                    instanceId: event.instance_id,
                    commandId: event.command_id,
                    commandPollCount: event.command_poll_count,
                });
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "polling_command",
                    instanceId: event.instance_id,
                    commandId: event.command_id,
                    resultS3Key: event.result_s3_key,
                    lastPollAtMs: pollTimestampMs,
                    nowMs: pollTimestampMs,
                });
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    command_id: event.command_id,
                    result_s3_key: event.result_s3_key,
                    command_poll_count: polled.commandPollCount,
                    command_status: polled.commandStatus,
                });
            }
            case "read_result": {
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "reading_result",
                    resultS3Key: event.result_s3_key,
                });
                const text = await readRunnerResultText(options.s3, {
                    bucket: options.config.resultBucket,
                    key: event.result_s3_key,
                });
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    result: parseTeeResult(text, event.source_event_id),
                });
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
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    applied: true,
                    result: event.result,
                });
            }
            case "archive_sources": {
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                if (event.result.status !== "finalized") {
                    await requireCurrentWorkflowAttempt(options, event, {
                        phase: "complete",
                        allowNonProcessing: true,
                        nowMs,
                    });
                    const marked = await repository.markSourceArchiveResult(
                        event.source_event_id,
                        { status: "skipped", artifactS3Keys: [] },
                        nowMs,
                        event.attempt,
                    );
                    if (!marked) {
                        throw new Error("stale runner workflow attempt");
                    }
                    return retainVerifierKind({
                        source_event_id: event.source_event_id,
                        attempt: event.attempt,
                        source_archive: "skipped",
                        source_artifact_s3_keys: [],
                        result: event.result,
                    });
                }
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "archiving_sources",
                    allowNonProcessing: true,
                    nowMs,
                });
                const archive = options.sourceArchive ?? buildSourceArchiveFromConfig(options);
                const archived = await archiveFinalizedSources({
                    sourceEventId: event.source_event_id,
                    attempt: event.attempt,
                    resultBucket: options.config.resultBucket,
                    result: event.result,
                    archive,
                });
                const stateUpdate =
                    archived.status === "success"
                        ? { status: "success" as const, artifactS3Keys: archived.artifactS3Keys }
                        : sourceArchiveFailureStateUpdate(archived, nowMs);
                const marked = await repository.markSourceArchiveResult(
                    event.source_event_id,
                    stateUpdate,
                    nowMs,
                    event.attempt,
                );
                if (!marked) {
                    throw new Error("stale runner workflow attempt");
                }
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    source_archive: archived.status,
                    source_artifact_s3_keys: archived.artifactS3Keys,
                    result: event.result,
                });
            }
            case "relayer_preview_or_dry_run": {
                const repository = requireRepository(options);
                const relayer = options.relayer ?? buildRelayerFromConfig(options.config);
                if (relayer === undefined || event.result.status !== "finalized") {
                    return retainVerifierKind({
                        source_event_id: event.source_event_id,
                        attempt: event.attempt,
                        relayer: "skipped",
                        result: event.result,
                    });
                }
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "complete",
                    allowNonProcessing: true,
                });
                const row = await repository.get(event.source_event_id);
                if (row?.source_archive_status !== "success") {
                    return retainVerifierKind({
                        source_event_id: event.source_event_id,
                        attempt: event.attempt,
                        relayer: "skipped",
                        result: event.result,
                    });
                }
                const nowMs = options.now?.() ?? Date.now();
                const result = await relayer.relay(event.result);
                if (result.ok) {
                    return retainVerifierKind({
                        source_event_id: event.source_event_id,
                        attempt: event.attempt,
                        relayer: "succeeded",
                        result: event.result,
                        relayer_success: compactRelayerSuccess(result.value),
                    });
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
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    relayer: "failed",
                    result: event.result,
                });
            }
            case "record_relayer_success": {
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "complete",
                    nowMs,
                    allowNonProcessing: true,
                });
                const marked = await repository.markRelayerSucceeded(
                    event.source_event_id,
                    buildRelayerSuccessForRecord(event.relayer_success, event.result),
                    nowMs,
                    event.attempt,
                );
                if (!marked) {
                    throw new Error("stale runner workflow attempt");
                }
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    relayer: "recorded",
                    result: event.result,
                });
            }
            case "mark_failed": {
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "complete",
                    nowMs,
                    allowNonProcessing: true,
                });
                const errorCode = readRunnerFailureErrorCode(event.error_code);
                const marked = await repository.markFailed(
                    event.source_event_id,
                    errorCode,
                    nowMs,
                    nowMs + FAILED_RETRY_BACKOFF_MS,
                    event.message ?? event.error_code ?? "runner workflow failed",
                    event.attempt,
                );
                if (!marked) {
                    throw new Error("stale runner workflow attempt");
                }
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
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

    async putObjectBytes(input: { bucket: string; key: string; bytes: Uint8Array }): Promise<void> {
        await this.client.send(
            new PutObjectCommand({
                Bucket: input.bucket,
                Key: input.key,
                Body: input.bytes,
                ContentType: "application/octet-stream",
            }),
        );
    }
}

class FetchSourceFetcher implements SourceFetcherLike {
    async fetchBytes(entry: RawDataEntry): Promise<Uint8Array> {
        assertAllowedSourceUri(entry);
        const response = await fetchWithTimeout(
            entry.source_uri,
            {},
            SOURCE_FETCH_TIMEOUT_MS,
            `source re-fetch timed out for ${entry.source_uri}`,
        );
        if (!response.ok) {
            throw new RetryableSourceArchiveError(
                `source re-fetch failed for ${entry.source_uri}: HTTP ${response.status}`,
            );
        }
        return readResponseBytesWithLimit(response, entry.size_bytes, entry.source_uri);
    }
}

export class HttpWalrusSourceArchiver implements WalrusSourceArchiverLike {
    constructor(
        private readonly endpoint: string,
        private readonly auth?: {
            secretArn: string;
            secretReader: RelayerSignerSecretReader;
        },
    ) {}

    async archiveAndVerify(input: {
        entry: RawDataEntry;
        artifactS3Key: string;
    }): Promise<{ walrusBlobId: string }> {
        const response = await fetchWithTimeout(
            this.endpoint,
            {
                method: "POST",
                headers: await this.headers(),
                body: JSON.stringify({
                    artifact_s3_key: input.artifactS3Key,
                    expected_walrus_blob_id: input.entry.walrus_blob_id,
                    source_hash: input.entry.source_hash,
                    size_bytes: input.entry.size_bytes,
                }),
            },
            SOURCE_ARCHIVER_HTTP_TIMEOUT_MS,
            "Walrus source archiver request timed out",
        );
        if (!response.ok) {
            const message = `Walrus source archiver failed: HTTP ${response.status}`;
            if ((await readSourceArchiverErrorKind(response)) === "configuration") {
                throw new ConfigurationSourceArchiveError(message);
            }
            if (response.status === 409 || response.status === 422) {
                throw new IntegritySourceArchiveError(message);
            }
            throw new RetryableSourceArchiveError(message);
        }
        const body = (await response.json()) as unknown;
        if (!isRecord(body) || typeof body.walrus_blob_id !== "string") {
            throw new RetryableSourceArchiveError("Walrus source archiver returned invalid JSON");
        }
        return { walrusBlobId: body.walrus_blob_id };
    }

    private async headers(): Promise<Record<string, string>> {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (this.auth === undefined) {
            return headers;
        }
        headers["x-sonari-source-archiver-token"] = await this.token();
        return headers;
    }

    private async token(): Promise<string> {
        if (this.auth === undefined) {
            throw new RetryableSourceArchiveError("source archiver auth is not configured");
        }
        const token = (await this.auth.secretReader.getSecretString(this.auth.secretArn)).trim();
        if (token.length === 0) {
            throw new RetryableSourceArchiveError(
                `${this.auth.secretArn} did not contain SecretString`,
            );
        }
        return token;
    }
}

async function readSourceArchiverErrorKind(
    response: Response,
): Promise<"configuration" | "integrity" | "retryable" | undefined> {
    try {
        const body = (await response.json()) as unknown;
        if (!isRecord(body)) {
            return undefined;
        }
        return body.error === "configuration" ||
            body.error === "integrity" ||
            body.error === "retryable"
            ? body.error
            : undefined;
    } catch {
        return undefined;
    }
}

class UnconfiguredWalrusSourceArchiver implements WalrusSourceArchiverLike {
    async archiveAndVerify(): Promise<{ walrusBlobId: string }> {
        throw new RetryableSourceArchiveError("Walrus source archiver is not configured");
    }
}

async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    timeoutMessage: string,
): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
        if (isAbortError(error)) {
            throw new RetryableSourceArchiveError(timeoutMessage);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function readResponseBytesWithLimit(
    response: Response,
    expectedSizeBytes: number,
    sourceUri: string,
): Promise<Uint8Array> {
    if (response.body === null) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > expectedSizeBytes) {
            throw new IntegritySourceArchiveError(
                `source size exceeded signed size for ${sourceUri}`,
            );
        }
        return bytes;
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for await (const chunk of response.body) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        totalBytes += bytes.byteLength;
        if (totalBytes > expectedSizeBytes) {
            throw new IntegritySourceArchiveError(
                `source size exceeded signed size for ${sourceUri}`,
            );
        }
        chunks.push(bytes);
    }
    return concatBytes(chunks, totalBytes);
}

function concatBytes(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
    const output = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function assertAllowedSourceUri(entry: RawDataEntry): void {
    if (entry.name !== "USGS") {
        throw new IntegritySourceArchiveError("source archive entry is not a USGS source");
    }
    let url: URL;
    try {
        url = new URL(entry.source_uri);
    } catch {
        throw new IntegritySourceArchiveError(`source URI is not a valid URL for ${entry.product}`);
    }
    if (
        url.protocol !== "https:" ||
        url.hostname !== "earthquake.usgs.gov" ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== ""
    ) {
        throw new IntegritySourceArchiveError(`source URI is outside allowed USGS HTTPS scope`);
    }
    if (entry.product === "detail_geojson" && isAllowedUsgsDetailUri(url, entry.event_id)) {
        return;
    }
    if (entry.product === "shakemap_grid_xml" && isAllowedUsgsShakemapGridUri(url)) {
        return;
    }
    throw new IntegritySourceArchiveError(`source URI is not allowed for ${entry.product}`);
}

function isAllowedUsgsDetailUri(url: URL, eventId: string): boolean {
    if (url.pathname === `/earthquakes/feed/v1.0/detail/${eventId}.geojson` && url.search === "") {
        return true;
    }
    if (url.pathname !== "/fdsnws/event/1/query") {
        return false;
    }
    const keys = [...url.searchParams.keys()];
    return (
        keys.length === 2 &&
        keys.includes("eventid") &&
        keys.includes("format") &&
        url.searchParams.get("eventid") === eventId &&
        url.searchParams.get("format") === "geojson"
    );
}

function isAllowedUsgsShakemapGridUri(url: URL): boolean {
    if (url.search !== "") {
        return false;
    }
    const parts = url.pathname.split("/");
    const [empty, productPrefix, productType, code, source, version, download, file] = parts;
    return (
        parts.length === 8 &&
        empty === "" &&
        productPrefix === "product" &&
        productType === "shakemap" &&
        code !== undefined &&
        code.length > 0 &&
        source !== undefined &&
        source.length > 0 &&
        version !== undefined &&
        version.length > 0 &&
        download === "download" &&
        (file === "grid.xml" || file === "grid.xml.zip")
    );
}

class AwsRelayerSignerSecretReader implements RelayerSignerSecretReader {
    private readonly client = new SecretsManagerClient({});

    async getSecretString(secretArn: string): Promise<string> {
        const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretArn }));
        const secret = result.SecretString?.trim();
        if (secret === undefined || secret.length === 0) {
            throw new Error(`${secretArn} did not contain SecretString`);
        }
        return secret;
    }
}

export class SuiEnclaveRegistrationAdapter implements EnclaveRegistrationAdapter {
    constructor(private readonly config: EnclaveRegistrationConfig) {}

    async register(input: {
        sourceEventId: string;
        attestationDocumentHex: string;
        publicKey: string;
    }): Promise<EnclaveVerificationMetadata> {
        assertValidUsgsSourceEventId(input.sourceEventId);
        if (this.config.configurationError !== undefined) {
            throw new Error(this.config.configurationError);
        }
        if (!this.config.allowSubmit) {
            throw new Error(
                "ENCLAVE_REGISTRATION_ALLOW_SUBMIT or RELAYER_ALLOW_SUBMIT must be true",
            );
        }
        const network = this.config.network;
        if (network === undefined) {
            throw new Error("RELAYER_NETWORK is required for enclave registration");
        }
        const grpcUrl = this.config.grpcUrl;
        if (!isNonEmptyString(grpcUrl)) {
            throw new Error("RELAYER_GRPC_URL is required for enclave registration");
        }
        validateSuiNetworkGrpcUrl(network, grpcUrl, "RELAYER_GRPC_URL");

        const signer = this.config.signer ?? (await this.config.loadSigner?.());
        if (signer === undefined) {
            throw new Error("RELAYER_SIGNER_SECRET_ARN is required for enclave registration");
        }
        const senderAddress = signer.toSuiAddress();
        if (!isNonEmptyString(senderAddress)) {
            throw new Error("enclave registration signer did not provide a sender address");
        }
        if (!isHexBytes(input.attestationDocumentHex)) {
            throw new Error("attestation_document_hex must be hex encoded");
        }
        if (!isHexBytes(input.publicKey, 32)) {
            throw new Error("attestation public_key must be 32 bytes");
        }
        if (!Number.isSafeInteger(this.config.instanceTtlMs) || this.config.instanceTtlMs <= 0) {
            throw new Error("ENCLAVE_INSTANCE_TTL_MS must be a positive safe integer");
        }

        const nowMs = this.config.now?.() ?? Date.now();
        const expiresAtMs = nowMs + this.config.instanceTtlMs;
        if (!Number.isSafeInteger(expiresAtMs)) {
            throw new Error("enclave instance expiry exceeded safe integer range");
        }

        const client =
            this.config.client ??
            (new SuiGrpcClient({
                network,
                baseUrl: grpcUrl,
            }) as unknown as EnclaveRegistrationClient);
        const transaction =
            this.config.transaction ??
            createSuiEnclaveRegistrationTransaction({
                target: this.config.target,
                verifierRegistry: this.config.verifierRegistry,
                attestationDocumentBytes: parseHexByteVector(input.attestationDocumentHex),
                expiresAtMs,
                senderAddress,
            });
        const response = await client.signAndExecuteTransaction({
            transaction,
            signer,
            include: { effects: true, events: true },
        });
        const events = readSuccessfulEnclaveRegistrationEvents(response);
        const metadata = readEnclaveRegistrationMetadata(events, {
            expectedFamily: 3,
            expectedVersion: 1,
            configKey: EARTHQUAKE_VERIFIER_CONFIG_KEY,
        });
        if (normalizeHex(metadata.enclave_instance_public_key) !== normalizeHex(input.publicKey)) {
            throw new Error("registered enclave public key does not match attestation");
        }
        return metadata;
    }
}

export async function handler(event: RunnerControlEvent): Promise<RunnerControlResult> {
    parseExpectedVerifierKind(
        (event as { verifier_kind?: unknown }).verifier_kind,
        EARTHQUAKE_VERIFIER_KIND,
    );
    const config: RunnerWorkflowConfig = {
        autoScalingGroupName: requiredEnv("RUNNER_ASG_NAME"),
        resultBucket: requiredEnv("RESULT_BUCKET"),
        nitroEnclaveProcessCommand: requiredEnv("NITRO_ENCLAVE_PROCESS_COMMAND"),
    };
    if (event.action === "relayer_preview_or_dry_run") {
        const relayer = readRelayerConfigFromEnv(new AwsRelayerSignerSecretReader());
        if (relayer !== undefined) {
            config.relayer = relayer;
        }
    }
    const enclaveRegistration =
        event.action === "register_enclave_instance"
            ? new SuiEnclaveRegistrationAdapter(
                  readEnclaveRegistrationConfigFromEnv(new AwsRelayerSignerSecretReader()),
              )
            : undefined;
    return createRunnerControlHandler({
        autoscaling: new AwsAutoScalingClient(),
        ec2: new AwsEc2Client(),
        ssm: new AwsSsmClient(),
        s3: new AwsS3Client(),
        repository: new DynamoDbStateRepository(requiredEnv("EVENTS_TABLE_NAME")),
        ...(enclaveRegistration === undefined ? {} : { enclaveRegistration }),
        config,
    })(event);
}

function buildSsmShellCommand(input: {
    sourceEventId: string;
    dispatchTimestampMs: number;
    resultBucket: string;
    resultS3Key: string;
    nitroEnclaveProcessCommand: string;
    registrationMetadata?: EnclaveVerificationMetadata | undefined;
    teeInput?: unknown;
}): string {
    const tempResultPath = `/tmp/sonari-tee-result-${input.sourceEventId}-${input.dispatchTimestampMs}.json`;
    const commandInvocation = parseNitroEnclaveProcessCommand(input.nitroEnclaveProcessCommand)
        .map(shellSingleQuote)
        .join(" ");
    const teeInput =
        input.teeInput ??
        (input.registrationMetadata === undefined
            ? buildEarthquakeVerifierRequest(input.sourceEventId)
            : {
                  action: "process_data",
                  payload: buildEarthquakeVerifierRequest(input.sourceEventId),
                  registration_metadata: input.registrationMetadata,
              });
    return [
        "set -euo pipefail",
        "source /opt/sonari/runner.env",
        buildRequiredShellEnvCheck("SONARI_WALRUS_CLI"),
        buildRequiredShellEnvCheck("SONARI_WALRUS_N_SHARDS"),
        buildRequiredShellEnvCheck("SONARI_EARTHQUAKE_EGRESS_PROXY_URL"),
        "export SONARI_WALRUS_CLI SONARI_WALRUS_N_SHARDS SONARI_EARTHQUAKE_EGRESS_PROXY_URL",
        `RESULT_S3_KEY=${shellSingleQuote(input.resultS3Key)}`,
        `NITRO_ENCLAVE_PROCESS_COMMAND=${shellSingleQuote(input.nitroEnclaveProcessCommand)}`,
        "export NITRO_ENCLAVE_PROCESS_COMMAND",
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
        buildRequiredShellEnvCheck("RUNNER_TOKEN_FILE"),
        buildRequiredShellEnvCheck("SONARI_WALRUS_CLI"),
        buildRequiredShellEnvCheck("SONARI_WALRUS_N_SHARDS"),
        buildRequiredShellEnvCheck("SONARI_EARTHQUAKE_EGRESS_PROXY_URL"),
        'test -s "$RUNNER_TOKEN_FILE"',
        'test -x "$SONARI_WALRUS_CLI"',
        "systemctl is-active --quiet nitro-enclaves-allocator.service",
        "systemctl is-active --quiet sonari-earthquake-egress-connect-proxy.service",
        "systemctl is-active --quiet sonari-earthquake-egress-vsock-proxy.service",
    ].join("\n");
}

function buildSourceArchiveFromConfig(options: RunnerControlHandlerOptions): SourceArchiveAdapter {
    if (options.s3.putObjectBytes === undefined) {
        throw new Error("source archive requires S3 byte staging support");
    }
    const sourceArchiverUrl = process.env.SOURCE_ARCHIVER_URL;
    const sourceArchiverTokenSecretArn = process.env.SOURCE_ARCHIVER_TOKEN_SECRET_ARN;
    if (
        sourceArchiverUrl !== undefined &&
        sourceArchiverUrl.length > 0 &&
        (sourceArchiverTokenSecretArn === undefined || sourceArchiverTokenSecretArn.length === 0)
    ) {
        throw new Error("SOURCE_ARCHIVER_TOKEN_SECRET_ARN is required with SOURCE_ARCHIVER_URL");
    }
    const sourceArchiverAuth =
        sourceArchiverTokenSecretArn === undefined || sourceArchiverTokenSecretArn.length === 0
            ? undefined
            : {
                  secretArn: sourceArchiverTokenSecretArn,
                  secretReader: new AwsRelayerSignerSecretReader(),
              };
    return {
        fetcher: new FetchSourceFetcher(),
        s3: { putObjectBytes: options.s3.putObjectBytes.bind(options.s3) },
        walrus:
            sourceArchiverUrl === undefined || sourceArchiverUrl.length === 0
                ? new UnconfiguredWalrusSourceArchiver()
                : new HttpWalrusSourceArchiver(sourceArchiverUrl, sourceArchiverAuth),
    };
}

type SourceArchiveAttemptResult =
    | { status: "success"; artifactS3Keys: string[] }
    | {
          status: "configuration_failed" | "retryable_failed" | "integrity_failed";
          artifactS3Keys: string[];
          message: string;
      };

function sourceArchiveFailureStateUpdate(
    archived: Extract<SourceArchiveAttemptResult, { message: string }>,
    nowMs: number,
): SourceArchiveStateUpdate {
    if (archived.status === "retryable_failed") {
        return {
            status: "retryable_failed",
            artifactS3Keys: archived.artifactS3Keys,
            errorCode: "SOURCE_ARCHIVE_RETRYABLE_FAILED",
            retryableNextRetryAtMs: nowMs + SOURCE_ARCHIVE_RETRY_BACKOFF_MS,
            message: archived.message,
        };
    }
    if (archived.status === "configuration_failed") {
        return {
            status: "configuration_failed",
            artifactS3Keys: archived.artifactS3Keys,
            errorCode: "SOURCE_ARCHIVE_CONFIGURATION_FAILED",
            message: archived.message,
        };
    }
    return {
        status: "integrity_failed",
        artifactS3Keys: archived.artifactS3Keys,
        errorCode: "SOURCE_ARCHIVE_INTEGRITY_FAILED",
        message: archived.message,
    };
}

async function archiveFinalizedSources(input: {
    sourceEventId: string;
    attempt: number | undefined;
    resultBucket: string;
    result: Extract<TeeCoreResult, { status: "finalized" }>;
    archive: SourceArchiveAdapter;
}): Promise<SourceArchiveAttemptResult> {
    const validation = validateRelayerSubmitInput(input.result);
    if (!validation.ok) {
        return { status: "integrity_failed", artifactS3Keys: [], message: validation.message };
    }
    const manifest = validation.value.raw_data_manifest;
    if (manifest === undefined) {
        return {
            status: "integrity_failed",
            artifactS3Keys: [],
            message: "finalized result is missing raw_data_manifest",
        };
    }
    const payload = validation.value.payload as EarthquakeOraclePayload;
    const manifestHash = rawDataManifestHash(manifest);
    if (manifestHash !== payload.raw_data_hash) {
        return {
            status: "integrity_failed",
            artifactS3Keys: [],
            message: "raw_data_manifest does not match signed raw_data_hash",
        };
    }
    const artifactS3Keys: string[] = [];
    for (const [index, entry] of manifest.entries.entries()) {
        try {
            const bytes = await input.archive.fetcher.fetchBytes(entry);
            verifySourceBytes(entry, bytes);
            const key = sourceArtifactS3Key({
                sourceEventId: input.sourceEventId,
                attempt: input.attempt,
                index,
                product: entry.product,
                sourceHash: entry.source_hash,
            });
            await input.archive.s3.putObjectBytes({ bucket: input.resultBucket, key, bytes });
            artifactS3Keys.push(key);
            const archived = await input.archive.walrus.archiveAndVerify({
                entry,
                bytes,
                artifactS3Key: key,
            });
            if (archived.walrusBlobId !== entry.walrus_blob_id) {
                return {
                    status: "integrity_failed",
                    artifactS3Keys,
                    message: `Walrus blob id mismatch for ${entry.source_uri}`,
                };
            }
        } catch (error) {
            if (error instanceof IntegritySourceArchiveError) {
                return { status: "integrity_failed", artifactS3Keys, message: error.message };
            }
            if (error instanceof ConfigurationSourceArchiveError) {
                return {
                    status: "configuration_failed",
                    artifactS3Keys,
                    message: error.message,
                };
            }
            return {
                status: "retryable_failed",
                artifactS3Keys,
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }
    return { status: "success", artifactS3Keys };
}

function verifySourceBytes(entry: RawDataEntry, bytes: Uint8Array): void {
    const hash = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    if (hash !== entry.source_hash) {
        throw new IntegritySourceArchiveError(`source hash mismatch for ${entry.source_uri}`);
    }
    if (bytes.byteLength !== entry.size_bytes) {
        throw new IntegritySourceArchiveError(`source size mismatch for ${entry.source_uri}`);
    }
}

function rawDataManifestHash(manifest: RawDataManifest): string {
    return `0x${createHash("sha256").update(canonicalRawDataManifestJson(manifest)).digest("hex")}`;
}

function canonicalRawDataManifestJson(manifest: RawDataManifest): string {
    return JSON.stringify({
        entries: manifest.entries.map((entry) => ({
            name: entry.name,
            event_id: entry.event_id,
            product: entry.product,
            uri: entry.uri,
            content_hash: entry.content_hash,
            source_uri: entry.source_uri,
            walrus_blob_id: entry.walrus_blob_id,
            source_hash: entry.source_hash,
            size_bytes: entry.size_bytes,
        })),
        oracle_version: manifest.oracle_version,
    });
}

function sourceArtifactS3Key(input: {
    sourceEventId: string;
    attempt: number | undefined;
    index: number;
    product: string;
    sourceHash: string;
}): string {
    return [
        "source-artifacts",
        input.sourceEventId,
        String(input.attempt ?? 1),
        `${input.index}-${sanitizeS3KeySegment(input.product)}-${input.sourceHash.slice(2).toLowerCase()}.bin`,
    ].join("/");
}

function sanitizeS3KeySegment(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96);
}

export class RetryableSourceArchiveError extends Error {}
export class IntegritySourceArchiveError extends Error {}
export class ConfigurationSourceArchiveError extends Error {}

function buildRequiredShellEnvCheck(name: string, message = `${name} is required`): string {
    return `: "\${${name}:?${message}}"`;
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

function readRunnerFailureErrorCode(errorCode: string | undefined): OracleErrorCode {
    if (errorCode === undefined) {
        return "AWS_RUNNER_PROCESS_FAILED";
    }
    if ((ERROR_CODES as readonly string[]).includes(errorCode)) {
        return errorCode as OracleErrorCode;
    }
    throw new Error(`invalid runner error_code: ${errorCode}`);
}

function parseTeeResult(text: string, expectedSourceEventId: string): TeeCoreResult {
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
        if (parsed.source_event_id !== expectedSourceEventId) {
            throw new Error("TEE result source_event_id mismatch");
        }
        if (!isValidNonFinalizedTeeErrorCode(parsed.status, parsed.error_code)) {
            throw new Error("invalid non-finalized TEE result error_code");
        }
        return parsed as TeeCoreResult;
    }
    throw new Error("invalid TEE result");
}

function isValidNonFinalizedTeeErrorCode(
    status: "pending_source" | "pending_mmi" | "rejected",
    errorCode: string,
): errorCode is OracleErrorCode {
    if (status === "pending_source") {
        return (
            errorCode === "USGS_DETAIL_UNAVAILABLE" ||
            errorCode === "SHAKEMAP_PRODUCT_MISSING" ||
            errorCode === "SHAKEMAP_GRID_UNAVAILABLE"
        );
    }
    if (status === "pending_mmi") {
        return errorCode === "MMI_NOT_AVAILABLE";
    }
    return (ERROR_CODES as readonly string[]).includes(errorCode);
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

function compactRelayerSuccess(success: RelayerSuccess): RelayerRecordSuccessInput {
    return {
        mode: success.mode,
        target: success.request.target,
        registry: success.request.registry,
        verifierRegistry: success.request.verifierRegistry,
        ...(success.digest === undefined ? {} : { digest: success.digest }),
        ...(success.objectId === undefined ? {} : { objectId: success.objectId }),
    };
}

function buildRelayerSuccessForRecord(
    success: RelayerRecordSuccessInput,
    result: TeeCoreResult,
): RelayerSuccess {
    const validation = validateRelayerSubmitInput(result);
    if (!validation.ok) {
        throw new Error(validation.message);
    }
    const request = buildRelayerRequestPreview(validation.value, {
        target: success.target,
        registry: success.registry,
        verifierRegistry: success.verifierRegistry,
    });
    if (!request.ok) {
        throw new Error(request.message);
    }
    return {
        mode: success.mode,
        request: request.value,
        ...(success.digest === undefined ? {} : { digest: success.digest }),
        ...(success.objectId === undefined ? {} : { objectId: success.objectId }),
    };
}

export function readRelayerConfigFromEnv(
    secretReader: RelayerSignerSecretReader,
): RunnerWorkflowConfig["relayer"] {
    const mode = process.env.RELAYER_MODE;
    if (mode === undefined || mode.length === 0) {
        return undefined;
    }
    if (mode !== "preview" && mode !== "dry_run" && mode !== "submit") {
        return {
            mode: "preview",
            target: "",
            registry: "",
            verifierRegistry: "",
            configurationError: `Unsupported RELAYER_MODE: ${mode}`,
        };
    }
    const missingCoreFields = [
        ["RELAYER_TARGET", process.env.RELAYER_TARGET],
        ["RELAYER_REGISTRY", process.env.RELAYER_REGISTRY],
        ["RELAYER_VERIFIER_REGISTRY", process.env.RELAYER_VERIFIER_REGISTRY],
    ]
        .filter(([, value]) => value === undefined || value.length === 0)
        .map(([name]) => name);
    const config: NonNullable<RunnerWorkflowConfig["relayer"]> = {
        mode,
        target: process.env.RELAYER_TARGET ?? "",
        registry: process.env.RELAYER_REGISTRY ?? "",
        verifierRegistry: process.env.RELAYER_VERIFIER_REGISTRY ?? "",
    };
    if (missingCoreFields.length > 0) {
        config.configurationError = `${missingCoreFields.join(", ")} required for RELAYER_MODE=${mode}`;
    }
    if (mode === "dry_run" || mode === "submit") {
        const network = readSuiNetwork(process.env.RELAYER_NETWORK);
        if (network === undefined) {
            config.configurationError = appendConfigurationError(
                config.configurationError,
                "RELAYER_NETWORK is required",
            );
        } else {
            config.network = network;
        }
    }
    if (process.env.RELAYER_GRPC_URL !== undefined) {
        config.grpcUrl = process.env.RELAYER_GRPC_URL;
    }
    if (process.env.RELAYER_SENDER_ADDRESS !== undefined) {
        config.senderAddress = process.env.RELAYER_SENDER_ADDRESS;
    }
    if (mode === "submit") {
        config.allowSubmit = process.env.RELAYER_ALLOW_SUBMIT === "true";
        const signerSecretArn = process.env.RELAYER_SIGNER_SECRET_ARN;
        if (signerSecretArn !== undefined && signerSecretArn.length > 0) {
            config.loadSigner = async () =>
                createEd25519SuiSignerFromPrivateKey(
                    await secretReader.getSecretString(signerSecretArn),
                );
        }
    }
    return config;
}

export function readEnclaveRegistrationConfigFromEnv(
    secretReader: RelayerSignerSecretReader,
): EnclaveRegistrationConfig {
    const target =
        process.env.ENCLAVE_REGISTRATION_TARGET ??
        deriveEnclaveRegistrationTarget(process.env.RELAYER_TARGET) ??
        "";
    const verifierRegistry = process.env.RELAYER_VERIFIER_REGISTRY ?? "";
    const network = readSuiNetwork(process.env.RELAYER_NETWORK);
    const grpcUrl = process.env.RELAYER_GRPC_URL;
    const signerSecretArn = process.env.RELAYER_SIGNER_SECRET_ARN;
    const missing = [
        ["ENCLAVE_REGISTRATION_TARGET or RELAYER_TARGET", target],
        ["RELAYER_VERIFIER_REGISTRY", verifierRegistry],
        ["RELAYER_NETWORK", process.env.RELAYER_NETWORK],
        ["RELAYER_GRPC_URL", grpcUrl],
        ["RELAYER_SIGNER_SECRET_ARN", signerSecretArn],
    ]
        .filter(([, value]) => value === undefined || value.length === 0)
        .map(([name]) => name);
    let configurationError =
        missing.length === 0
            ? undefined
            : `${missing.join(", ")} required for enclave registration`;
    if (process.env.RELAYER_NETWORK !== undefined && network === undefined) {
        configurationError = appendConfigurationError(
            configurationError,
            "RELAYER_NETWORK is required for enclave registration",
        );
    }
    const instanceTtlMs = readPositiveIntegerEnv("ENCLAVE_INSTANCE_TTL_MS", 6 * HOUR_MS);
    if (instanceTtlMs === undefined) {
        configurationError = appendConfigurationError(
            configurationError,
            "ENCLAVE_INSTANCE_TTL_MS must be a positive safe integer",
        );
    }

    const config: EnclaveRegistrationConfig = {
        target,
        verifierRegistry,
        allowSubmit:
            process.env.ENCLAVE_REGISTRATION_ALLOW_SUBMIT === "true" ||
            process.env.RELAYER_ALLOW_SUBMIT === "true",
        instanceTtlMs: instanceTtlMs ?? 0,
    };
    if (network !== undefined) {
        config.network = network;
    }
    if (grpcUrl !== undefined) {
        config.grpcUrl = grpcUrl;
    }
    if (configurationError !== undefined) {
        config.configurationError = configurationError;
    }
    if (signerSecretArn !== undefined && signerSecretArn.length > 0) {
        config.loadSigner = async () =>
            createEd25519SuiSignerFromPrivateKey(
                await secretReader.getSecretString(signerSecretArn),
            );
    }
    return config;
}

function appendConfigurationError(existing: string | undefined, next: string): string {
    return existing === undefined ? next : `${existing}; ${next}`;
}

function readSuiNetwork(value: string | undefined): SuiNetwork | undefined {
    return value === "mainnet" || value === "testnet" || value === "devnet" ? value : undefined;
}

function deriveEnclaveRegistrationTarget(relayerTarget: string | undefined): string | undefined {
    if (relayerTarget === undefined || relayerTarget.length === 0) {
        return undefined;
    }
    const [packageId, moduleName, functionName] = relayerTarget.split("::");
    if (
        !isNonEmptyString(packageId) ||
        !isNonEmptyString(moduleName) ||
        !isNonEmptyString(functionName)
    ) {
        return undefined;
    }
    return `${packageId}::metadata_verifier::register_enclave_instance`;
}

function readPositiveIntegerEnv(name: string, fallback: number): number | undefined {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function validateSuiNetworkGrpcUrl(network: SuiNetwork, grpcUrl: string, fieldName: string): void {
    let url: URL;
    try {
        url = new URL(grpcUrl);
    } catch {
        throw new Error(`${fieldName} must be a valid URL`);
    }
    if (url.protocol !== "https:") {
        throw new Error(`${fieldName} must use https`);
    }
    if (url.username.length > 0 || url.password.length > 0) {
        throw new Error(`${fieldName} must not include credentials`);
    }
    const expectedHost = `fullnode.${network}.sui.io`;
    if (url.hostname !== expectedHost) {
        throw new Error(
            `${fieldName} host ${url.hostname} does not match RELAYER_NETWORK=${network}`,
        );
    }
}

function readSuccessfulEnclaveRegistrationEvents(
    response: EnclaveRegistrationExecutionResponse,
): EnclaveRegistrationEvent[] {
    if (!isRecord(response)) {
        throw new Error("Sui response was not an object");
    }
    if (response.$kind === "FailedTransaction") {
        const status = isRecord(response.FailedTransaction)
            ? readEnclaveExecutionStatus(response.FailedTransaction.status)
            : undefined;
        throw new Error(status?.errorMessage ?? "Move transaction failed");
    }
    if (response.$kind !== "Transaction" || !isRecord(response.Transaction)) {
        throw new Error("Sui response used an unknown transaction result shape");
    }
    const status = readEnclaveExecutionStatus(response.Transaction.status);
    if (status?.success === false) {
        throw new Error(status.errorMessage ?? "Move transaction reported failure");
    }
    if (status?.success !== true) {
        throw new Error("Sui response did not include transaction status");
    }
    if (!isRecord(response.Transaction.effects)) {
        throw new Error("Sui response did not include transaction effects");
    }
    return Array.isArray(response.Transaction.events)
        ? response.Transaction.events.filter(isRecord)
        : [];
}

function readEnclaveExecutionStatus(
    value: unknown,
):
    | { success: true; errorMessage?: undefined }
    | { success: false; errorMessage?: string }
    | undefined {
    if (!isRecord(value) || typeof value.success !== "boolean") {
        return undefined;
    }
    if (value.success) {
        return { success: true };
    }
    const errorMessage = readExecutionErrorMessage(value.error);
    return errorMessage === undefined ? { success: false } : { success: false, errorMessage };
}

function readExecutionErrorMessage(value: unknown): string | undefined {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    if (isRecord(value) && typeof value.message === "string" && value.message.length > 0) {
        return value.message;
    }
    return undefined;
}

function readEnclaveHealthCheck(input: unknown): EnclaveHealthCheckResult {
    if (
        !isRecord(input) ||
        input.status !== "healthy" ||
        input.external_sources_reachable !== true
    ) {
        throw new Error("enclave health_check failed");
    }
    return {
        status: "healthy",
        external_sources_reachable: true,
    };
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
