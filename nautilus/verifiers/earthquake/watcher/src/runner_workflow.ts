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
    type AffectedCellsArtifact,
    computeAffectedCellsRootHex,
    EARTHQUAKE_VERIFIER_CONFIG_KEY,
    type EarthquakeOraclePayload,
    type EnclaveVerificationMetadata,
    ERROR_CODES,
    type EvidenceManifest,
    type OracleErrorCode,
    type RawDataEntry,
    type RawDataManifest,
    type StoredSourceRef,
    type TeeCoreResult,
    validateRelayerSubmitInput,
} from "@sonari/earthquake-shared";
import {
    buildRunnerBootstrapReadinessShellCommand as buildSharedRunnerBootstrapReadinessShellCommand,
    buildRunnerSsmShellCommand as buildSharedRunnerSsmShellCommand,
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
import {
    type AffectedCellsProofRegistrationInput,
    type AffectedCellsProofRegistrationResult,
    ConfigurationAffectedCellsProofRegistrationError,
    HttpAffectedCellsProofRegistrar,
    IntegrityAffectedCellsProofRegistrationError,
    RetryableAffectedCellsProofRegistrationError,
} from "./affected_cells_proof_registrar.js";
import {
    type FloorCensusAdapter,
    type FloorCensusSubmitConfig,
    type FloorCensusTeeClient,
    GraphqlFloorCensusReader,
    TeeFloorCensusAdapter,
} from "./census.js";
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
    type AffectedCellsProofRegistrationStateUpdate,
    DynamoDbStateRepository,
    type SourceArchiveStateUpdate,
    type StateRepository,
} from "./state.js";

const SOURCE_ARCHIVE_RETRY_BACKOFF_MS = FAILED_RETRY_BACKOFF_MS;
const SOURCE_FETCH_TIMEOUT_MS = 30_000;
const SOURCE_ARCHIVER_HTTP_TIMEOUT_MS = 210_000;
const CENSUS_VERIFIER_CONFIG_KEY = 3;
const CENSUS_VERIFIER_FAMILY = 5;
const CENSUS_VERIFIER_KIND = "census";
const CENSUS_NITRO_ENCLAVE_PROCESS_COMMAND = "/opt/sonari/bin/run-census-enclave";
const CENSUS_RUNNER_COMMAND_MAX_POLLS = 60;
const CENSUS_RUNNER_COMMAND_POLL_INTERVAL_MS = 5_000;

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
        categoryRegistry: string;
        categoryPool: string;
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
    floorCensus?: FloorCensusSubmitConfig;
    censusNitroEnclaveProcessCommand?: string | undefined;
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

export interface AffectedCellsProofRegistrarAdapter {
    register(
        input: AffectedCellsProofRegistrationInput,
    ): Promise<AffectedCellsProofRegistrationResult>;
}

export interface RunnerFloorCensusAdapter extends FloorCensusAdapter {}

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
    configKey?: number | undefined;
    expectedFamily?: number | undefined;
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
    categoryRegistry: string;
    categoryPool: string;
    digest?: string;
    objectId?: string;
}

type RunnerControlVerifierKind = {
    verifier_kind?: typeof EARTHQUAKE_VERIFIER_KIND | undefined;
};

export type RunnerControlEvent = RunnerControlVerifierKind &
    (
        | {
              action: "start_instance";
              source_event_id: string;
              event_revision?: number | undefined;
              attempt?: number | undefined;
          }
        | {
              action: "find_ready_instance";
              source_event_id: string;
              event_revision?: number | undefined;
              attempt?: number | undefined;
          }
        | {
              action: "dispatch_tee_command";
              source_event_id: string;
              event_revision?: number | undefined;
              attempt?: number | undefined;
              instance_id: string;
          }
        | {
              action: "dispatch_health_check_command";
              source_event_id: string;
              event_revision?: number | undefined;
              attempt?: number | undefined;
              instance_id: string;
          }
        | {
              action: "dispatch_get_attestation_command";
              source_event_id: string;
              event_revision?: number | undefined;
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
              event_revision?: number | undefined;
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
              instance_id?: string | undefined;
              result_s3_key: string;
          }
        | {
              action: "apply_result";
              source_event_id: string;
              attempt?: number | undefined;
              instance_id?: string | undefined;
              result_s3_key: string;
          }
        | {
              action: "archive_sources";
              source_event_id: string;
              attempt?: number | undefined;
              instance_id?: string | undefined;
              result_s3_key: string;
          }
        | {
              action: "register_affected_cells_proof";
              source_event_id: string;
              attempt?: number | undefined;
              instance_id?: string | undefined;
              result_s3_key: string;
          }
        | {
              action: "restore_affected_cells_proof_registration_retry";
              source_event_id: string;
              attempt?: number | undefined;
              message?: string | undefined;
          }
        | {
              action: "relayer_preview_or_dry_run";
              source_event_id: string;
              attempt?: number | undefined;
              instance_id?: string | undefined;
              result_s3_key: string;
          }
        | {
              action: "record_relayer_success";
              source_event_id: string;
              attempt?: number | undefined;
              instance_id?: string | undefined;
              result_s3_key: string;
              relayer_success: RelayerRecordSuccessInput;
          }
        | {
              action: "run_floor_census";
              source_event_id: string;
              attempt?: number | undefined;
              instance_id?: string | undefined;
              result_s3_key: string;
              relayer_success: RelayerRecordSuccessInput;
          }
        | {
              action: "mark_failed";
              source_event_id: string;
              attempt?: number | undefined;
              error_code?: string;
              message?: string;
          }
        | {
              action: "stop_instance";
              source_event_id: string;
              event_revision?: number | undefined;
              attempt?: number | undefined;
          }
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
        | {
              source_event_id: string;
              attempt?: number | undefined;
              result_s3_key: string;
              result_status: TeeCoreResult["status"];
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              applied: true;
              result_s3_key: string;
              result_status: TeeCoreResult["status"];
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              instance_id?: string | undefined;
              relayer: "skipped" | "failed";
              result_s3_key: string;
              result_status: TeeCoreResult["status"];
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
              result_s3_key: string;
              result_status: TeeCoreResult["status"];
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              affected_cells_proof_registration:
                  | "skipped"
                  | "success"
                  | "configuration_failed"
                  | "retryable_failed"
                  | "integrity_failed";
              result_s3_key: string;
              result_status: TeeCoreResult["status"];
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              affected_cells_proof_registration: "retry_restored";
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              instance_id?: string | undefined;
              relayer: "succeeded";
              result_s3_key: string;
              result_status: TeeCoreResult["status"];
              relayer_success: RelayerRecordSuccessInput;
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              relayer: "recorded";
              instance_id?: string | undefined;
              result_s3_key: string;
              result_status: TeeCoreResult["status"];
              relayer_success: RelayerRecordSuccessInput;
          }
        | {
              source_event_id: string;
              attempt?: number | undefined;
              floor_census: "skipped" | "succeeded";
              result_s3_key: string;
              result_status: TeeCoreResult["status"];
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
    affectedCellsProofRegistrar?: AffectedCellsProofRegistrarAdapter;
    floorCensus?: RunnerFloorCensusAdapter;
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
        const retainVerifierKind = (output: RunnerControlResult): RunnerControlResult => {
            const eventRevision = (event as { event_revision?: unknown }).event_revision;
            return withVerifierKind(verifierKind, {
                ...output,
                ...(typeof eventRevision === "number" ? { event_revision: eventRevision } : {}),
            }) as RunnerControlResult;
        };
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
                            eventRevision: event.event_revision ?? 1,
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
                            eventRevision: event.event_revision ?? 1,
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
                            eventRevision: event.event_revision ?? 1,
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
                            eventRevision: event.event_revision ?? 1,
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
                const result = await readTeeResultFromS3(options, event);
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    ...(event.instance_id === undefined ? {} : { instance_id: event.instance_id }),
                    result_s3_key: event.result_s3_key,
                    result_status: result.status,
                });
            }
            case "apply_result": {
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "applying_result",
                    resultS3Key: event.result_s3_key,
                    nowMs,
                });
                const result = await readTeeResultFromS3(options, event);
                const applied = await repository.applyRunnerResult(
                    event.source_event_id,
                    result,
                    nowMs,
                    isPendingTeeResult(result) ? nowMs + HOUR_MS : undefined,
                    event.attempt,
                );
                if (!applied) {
                    throw new Error("stale runner workflow attempt");
                }
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    ...(event.instance_id === undefined ? {} : { instance_id: event.instance_id }),
                    applied: true,
                    result_s3_key: event.result_s3_key,
                    result_status: result.status,
                });
            }
            case "archive_sources": {
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                const result = await readTeeResultFromS3(options, event);
                if (result.status !== "finalized") {
                    await requireCurrentWorkflowAttempt(options, event, {
                        phase: "complete",
                        allowNonProcessing: true,
                        resultS3Key: event.result_s3_key,
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
                        ...(event.instance_id === undefined
                            ? {}
                            : { instance_id: event.instance_id }),
                        source_archive: "skipped",
                        source_artifact_s3_keys: [],
                        result_s3_key: event.result_s3_key,
                        result_status: result.status,
                    });
                }
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "archiving_sources",
                    allowNonProcessing: true,
                    resultS3Key: event.result_s3_key,
                    nowMs,
                });
                const archive = options.sourceArchive ?? buildSourceArchiveFromConfig(options);
                const archived = await archiveFinalizedSources({
                    sourceEventId: event.source_event_id,
                    attempt: event.attempt,
                    resultBucket: options.config.resultBucket,
                    result,
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
                    ...(event.instance_id === undefined ? {} : { instance_id: event.instance_id }),
                    source_archive: archived.status,
                    source_artifact_s3_keys: archived.artifactS3Keys,
                    result_s3_key: event.result_s3_key,
                    result_status: result.status,
                });
            }
            case "register_affected_cells_proof": {
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "registering_affected_cells_proof",
                    allowNonProcessing: true,
                    resultS3Key: event.result_s3_key,
                    nowMs,
                });
                const result = await readTeeResultFromS3(options, event);
                const row = await repository.get(event.source_event_id);
                const registration = await registerAffectedCellsProofAction({
                    sourceEventId: event.source_event_id,
                    attempt: event.attempt,
                    result,
                    registrar: options.affectedCellsProofRegistrar,
                    sourceArchiveSucceeded: row?.source_archive_status === "success",
                });
                const marked = await repository.markAffectedCellsProofRegistrationResult(
                    event.source_event_id,
                    affectedCellsProofRegistrationStateUpdate(registration, nowMs),
                    nowMs,
                    event.attempt,
                );
                if (!marked) {
                    throw new Error("stale runner workflow attempt");
                }
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    instance_id: event.instance_id,
                    affected_cells_proof_registration: registration.status,
                    result_s3_key: event.result_s3_key,
                    result_status: result.status,
                });
            }
            case "restore_affected_cells_proof_registration_retry": {
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                const marked = await repository.markAffectedCellsProofRegistrationResult(
                    event.source_event_id,
                    {
                        status: "retryable_failed",
                        errorCode: "AFFECTED_CELLS_PROOF_REGISTRATION_RETRYABLE_FAILED",
                        retryableNextRetryAtMs: nowMs + SOURCE_ARCHIVE_RETRY_BACKOFF_MS,
                        message: event.message ?? "affected cells proof registration retry failed",
                    },
                    nowMs,
                    event.attempt,
                );
                if (!marked) {
                    throw new Error("stale runner workflow attempt");
                }
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    affected_cells_proof_registration: "retry_restored",
                });
            }
            case "relayer_preview_or_dry_run": {
                const repository = requireRepository(options);
                const relayer = options.relayer ?? buildRelayerFromConfig(options.config);
                const result = await readTeeResultFromS3(options, event);
                const instanceContext =
                    event.instance_id === undefined ? {} : { instance_id: event.instance_id };
                if (relayer === undefined || result.status !== "finalized") {
                    return retainVerifierKind({
                        source_event_id: event.source_event_id,
                        attempt: event.attempt,
                        ...instanceContext,
                        relayer: "skipped",
                        result_s3_key: event.result_s3_key,
                        result_status: result.status,
                    });
                }
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "complete",
                    allowNonProcessing: true,
                    resultS3Key: event.result_s3_key,
                });
                const row = await repository.get(event.source_event_id);
                if (row?.source_archive_status !== "success") {
                    return retainVerifierKind({
                        source_event_id: event.source_event_id,
                        attempt: event.attempt,
                        ...instanceContext,
                        relayer: "skipped",
                        result_s3_key: event.result_s3_key,
                        result_status: result.status,
                    });
                }
                const nowMs = options.now?.() ?? Date.now();
                const relayed = await relayer.relay(result);
                if (relayed.ok) {
                    return retainVerifierKind({
                        source_event_id: event.source_event_id,
                        attempt: event.attempt,
                        ...instanceContext,
                        relayer: "succeeded",
                        result_s3_key: event.result_s3_key,
                        result_status: result.status,
                        relayer_success: compactRelayerSuccess(relayed.value),
                    });
                }
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "complete",
                    nowMs,
                    resultS3Key: event.result_s3_key,
                    allowNonProcessing: true,
                });
                const marked = await repository.markRelayerFailed(
                    event.source_event_id,
                    relayer.mode,
                    relayed.error_code,
                    relayed.message,
                    nowMs,
                    event.attempt,
                );
                if (!marked) {
                    throw new Error("stale runner workflow attempt");
                }
                return retainVerifierKind({
                    source_event_id: event.source_event_id,
                    attempt: event.attempt,
                    ...instanceContext,
                    relayer: "failed",
                    result_s3_key: event.result_s3_key,
                    result_status: result.status,
                });
            }
            case "record_relayer_success": {
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "complete",
                    nowMs,
                    resultS3Key: event.result_s3_key,
                    allowNonProcessing: true,
                });
                const result = await readTeeResultFromS3(options, event);
                const marked = await repository.markRelayerSucceeded(
                    event.source_event_id,
                    buildRelayerSuccessForRecord(event.relayer_success, result),
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
                    ...(event.instance_id === undefined ? {} : { instance_id: event.instance_id }),
                    result_s3_key: event.result_s3_key,
                    result_status: result.status,
                    relayer_success: event.relayer_success,
                });
            }
            case "run_floor_census": {
                const repository = requireRepository(options);
                const nowMs = options.now?.() ?? Date.now();
                await requireCurrentWorkflowAttempt(options, event, {
                    phase: "complete",
                    nowMs,
                    resultS3Key: event.result_s3_key,
                    allowNonProcessing: true,
                });
                const row = await repository.get(event.source_event_id);
                if (row?.floor_census_status === "succeeded") {
                    return retainVerifierKind({
                        source_event_id: event.source_event_id,
                        attempt: event.attempt,
                        floor_census: "skipped",
                        result_s3_key: event.result_s3_key,
                        result_status: "finalized",
                    });
                }
                const markedProcessing = await repository.markFloorCensusProcessing(
                    event.source_event_id,
                    nowMs,
                    event.attempt,
                );
                if (!markedProcessing) {
                    throw new Error("stale runner workflow attempt");
                }
                try {
                    const result = await readTeeResultFromS3(options, event);
                    const floorCensus =
                        options.floorCensus ??
                        (await buildCensusTeeFloorCensusFromConfig(options, event, nowMs));
                    if (floorCensus === undefined) {
                        await repository.markFloorCensusResult(
                            event.source_event_id,
                            { status: "skipped", message: "floor census is not configured" },
                            nowMs,
                            event.attempt,
                        );
                        return retainVerifierKind({
                            source_event_id: event.source_event_id,
                            attempt: event.attempt,
                            floor_census: "skipped",
                            result_s3_key: event.result_s3_key,
                            result_status: result.status,
                        });
                    }
                    const census = await floorCensus.run({
                        sourceEventId: event.source_event_id,
                        result,
                        relayerDigest: event.relayer_success.digest,
                        disasterEventId: event.relayer_success.objectId,
                    });
                    if (census.status === "skipped") {
                        await repository.markFloorCensusResult(
                            event.source_event_id,
                            { status: "skipped", message: census.reason },
                            nowMs,
                            event.attempt,
                        );
                        return retainVerifierKind({
                            source_event_id: event.source_event_id,
                            attempt: event.attempt,
                            floor_census: "skipped",
                            result_s3_key: event.result_s3_key,
                            result_status: result.status,
                        });
                    }
                    await repository.markFloorCensusResult(
                        event.source_event_id,
                        {
                            status: "succeeded",
                            digest: census.digest,
                            counts: census.counts,
                        },
                        nowMs,
                        event.attempt,
                    );
                    return retainVerifierKind({
                        source_event_id: event.source_event_id,
                        attempt: event.attempt,
                        floor_census: "succeeded",
                        result_s3_key: event.result_s3_key,
                        result_status: result.status,
                    });
                } catch (error) {
                    await repository.markFloorCensusResult(
                        event.source_event_id,
                        {
                            status: "failed",
                            message: error instanceof Error ? error.message : String(error),
                        },
                        nowMs,
                        event.attempt,
                    );
                    throw error;
                }
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
        if (body.walrus_blob_id !== input.entry.walrus_blob_id) {
            throw new IntegritySourceArchiveError("Walrus source archiver blob id mismatch");
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
                target: resolveEnclaveRegistrationTargetForConfig(
                    this.config.target,
                    this.config.configKey,
                ),
                verifierRegistry: this.config.verifierRegistry,
                attestationDocumentBytes: parseHexByteVector(input.attestationDocumentHex),
                expiresAtMs,
                senderAddress,
                ...(this.config.configKey === undefined
                    ? {}
                    : { configKey: this.config.configKey }),
            });
        const response = await client.signAndExecuteTransaction({
            transaction,
            signer,
            include: { effects: true, events: true },
        });
        const events = readSuccessfulEnclaveRegistrationEvents(response);
        const metadata = readEnclaveRegistrationMetadata(events, {
            expectedFamily: this.config.expectedFamily ?? 3,
            expectedVersion: 1,
            configKey: this.config.configKey ?? EARTHQUAKE_VERIFIER_CONFIG_KEY,
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
    if (event.action === "run_floor_census") {
        const floorCensus = readFloorCensusConfigFromEnv(new AwsRelayerSignerSecretReader());
        if (floorCensus !== undefined) {
            config.floorCensus = floorCensus;
        }
        config.censusNitroEnclaveProcessCommand = requiredEnv(
            "CENSUS_NITRO_ENCLAVE_PROCESS_COMMAND",
        );
    }
    const enclaveRegistration =
        event.action === "register_enclave_instance" || event.action === "run_floor_census"
            ? new SuiEnclaveRegistrationAdapter(
                  readEnclaveRegistrationConfigFromEnv(new AwsRelayerSignerSecretReader(), {
                      ...(event.action === "run_floor_census"
                          ? {
                                configKey: CENSUS_VERIFIER_CONFIG_KEY,
                                expectedFamily: CENSUS_VERIFIER_FAMILY,
                            }
                          : {}),
                  }),
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
    eventRevision: number;
    dispatchTimestampMs: number;
    resultBucket: string;
    resultS3Key: string;
    nitroEnclaveProcessCommand: string;
    registrationMetadata?: EnclaveVerificationMetadata | undefined;
    teeInput?: unknown;
}): string {
    const teeInput =
        input.teeInput ??
        (input.registrationMetadata === undefined
            ? buildEarthquakeVerifierRequest(input.sourceEventId, input.eventRevision)
            : {
                  action: "process_data",
                  payload: buildEarthquakeVerifierRequest(input.sourceEventId, input.eventRevision),
                  registration_metadata: input.registrationMetadata,
              });
    const tempResultPath = `/tmp/sonari-tee-result-${input.sourceEventId}-${input.dispatchTimestampMs}.json`;
    return buildSharedRunnerSsmShellCommand({
        resultBucket: input.resultBucket,
        resultS3Key: input.resultS3Key,
        nitroEnclaveProcessCommand: input.nitroEnclaveProcessCommand,
        teeInput,
        requiredEnvNames: [
            "SONARI_WALRUS_CLI",
            "SONARI_WALRUS_N_SHARDS",
            "SONARI_EARTHQUAKE_EGRESS_PROXY_URL",
        ],
        postEnvCommands: [
            "export SONARI_WALRUS_CLI SONARI_WALRUS_N_SHARDS SONARI_EARTHQUAKE_EGRESS_PROXY_URL",
        ],
        tempResultPath,
    });
}

async function buildCensusTeeFloorCensusFromConfig(
    options: RunnerControlHandlerOptions,
    event: Extract<RunnerControlEvent, { action: "run_floor_census" }>,
    dispatchTimestampMs: number,
): Promise<FloorCensusAdapter | undefined> {
    const config = options.config.floorCensus;
    if (config === undefined) {
        return undefined;
    }
    if (event.instance_id === undefined) {
        throw new Error("floor census requires a runner instance_id");
    }
    const instanceId = event.instance_id;
    const registrar = options.enclaveRegistration;
    if (registrar === undefined) {
        throw new Error("census enclave registration is not configured");
    }
    const attestationText = await dispatchAndReadCensusTeeCommand(options, {
        sourceEventId: event.source_event_id,
        instanceId,
        dispatchTimestampMs,
        teeInput: { action: "get_attestation" },
    });
    const attestation = readEnclaveAttestation(JSON.parse(attestationText) as unknown);
    const registered = requireRegistrationMetadata(
        await registrar.register({
            sourceEventId: event.source_event_id,
            attestationDocumentHex: attestation.attestation_document_hex,
            publicKey: attestation.public_key,
        }),
        CENSUS_VERIFIER_CONFIG_KEY,
    );
    if (
        normalizeHex(registered.enclave_instance_public_key) !==
        normalizeHex(attestation.public_key)
    ) {
        throw new Error("census registration metadata public key does not match attestation");
    }
    const tee: FloorCensusTeeClient = {
        processData: async (teeInput) =>
            JSON.parse(
                await dispatchAndReadCensusTeeCommand(options, {
                    sourceEventId: event.source_event_id,
                    instanceId,
                    dispatchTimestampMs: dispatchTimestampMs + 1,
                    teeInput,
                }),
            ) as unknown,
    };
    return new TeeFloorCensusAdapter(config, tee, registered);
}

async function dispatchAndReadCensusTeeCommand(
    options: RunnerControlHandlerOptions,
    input: {
        sourceEventId: string;
        instanceId: string;
        dispatchTimestampMs: number;
        teeInput: unknown;
    },
): Promise<string> {
    const nitroEnclaveProcessCommand =
        options.config.censusNitroEnclaveProcessCommand ?? CENSUS_NITRO_ENCLAVE_PROCESS_COMMAND;
    const dispatched = await dispatchRunnerCommand(options.ssm, {
        workflowId: `${input.sourceEventId}-census`,
        instanceId: input.instanceId,
        dispatchTimestampMs: input.dispatchTimestampMs,
        buildShellCommand: (resultS3Key) =>
            buildCensusSsmShellCommand({
                sourceEventId: input.sourceEventId,
                dispatchTimestampMs: input.dispatchTimestampMs,
                resultBucket: options.config.resultBucket,
                resultS3Key,
                nitroEnclaveProcessCommand,
                teeInput: input.teeInput,
            }),
    });
    await waitForRunnerCommandSuccess(options.ssm, {
        instanceId: input.instanceId,
        commandId: dispatched.commandId,
    });
    return readRunnerResultText(options.s3, {
        bucket: options.config.resultBucket,
        key: dispatched.resultS3Key,
    });
}

function buildCensusSsmShellCommand(input: {
    sourceEventId: string;
    dispatchTimestampMs: number;
    resultBucket: string;
    resultS3Key: string;
    nitroEnclaveProcessCommand: string;
    teeInput: unknown;
}): string {
    const tempResultPath = `/tmp/sonari-census-tee-result-${input.sourceEventId}-${input.dispatchTimestampMs}.json`;
    return buildSharedRunnerSsmShellCommand({
        resultBucket: input.resultBucket,
        resultS3Key: input.resultS3Key,
        nitroEnclaveProcessCommand: input.nitroEnclaveProcessCommand,
        teeInput: input.teeInput,
        preEnvCommands: ["systemctl is-active --quiet nitro-enclaves-allocator.service"],
        requiredEnvNames: [
            "SONARI_CENSUS_EIF_PATH",
            "SONARI_CENSUS_NITRO_RUN_ENCLAVE_ARGS",
            "SONARI_CENSUS_ENCLAVE_CID",
            "NITRO_ENCLAVE_PROCESS_COMMAND",
        ],
        postEnvCommands: [
            'test -s "$SONARI_CENSUS_EIF_PATH"',
            "export SONARI_CENSUS_EIF_PATH SONARI_CENSUS_NITRO_RUN_ENCLAVE_ARGS SONARI_CENSUS_ENCLAVE_CID NITRO_ENCLAVE_PROCESS_COMMAND",
            `export SONARI_VERIFIER_KIND=${CENSUS_VERIFIER_KIND}`,
        ],
        tempResultPath,
    });
}

async function waitForRunnerCommandSuccess(
    ssm: SsmClientLike,
    input: { instanceId: string; commandId: string },
): Promise<void> {
    let commandPollCount = 0;
    for (let attempt = 0; attempt < CENSUS_RUNNER_COMMAND_MAX_POLLS; attempt += 1) {
        const polled = await pollRunnerCommand(ssm, {
            instanceId: input.instanceId,
            commandId: input.commandId,
            commandPollCount,
        });
        commandPollCount = polled.commandPollCount;
        if (polled.commandStatus === "SUCCEEDED") {
            return;
        }
        if (polled.commandStatus === "FAILED") {
            throw new Error("census TEE command failed");
        }
        await delay(CENSUS_RUNNER_COMMAND_POLL_INTERVAL_MS);
    }
    throw new Error("census TEE command did not complete before timeout");
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildRunnerBootstrapReadinessShellCommand(): string {
    return buildSharedRunnerBootstrapReadinessShellCommand({
        requiredEnvNames: [
            "RUNNER_TOKEN_FILE",
            "SONARI_WALRUS_CLI",
            "SONARI_WALRUS_N_SHARDS",
            "SONARI_EARTHQUAKE_EGRESS_PROXY_URL",
        ],
        postEnvCommands: [
            'test -s "$RUNNER_TOKEN_FILE"',
            'test -x "$SONARI_WALRUS_CLI"',
            "systemctl is-active --quiet nitro-enclaves-allocator.service",
            "systemctl is-active --quiet sonari-earthquake-egress-connect-proxy.service",
            "systemctl is-active --quiet sonari-earthquake-egress-vsock-proxy.service",
        ],
    });
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

function buildAffectedCellsProofRegistrarFromConfig():
    | AffectedCellsProofRegistrarAdapter
    | undefined {
    const registrarUrl = process.env.AFFECTED_PROOF_REGISTRAR_URL;
    const tokenSecretArn = process.env.AFFECTED_PROOF_REGISTRAR_TOKEN_SECRET_ARN;
    if (registrarUrl === undefined || registrarUrl.length === 0) {
        return undefined;
    }
    if (tokenSecretArn === undefined || tokenSecretArn.length === 0) {
        throw new ConfigurationAffectedCellsProofRegistrationError(
            "AFFECTED_PROOF_REGISTRAR_TOKEN_SECRET_ARN is required with AFFECTED_PROOF_REGISTRAR_URL",
        );
    }
    return new HttpAffectedCellsProofRegistrar(registrarUrl, {
        secretArn: tokenSecretArn,
        secretReader: new AwsRelayerSignerSecretReader(),
    });
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

type AffectedCellsProofRegistrationAttemptResult =
    | { status: "skipped" | "success" }
    | {
          status: "configuration_failed" | "retryable_failed" | "integrity_failed";
          message: string;
      };

async function registerAffectedCellsProof(input: {
    sourceEventId: string;
    attempt: number | undefined;
    result: TeeCoreResult;
    registrar: AffectedCellsProofRegistrarAdapter | undefined;
    sourceArchiveSucceeded: boolean;
}): Promise<AffectedCellsProofRegistrationAttemptResult> {
    if (input.result.status !== "finalized" || !input.sourceArchiveSucceeded) {
        return { status: "skipped" };
    }
    if (input.registrar === undefined) {
        return { status: "skipped" };
    }
    const registrationInput = affectedCellsProofRegistrationInput(input.result);
    try {
        await input.registrar.register(registrationInput);
        return { status: "success" };
    } catch (error) {
        if (error instanceof ConfigurationAffectedCellsProofRegistrationError) {
            return { status: "configuration_failed", message: error.message };
        }
        if (error instanceof IntegrityAffectedCellsProofRegistrationError) {
            return { status: "integrity_failed", message: error.message };
        }
        return {
            status: "retryable_failed",
            message: error instanceof Error ? error.message : String(error),
        };
    }
}

async function registerAffectedCellsProofAction(input: {
    sourceEventId: string;
    attempt: number | undefined;
    result: TeeCoreResult;
    registrar: AffectedCellsProofRegistrarAdapter | undefined;
    sourceArchiveSucceeded: boolean;
}): Promise<AffectedCellsProofRegistrationAttemptResult> {
    try {
        return await registerAffectedCellsProof({
            ...input,
            registrar: input.registrar ?? buildAffectedCellsProofRegistrarFromConfig(),
        });
    } catch (error) {
        return affectedCellsProofRegistrationFailure(error);
    }
}

function affectedCellsProofRegistrationFailure(
    error: unknown,
): Extract<AffectedCellsProofRegistrationAttemptResult, { message: string }> {
    if (error instanceof ConfigurationAffectedCellsProofRegistrationError) {
        return { status: "configuration_failed", message: error.message };
    }
    if (error instanceof IntegrityAffectedCellsProofRegistrationError) {
        return { status: "integrity_failed", message: error.message };
    }
    if (error instanceof RetryableAffectedCellsProofRegistrationError) {
        return { status: "retryable_failed", message: error.message };
    }
    return {
        status: "retryable_failed",
        message: error instanceof Error ? error.message : String(error),
    };
}

function affectedCellsProofRegistrationStateUpdate(
    registration: AffectedCellsProofRegistrationAttemptResult,
    nowMs: number,
): AffectedCellsProofRegistrationStateUpdate {
    if (registration.status === "retryable_failed") {
        return {
            status: "retryable_failed",
            errorCode: "AFFECTED_CELLS_PROOF_REGISTRATION_RETRYABLE_FAILED",
            retryableNextRetryAtMs: nowMs + SOURCE_ARCHIVE_RETRY_BACKOFF_MS,
            message: registration.message,
        };
    }
    if (registration.status === "configuration_failed") {
        return {
            status: "configuration_failed",
            errorCode: "AFFECTED_CELLS_PROOF_REGISTRATION_CONFIGURATION_FAILED",
            message: registration.message,
        };
    }
    if (registration.status === "integrity_failed") {
        return {
            status: "integrity_failed",
            errorCode: "AFFECTED_CELLS_PROOF_REGISTRATION_INTEGRITY_FAILED",
            message: registration.message,
        };
    }
    return { status: registration.status };
}

function affectedCellsProofRegistrationInput(
    result: Extract<TeeCoreResult, { status: "finalized" }>,
): AffectedCellsProofRegistrationInput {
    const validation = validateRelayerSubmitInput(result);
    if (!validation.ok) {
        throw new IntegrityAffectedCellsProofRegistrationError(validation.message);
    }
    const payload = validation.value.payload as EarthquakeOraclePayload;
    const affectedCellsRef = validation.value.affected_cells_ref;
    const evidenceManifest = validation.value.evidence_manifest;
    if (affectedCellsRef === undefined || evidenceManifest === undefined) {
        throw new IntegrityAffectedCellsProofRegistrationError(
            "finalized result is missing affected cells registration metadata",
        );
    }
    return {
        event_uid: payload.event_uid,
        event_revision: payload.event_revision,
        affected_cells_uri: affectedCellsRef.uri,
        affected_cells_hash: affectedCellsRef.source_hash,
        affected_cells_root: payload.affected_cells_root,
        affected_cell_count: payload.affected_cell_count,
        geo_resolution: evidenceManifest.affected_cells.geo_resolution,
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
    const affectedCells = validation.value.affected_cells;
    const evidenceManifest = validation.value.evidence_manifest;
    const affectedCellsRef = validation.value.affected_cells_ref;
    const evidenceManifestRef = validation.value.evidence_manifest_ref;
    if (
        affectedCells === undefined ||
        evidenceManifest === undefined ||
        affectedCellsRef === undefined ||
        evidenceManifestRef === undefined
    ) {
        return {
            status: "integrity_failed",
            artifactS3Keys: [],
            message: "finalized result is missing generated source artifact metadata",
        };
    }
    const evidenceManifestBytes = canonicalJsonBytes(evidenceManifest);
    if (
        `0x${createHash("sha256").update(evidenceManifestBytes).digest("hex")}` !==
        payload.evidence_manifest_hash
    ) {
        return {
            status: "integrity_failed",
            artifactS3Keys: [],
            message: "evidence_manifest does not match signed evidence_manifest_hash",
        };
    }
    const affectedCellsBytes = canonicalJsonBytes(affectedCells);
    const bindingError = evidenceManifestBindingError({
        payload,
        rawDataManifest: manifest,
        affectedCells,
        affectedCellsBytes,
        evidenceManifest,
        evidenceManifestBytes,
        affectedCellsRef,
        evidenceManifestRef,
    });
    if (bindingError !== null) {
        return {
            status: "integrity_failed",
            artifactS3Keys: [],
            message: bindingError,
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
    const generatedArtifacts = [
        {
            entry: generatedArtifactEntry({
                sourceEventId: input.sourceEventId,
                product: "affected_cells_json",
                ref: affectedCellsRef,
            }),
            bytes: affectedCellsBytes,
            fileName: "affected_cells.json" as const,
        },
        {
            entry: generatedArtifactEntry({
                sourceEventId: input.sourceEventId,
                product: "evidence_manifest_json",
                ref: evidenceManifestRef,
            }),
            bytes: evidenceManifestBytes,
            fileName: "evidence_manifest.json" as const,
        },
    ];
    for (const generated of generatedArtifacts) {
        try {
            verifySourceBytes(generated.entry, generated.bytes);
            const key = generatedArtifactS3Key({
                sourceEventId: input.sourceEventId,
                attempt: input.attempt,
                fileName: generated.fileName,
            });
            await input.archive.s3.putObjectBytes({
                bucket: input.resultBucket,
                key,
                bytes: generated.bytes,
            });
            artifactS3Keys.push(key);
            const archived = await input.archive.walrus.archiveAndVerify({
                entry: generated.entry,
                bytes: generated.bytes,
                artifactS3Key: key,
            });
            if (archived.walrusBlobId !== generated.entry.walrus_blob_id) {
                return {
                    status: "integrity_failed",
                    artifactS3Keys,
                    message: `Walrus blob id mismatch for ${generated.entry.uri}`,
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

function evidenceManifestBindingError(input: {
    payload: EarthquakeOraclePayload;
    rawDataManifest: RawDataManifest;
    affectedCells: AffectedCellsArtifact;
    affectedCellsBytes: Uint8Array;
    evidenceManifest: EvidenceManifest;
    evidenceManifestBytes: Uint8Array;
    affectedCellsRef: StoredSourceRef;
    evidenceManifestRef: StoredSourceRef;
}): string | null {
    if (
        input.evidenceManifest.schema_version !== 1 ||
        input.evidenceManifest.oracle_version !== input.payload.oracle_version ||
        input.evidenceManifest.event_uid !== input.payload.event_uid ||
        input.evidenceManifest.event_revision !== input.payload.event_revision ||
        input.evidenceManifest.hazard_type !== "EARTHQUAKE" ||
        input.evidenceManifest.source_event_id !== input.payload.source_event_id ||
        input.evidenceManifest.earthquake.title !== input.payload.title ||
        input.evidenceManifest.earthquake.region !== input.payload.region ||
        input.evidenceManifest.earthquake.occurred_at_ms !== input.payload.occurred_at_ms
    ) {
        return "evidence_manifest metadata does not match signed payload";
    }

    if (
        input.payload.evidence_manifest_uri !== input.evidenceManifestRef.uri ||
        input.payload.evidence_manifest_hash !== input.evidenceManifestRef.source_hash ||
        input.evidenceManifestRef.size_bytes !== input.evidenceManifestBytes.byteLength
    ) {
        return "evidence_manifest_ref does not match signed payload or manifest bytes";
    }

    if (
        input.affectedCells.event_uid !== input.payload.event_uid ||
        input.affectedCells.event_revision !== input.payload.event_revision ||
        input.affectedCells.oracle_version !== input.payload.oracle_version ||
        input.affectedCells.geo_resolution !==
            input.evidenceManifest.affected_cells.geo_resolution ||
        input.affectedCells.cell_metric !== "USGS_MMI" ||
        !isSupportedAffectedCellsMethodAndAggregation(input.affectedCells) ||
        input.affectedCells.intensity_scale !== "MMI_X100" ||
        input.evidenceManifest.affected_cells.uri !== input.affectedCellsRef.uri ||
        input.evidenceManifest.affected_cells.hash !== input.affectedCellsRef.source_hash ||
        input.evidenceManifest.affected_cells.root !== input.payload.affected_cells_root ||
        input.evidenceManifest.affected_cells.count !== input.payload.affected_cell_count ||
        input.evidenceManifest.affected_cells.count !== input.affectedCells.affected_cells.length ||
        input.evidenceManifest.affected_cells.geo_resolution !==
            input.affectedCells.geo_resolution ||
        input.affectedCellsRef.size_bytes !== input.affectedCellsBytes.byteLength ||
        input.affectedCellsRef.source_hash !==
            `0x${createHash("sha256").update(input.affectedCellsBytes).digest("hex")}`
    ) {
        return "evidence_manifest affected_cells metadata does not match generated artifact";
    }
    const affectedCellsRoot = computeAffectedCellsRootHex(input.affectedCells);
    if (
        affectedCellsRoot === null ||
        affectedCellsRoot !== input.payload.affected_cells_root ||
        affectedCellsRoot !== input.evidenceManifest.affected_cells.root
    ) {
        return "affected_cells artifact leaves do not match signed Merkle root";
    }

    const expectedSources = input.rawDataManifest.entries
        .map((entry) => ({
            source: entry.name,
            product: entry.product,
            source_uri: entry.source_uri,
            artifact_uri: entry.uri,
            content_hash: entry.content_hash,
            size_bytes: entry.size_bytes,
        }))
        .sort(compareEvidenceSourceBinding);
    const actualSources = input.evidenceManifest.sources
        .map((source) => ({
            source: source.source,
            product: source.product,
            source_uri: source.source_uri,
            artifact_uri: source.artifact_uri,
            content_hash: source.content_hash,
            size_bytes: source.size_bytes,
        }))
        .sort(compareEvidenceSourceBinding);

    if (expectedSources.length !== actualSources.length) {
        return "evidence_manifest sources do not match raw_data_manifest entries";
    }
    for (const [index, expected] of expectedSources.entries()) {
        const actual = actualSources[index];
        if (
            actual === undefined ||
            actual.source !== expected.source ||
            actual.product !== expected.product ||
            actual.source_uri !== expected.source_uri ||
            actual.artifact_uri !== expected.artifact_uri ||
            actual.content_hash !== expected.content_hash ||
            actual.size_bytes !== expected.size_bytes
        ) {
            return "evidence_manifest sources do not match raw_data_manifest entries";
        }
    }

    return null;
}

function isSupportedAffectedCellsMethodAndAggregation(
    affectedCells: AffectedCellsArtifact,
): boolean {
    return (
        (affectedCells.cells_generation_method === "shakemap_gridxml_h3_grid_point_p90_v1" &&
            affectedCells.cell_aggregation === "GRID_POINT_P90") ||
        (affectedCells.cells_generation_method === "shakemap_gridxml_h3_center_bilinear_v1" &&
            affectedCells.cell_aggregation === "H3_CENTER_BILINEAR")
    );
}

function compareEvidenceSourceBinding(
    left: Pick<
        EvidenceManifest["sources"][number],
        "source" | "product" | "source_uri" | "artifact_uri"
    >,
    right: Pick<
        EvidenceManifest["sources"][number],
        "source" | "product" | "source_uri" | "artifact_uri"
    >,
): number {
    return (
        left.source.localeCompare(right.source) ||
        left.product.localeCompare(right.product) ||
        left.source_uri.localeCompare(right.source_uri) ||
        left.artifact_uri.localeCompare(right.artifact_uri)
    );
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

function canonicalJsonBytes(value: AffectedCellsArtifact | EvidenceManifest): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
}

function generatedArtifactEntry(input: {
    sourceEventId: string;
    product: "affected_cells_json" | "evidence_manifest_json";
    ref: StoredSourceRef;
}): RawDataEntry {
    return {
        name: "TEE",
        event_id: input.sourceEventId,
        product: input.product,
        uri: input.ref.uri,
        content_hash: input.ref.source_hash,
        source_uri: input.ref.uri,
        walrus_blob_id: input.ref.walrus_blob_id,
        source_hash: input.ref.source_hash,
        size_bytes: input.ref.size_bytes,
    };
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

function generatedArtifactS3Key(input: {
    sourceEventId: string;
    attempt: number | undefined;
    fileName: "affected_cells.json" | "evidence_manifest.json";
}): string {
    return [
        "source-artifacts",
        input.sourceEventId,
        String(input.attempt ?? 1),
        input.fileName,
    ].join("/");
}

function sanitizeS3KeySegment(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96);
}

export class RetryableSourceArchiveError extends Error {}
export class IntegritySourceArchiveError extends Error {}
export class ConfigurationSourceArchiveError extends Error {}

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

async function readTeeResultFromS3(
    options: RunnerControlHandlerOptions,
    event: { source_event_id: string; result_s3_key: string },
): Promise<TeeCoreResult> {
    const inlineResult = (event as { result?: unknown }).result;
    if (inlineResult !== undefined) {
        return parseTeeResult(JSON.stringify(inlineResult), event.source_event_id);
    }
    if (!isNonEmptyString(event.result_s3_key)) {
        throw new Error("result_s3_key is required");
    }
    const text = await readRunnerResultText(options.s3, {
        bucket: options.config.resultBucket,
        key: event.result_s3_key,
    });
    return parseTeeResult(text, event.source_event_id);
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
        categoryRegistry: success.request.categoryRegistry,
        categoryPool: success.request.categoryPool,
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
        categoryRegistry: success.categoryRegistry,
        categoryPool: success.categoryPool,
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
            categoryRegistry: "",
            categoryPool: "",
            configurationError: `Unsupported RELAYER_MODE: ${mode}`,
        };
    }
    const missingCoreFields = [
        ["RELAYER_TARGET", process.env.RELAYER_TARGET],
        ["RELAYER_REGISTRY", process.env.RELAYER_REGISTRY],
        ["RELAYER_VERIFIER_REGISTRY", process.env.RELAYER_VERIFIER_REGISTRY],
        ["RELAYER_CATEGORY_REGISTRY", process.env.RELAYER_CATEGORY_REGISTRY],
        ["RELAYER_CATEGORY_POOL", process.env.RELAYER_CATEGORY_POOL],
    ]
        .filter(([, value]) => value === undefined || value.length === 0)
        .map(([name]) => name);
    const config: NonNullable<RunnerWorkflowConfig["relayer"]> = {
        mode,
        target: process.env.RELAYER_TARGET ?? "",
        registry: process.env.RELAYER_REGISTRY ?? "",
        verifierRegistry: process.env.RELAYER_VERIFIER_REGISTRY ?? "",
        categoryRegistry: process.env.RELAYER_CATEGORY_REGISTRY ?? "",
        categoryPool: process.env.RELAYER_CATEGORY_POOL ?? "",
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
    overrides: Pick<EnclaveRegistrationConfig, "configKey" | "expectedFamily"> = {},
): EnclaveRegistrationConfig {
    const baseTarget =
        process.env.ENCLAVE_REGISTRATION_TARGET ??
        deriveEnclaveRegistrationTarget(process.env.RELAYER_TARGET) ??
        "";
    const target = resolveEnclaveRegistrationTargetForConfig(baseTarget, overrides.configKey);
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
        ...overrides,
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

export function readFloorCensusConfigFromEnv(
    secretReader: RelayerSignerSecretReader,
): RunnerWorkflowConfig["floorCensus"] {
    const mode = process.env.FLOOR_CENSUS_MODE;
    if (mode === undefined || mode.length === 0 || mode === "disabled") {
        return undefined;
    }
    const network = readSuiNetwork(process.env.RELAYER_NETWORK);
    const target = process.env.FLOOR_CENSUS_TARGET ?? "";
    const grpcUrl = process.env.RELAYER_GRPC_URL;
    const graphqlUrl =
        readOptionalEnv("FLOOR_CENSUS_GRAPHQL_URL") ??
        readOptionalEnv("SONARI_SUI_GRAPHQL_URL") ??
        defaultSuiGraphqlUrl(network);
    const missing = [
        ["FLOOR_CENSUS_TARGET", target],
        ["FLOOR_CENSUS_PAUSE_STATE", process.env.FLOOR_CENSUS_PAUSE_STATE],
        ["FLOOR_CENSUS_CATEGORY_POOL", process.env.FLOOR_CENSUS_CATEGORY_POOL],
        ["FLOOR_CENSUS_MAIN_POOL", process.env.FLOOR_CENSUS_MAIN_POOL],
        ["SONARI_MEMBERSHIP_REGISTRY_ID", process.env.SONARI_MEMBERSHIP_REGISTRY_ID],
        ["RELAYER_VERIFIER_REGISTRY", process.env.RELAYER_VERIFIER_REGISTRY],
        ["RELAYER_NETWORK", process.env.RELAYER_NETWORK],
        ["RELAYER_GRPC_URL", grpcUrl],
        ["RELAYER_SIGNER_SECRET_ARN", process.env.RELAYER_SIGNER_SECRET_ARN],
    ]
        .filter(([, value]) => value === undefined || value.length === 0)
        .map(([name]) => name);
    let configurationError =
        missing.length === 0
            ? undefined
            : `${missing.join(", ")} required for FLOOR_CENSUS_MODE=${mode}`;
    if (mode !== "submit") {
        configurationError = appendConfigurationError(
            configurationError,
            "FLOOR_CENSUS_MODE currently supports submit only",
        );
    }
    if (process.env.RELAYER_NETWORK !== undefined && network === undefined) {
        configurationError = appendConfigurationError(
            configurationError,
            "RELAYER_NETWORK is required for floor census",
        );
    }
    const config: FloorCensusSubmitConfig = {
        target,
        pauseState: process.env.FLOOR_CENSUS_PAUSE_STATE ?? "",
        verifierRegistry: process.env.RELAYER_VERIFIER_REGISTRY ?? "",
        categoryPool: process.env.FLOOR_CENSUS_CATEGORY_POOL ?? "",
        mainPool: process.env.FLOOR_CENSUS_MAIN_POOL ?? "",
        membershipRegistry: process.env.SONARI_MEMBERSHIP_REGISTRY_ID ?? "",
        reader: graphqlUrl === undefined ? undefined : new GraphqlFloorCensusReader(graphqlUrl),
    };
    if (network !== undefined) {
        config.network = network;
    }
    if (grpcUrl !== undefined) {
        config.grpcUrl = grpcUrl;
        if (network !== undefined) {
            config.client = new SuiGrpcClient({
                network,
                baseUrl: grpcUrl,
            }) as unknown as NonNullable<FloorCensusSubmitConfig["client"]>;
        }
    }
    if (configurationError !== undefined) {
        config.configurationError = configurationError;
    }
    const signerSecretArn = process.env.RELAYER_SIGNER_SECRET_ARN;
    if (signerSecretArn !== undefined && signerSecretArn.length > 0) {
        config.loadSigner = async () =>
            createEd25519SuiSignerFromPrivateKey(
                await secretReader.getSecretString(signerSecretArn),
            );
    }
    return config;
}

function defaultSuiGraphqlUrl(network: SuiNetwork | undefined): string | undefined {
    if (network === undefined) {
        return undefined;
    }
    return `https://graphql.${network}.sui.io/graphql`;
}

function readOptionalEnv(name: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value.length === 0 ? undefined : value;
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

function resolveEnclaveRegistrationTargetForConfig(target: string, configKey: number | undefined) {
    if (configKey === undefined) {
        return target;
    }
    const [packageId, moduleName, functionName] = target.split("::");
    if (moduleName === "metadata_verifier" && functionName === "register_enclave_instance") {
        return `${packageId}::metadata_verifier::register_enclave_instance_for_config`;
    }
    return target;
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
