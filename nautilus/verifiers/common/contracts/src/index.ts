export const EARTHQUAKE_VERIFIER_KIND = "earthquake";
export const MEMBERSHIP_IDENTITY_VERIFIER_KIND = "membership_identity";

export const VERIFIER_KINDS = [
    EARTHQUAKE_VERIFIER_KIND,
    MEMBERSHIP_IDENTITY_VERIFIER_KIND,
] as const;

export type VerifierKind = (typeof VERIFIER_KINDS)[number];

export function parseVerifierKind(input: unknown): VerifierKind {
    if (input === EARTHQUAKE_VERIFIER_KIND || input === MEMBERSHIP_IDENTITY_VERIFIER_KIND) {
        return input;
    }
    throw new Error("verifier_kind must be earthquake or membership_identity");
}

export interface RunnerAutoScalingClientLike {
    setDesiredCapacity(input: {
        autoScalingGroupName: string;
        desiredCapacity: number;
    }): Promise<void>;
}

export interface RunnerEc2ClientLike {
    listRunnerInstances(input: {
        autoScalingGroupName: string;
    }): Promise<Array<{ instanceId: string; state: string }>>;
}

export interface RunnerSsmClientLike {
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

export interface RunnerS3ClientLike {
    getObjectText(input: { bucket: string; key: string }): Promise<string>;
}

export function parseExpectedVerifierKind(
    input: unknown,
    expected: VerifierKind,
): VerifierKind | undefined {
    if (input === undefined) {
        return undefined;
    }
    const verifierKind = parseVerifierKind(input);
    if (verifierKind !== expected) {
        throw new Error(`verifier_kind must be ${expected}`);
    }
    return verifierKind;
}

export function withVerifierKind<T extends object>(
    verifierKind: VerifierKind | undefined,
    output: T,
): T | (T & { verifier_kind: VerifierKind }) {
    if (verifierKind === undefined) {
        return output;
    }
    return { verifier_kind: verifierKind, ...output };
}

export interface SharedRunnerLeaseStore {
    acquire(input: {
        leaseId: string;
        owner: string;
        nowSeconds: number;
        expiresAtSeconds: number;
    }): Promise<void>;
    release(input: { leaseId: string; owner: string }): Promise<boolean>;
}

export function buildSharedRunnerLeaseOwner(input: {
    verifierKind: VerifierKind;
    workflowId: string;
    attempt?: number | undefined;
}): string {
    if (input.workflowId.length === 0) {
        throw new Error("workflowId is required for shared runner lease");
    }
    return [input.verifierKind, input.workflowId, String(input.attempt ?? 1)].join(":");
}

export async function acquireSharedRunnerLease(
    store: SharedRunnerLeaseStore,
    input: {
        owner: string;
        nowMs?: number | undefined;
        leaseTtlSeconds?: number | undefined;
    },
): Promise<void> {
    const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
    const leaseTtlSeconds = input.leaseTtlSeconds ?? 60 * 60;
    await store.acquire({
        leaseId: "shared-runner",
        owner: input.owner,
        nowSeconds,
        expiresAtSeconds: nowSeconds + leaseTtlSeconds,
    });
}

export async function releaseSharedRunnerLease(
    store: SharedRunnerLeaseStore,
    owner: string,
): Promise<boolean> {
    return store.release({ leaseId: "shared-runner", owner });
}

export async function setRunnerDesiredCapacity(
    autoscaling: RunnerAutoScalingClientLike,
    input: {
        autoScalingGroupName: string;
        desiredCapacity: number;
    },
): Promise<void> {
    await autoscaling.setDesiredCapacity(input);
}

export async function findReadyRunnerInstance(
    ec2: RunnerEc2ClientLike,
    ssm: RunnerSsmClientLike,
    input: {
        autoScalingGroupName: string;
        runnerLabel?: string | undefined;
    },
): Promise<string> {
    const instances = await ec2.listRunnerInstances({
        autoScalingGroupName: input.autoScalingGroupName,
    });
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
    const runnerLabel = input.runnerLabel ?? "runner";
    throw new Error(`No running SSM-managed ${runnerLabel} instance is bootstrap-ready`);
}

export async function dispatchRunnerCommand(
    ssm: RunnerSsmClientLike,
    input: {
        workflowId: string;
        instanceId: string;
        dispatchTimestampMs: number;
        buildShellCommand(resultS3Key: string): string;
    },
): Promise<{
    commandId: string;
    resultS3Key: string;
    commandPollCount: number;
}> {
    const resultS3Key = `results/${input.workflowId}/${input.dispatchTimestampMs}.json`;
    const sent = await ssm.sendCommand({
        instanceId: input.instanceId,
        shellCommand: input.buildShellCommand(resultS3Key),
    });
    return {
        commandId: sent.commandId,
        resultS3Key,
        commandPollCount: 0,
    };
}

export async function pollRunnerCommand(
    ssm: RunnerSsmClientLike,
    input: {
        instanceId: string;
        commandId: string;
        commandPollCount?: number | undefined;
    },
): Promise<{
    commandStatus: "PENDING" | "SUCCEEDED" | "FAILED";
    commandPollCount: number;
}> {
    const commandStatus = await pollCommandStatus(ssm, {
        instanceId: input.instanceId,
        commandId: input.commandId,
    });
    return {
        commandStatus,
        commandPollCount:
            commandStatus === "PENDING"
                ? (input.commandPollCount ?? 0) + 1
                : (input.commandPollCount ?? 0),
    };
}

export async function readRunnerResultText(
    s3: RunnerS3ClientLike,
    input: {
        bucket: string;
        key: string;
    },
): Promise<string> {
    return s3.getObjectText(input);
}

async function pollCommandStatus(
    ssm: RunnerSsmClientLike,
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

// ============================================================
// Enclave attestation / registration helpers (generalized)
// ============================================================

import { Transaction } from "@mysten/sui/transactions";

// --- Types ---

export interface EnclaveRegistrationEvent {
    type?: string;
    eventType?: string;
    json?: unknown;
    parsedJson?: unknown;
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

export interface EnclaveAttestationResult {
    attestation_document_hex: string;
    public_key: string;
}

/**
 * Generalized enclave verification metadata.
 * verifier_config_key is a plain number (not a literal) to allow any family.
 */
export interface EnclaveVerificationMetadata {
    verifier_config_key: number;
    verifier_config_version: number;
    enclave_instance_public_key: string;
}

// --- Hex helpers ---

export function normalizeHex(value: string): string {
    return (value.startsWith("0x") ? value.slice(2) : value).toLowerCase();
}

export function isHexBytes(value: unknown, expectedBytes?: number): value is string {
    if (typeof value !== "string" || !/^(?:0x)?[0-9a-fA-F]+$/.test(value)) {
        return false;
    }
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    if (hex.length === 0 || hex.length % 2 !== 0) {
        return false;
    }
    return expectedBytes === undefined || hex.length === expectedBytes * 2;
}

export function parseHexByteVector(value: string): number[] {
    return Array.from(Buffer.from(normalizeHex(value), "hex"));
}

// --- Internal helpers ---

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function readSafeIntegerField(input: Record<string, unknown>, key: string): number | undefined {
    const value = input[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) {
        return value;
    }
    if (typeof value === "string" && /^[0-9]+$/.test(value)) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    return undefined;
}

function decodeBase64ByteVector(input: string): number[] | undefined {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input) || input.length % 4 !== 0) {
        return undefined;
    }
    const decoded = Buffer.from(input, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== input) {
        return undefined;
    }
    return Array.from(decoded);
}

function readHexByteVectorField(input: unknown): string | undefined {
    if (isHexBytes(input, 32)) {
        return `0x${normalizeHex(input)}`;
    }
    if (typeof input === "string") {
        const decoded = decodeBase64ByteVector(input);
        if (decoded !== undefined) {
            return `0x${decoded.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        }
    }
    if (
        Array.isArray(input) &&
        input.length === 32 &&
        input.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
        return `0x${input.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
    return undefined;
}

function readEventJson(event: EnclaveRegistrationEvent): unknown {
    return event.json ?? event.parsedJson;
}

export function isEnclaveInstanceRegisteredEvent(event: EnclaveRegistrationEvent): boolean {
    const eventType = typeof event.eventType === "string" ? event.eventType : event.type;
    return (
        typeof eventType === "string" &&
        eventType.endsWith("::metadata_verifier::EnclaveInstanceRegistered")
    );
}

// --- Public helpers ---

/**
 * Parse EnclaveInstanceRegistered events into generalized metadata.
 * expectedFamily and expectedVersion validate the event matches the intended verifier.
 * configKey is assigned as verifier_config_key in the returned metadata.
 */
export function readEnclaveRegistrationMetadata(
    events: EnclaveRegistrationEvent[],
    options: {
        expectedFamily: number;
        expectedVersion: number;
        configKey: number;
    },
): EnclaveVerificationMetadata {
    const event = events.find(isEnclaveInstanceRegisteredEvent);
    if (event === undefined) {
        throw new Error("Sui response did not include EnclaveInstanceRegistered event");
    }
    const json = readEventJson(event);
    if (!isRecord(json)) {
        throw new Error("EnclaveInstanceRegistered event was malformed");
    }
    const verifierFamily = readSafeIntegerField(json, "verifier_family");
    const verifierVersion = readSafeIntegerField(json, "verifier_version");
    const configVersion = readSafeIntegerField(json, "config_version");
    const publicKey = readHexByteVectorField(json.public_key);
    if (
        verifierFamily !== options.expectedFamily ||
        verifierVersion !== options.expectedVersion ||
        configVersion === undefined
    ) {
        throw new Error(
            `EnclaveInstanceRegistered event did not match verifier family=${options.expectedFamily} version=${options.expectedVersion}`,
        );
    }
    if (publicKey === undefined) {
        throw new Error("EnclaveInstanceRegistered event public key was malformed");
    }
    return {
        verifier_config_key: options.configKey,
        verifier_config_version: configVersion,
        enclave_instance_public_key: publicKey,
    };
}

/**
 * Validate that a registration metadata object has the expected configKey.
 * Throws if any field is missing or configKey does not match expectedConfigKey.
 */
export function requireRegistrationMetadata(
    input: unknown,
    expectedConfigKey: number,
): EnclaveVerificationMetadata {
    if (
        !isRecord(input) ||
        input.verifier_config_key !== expectedConfigKey ||
        !isSafeIntegerInRange(input.verifier_config_version, 1, Number.MAX_SAFE_INTEGER) ||
        !isHexBytes(input.enclave_instance_public_key, 32)
    ) {
        throw new Error("enclave registration metadata is malformed");
    }
    return {
        verifier_config_key: input.verifier_config_key,
        verifier_config_version: input.verifier_config_version,
        enclave_instance_public_key: input.enclave_instance_public_key,
    };
}

/**
 * Parse and validate an enclave attestation result from raw JSON input.
 */
export function readEnclaveAttestation(input: unknown): EnclaveAttestationResult {
    if (
        !isRecord(input) ||
        !isHexBytes(input.attestation_document_hex) ||
        !isHexBytes(input.public_key, 32)
    ) {
        throw new Error("enclave attestation is malformed");
    }
    return {
        attestation_document_hex: input.attestation_document_hex,
        public_key: input.public_key,
    };
}

/**
 * Build a Sui Transaction for enclave registration.
 * When configKey is provided, adds it as a u64 argument (for register_enclave_instance_for_config).
 * Without configKey, produces the standard register_enclave_instance call.
 */
export function createSuiEnclaveRegistrationTransaction(input: {
    target: string;
    verifierRegistry: string;
    attestationDocumentBytes: number[];
    expiresAtMs: number;
    senderAddress: string;
    configKey?: number | undefined;
}): Transaction {
    const tx = new Transaction();
    tx.setSender(input.senderAddress);
    const document = tx.moveCall({
        target: "0x2::nitro_attestation::load_nitro_attestation",
        arguments: [tx.pure.vector("u8", input.attestationDocumentBytes), tx.object.clock()],
    });
    const args = [tx.object(input.verifierRegistry), document, tx.pure.u64(input.expiresAtMs)];
    if (input.configKey !== undefined) {
        args.push(tx.pure.u64(input.configKey));
    }
    tx.moveCall({
        target: input.target,
        arguments: args,
    });
    return tx;
}
