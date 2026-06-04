import { readFileSync } from "node:fs";
import { decodeSuiPrivateKey, type Signer } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { type RelayerSubmitInput, validateRelayerSubmitInput } from "@sonari/earthquake-shared";

export const relayerPackage = "@sonari/earthquake-relayer";

export const RELAYER_SUBMIT_FAILED = "RELAYER_SUBMIT_FAILED";
export const MOVE_REJECTED = "MOVE_REJECTED";

export type RelayerErrorCode = typeof RELAYER_SUBMIT_FAILED | typeof MOVE_REJECTED;

export type RelayerResult<T> =
    | { ok: true; value: T }
    | { ok: false; error_code: RelayerErrorCode; message: string };

export interface RelayerRequestConfig {
    target: string;
    registry: string;
    verifierRegistry: string;
}

export type SuiNetwork = "mainnet" | "testnet" | "devnet";

export interface RelayerDryRunConfig extends RelayerRequestConfig {
    network: SuiNetwork;
    grpcUrl: string;
    senderAddress: string;
    client?: RelayerDryRunClient;
    transaction?: RelayerTransaction;
}

export interface RelayerSubmitConfig extends RelayerRequestConfig {
    network: SuiNetwork;
    grpcUrl: string;
    signer?: RelayerSigner;
    client?: RelayerSubmitClient;
    transaction?: unknown;
}

export type RelayerSigner = Signer;

export interface RelayerTransaction {
    build(input: { client: unknown }): Promise<Uint8Array>;
}

export interface RelayerDryRunClient {
    simulateTransaction(input: {
        transaction: Uint8Array;
        include: { effects: true };
    }): Promise<RelayerExecutionResponse>;
}

export interface RelayerSubmitClient {
    signAndExecuteTransaction(input: {
        transaction: unknown;
        signer: RelayerSigner;
        include: { effects: true; events: true; objectTypes: true };
    }): Promise<RelayerExecutionResponse>;
}

export type RelayerTransactionEffects = Record<string, unknown>;

export interface RelayerTransactionResult {
    digest?: string;
    status?: RelayerExecutionStatus;
    effects?: RelayerTransactionEffects;
    events?: RelayerTransactionEvent[];
    objectTypes?: Record<string, string>;
}

export interface RelayerTransactionEvent {
    type?: string;
    eventType?: string;
    parsedJson?: unknown;
    json?: unknown;
}

export type RelayerExecutionStatus =
    | { success: true; error: null }
    | { success: false; error?: { message?: string } | string | null };

export type RelayerExecutionResponse =
    | {
          $kind: "Transaction";
          Transaction: RelayerTransactionResult;
          FailedTransaction?: never;
      }
    | {
          $kind: "FailedTransaction";
          Transaction?: never;
          FailedTransaction: RelayerTransactionResult;
      }
    | Record<string, unknown>;

interface NormalizedTransactionResult {
    digest?: string;
    effects: RelayerTransactionEffects;
    events?: RelayerTransactionEvent[];
    objectTypes?: Record<string, string>;
}

export interface ParsedRelayerSubmitInput {
    payload: RelayerSubmitInput["payload"];
    payloadBcsBytes: number[];
    signatureBytes: number[];
    publicKeyBytes: number[];
    verifierConfigKey: number;
    verifierConfigVersion: number;
    enclaveInstancePublicKey: string;
    enclaveInstancePublicKeyBytes: number[];
}

export interface RelayerRequestPreview {
    target: string;
    registry: string;
    verifierRegistry: string;
    clock: string;
    verifierConfigKey: number;
    verifierConfigVersion: number;
    enclaveInstancePublicKey: string;
    arguments: [string, string, string, number[], number[], number[]];
    submitRequest: {
        target: string;
        registry: string;
        verifierRegistry: string;
        clock: string;
        verifierConfigKey: number;
        verifierConfigVersion: number;
        enclaveInstancePublicKey: string;
        arguments: [string, string, string, number[], number[], number[]];
    };
}

export interface RelayerDryRunSuccess {
    request: RelayerRequestPreview;
    transactionBytes: number[];
    effects: RelayerTransactionEffects;
}

export interface RelayerSubmitSuccess {
    request: RelayerRequestPreview;
    digest?: string;
    objectId: string;
    effects: RelayerTransactionEffects;
}

const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;

export function loadFixtureRelayerSubmitInput(caseId: string): RelayerSubmitInput {
    if (caseId !== "usgs/finalized_minimal") {
        throw new Error(`Unsupported relayer fixture case: ${caseId}`);
    }

    const fixtureRoot = new URL("../../fixtures/usgs/finalized_minimal/expected/", import.meta.url);
    const payload = readJson(new URL("unsigned_payload.json", fixtureRoot));
    const hashes = readJson(new URL("expected_hashes.json", fixtureRoot));
    const signature = readJson(new URL("signature.json", fixtureRoot));
    const enclave = readJson(new URL("enclave_instance.json", fixtureRoot));

    if (
        typeof hashes.unsigned_bcs_payload_hex !== "string" ||
        typeof signature.signature !== "string" ||
        typeof signature.public_key !== "string" ||
        enclave.verifier_config_key !== 1 ||
        typeof enclave.verifier_config_version !== "number" ||
        typeof enclave.enclave_instance_public_key !== "string"
    ) {
        throw new Error(`Relayer fixture case is malformed: ${caseId}`);
    }

    return {
        status: "finalized",
        payload,
        payload_bcs_hex: hashes.unsigned_bcs_payload_hex,
        signature: signature.signature,
        public_key: signature.public_key,
        verifier_config_key: enclave.verifier_config_key,
        verifier_config_version: enclave.verifier_config_version,
        enclave_instance_public_key: enclave.enclave_instance_public_key,
    };
}

export function createEd25519SuiSignerFromPrivateKey(value: string): Ed25519Keypair {
    const decoded = decodeSuiPrivateKey(value);
    if (decoded.scheme !== "ED25519") {
        throw new Error("Only Ed25519 Sui private keys are supported for relayer submit");
    }

    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
}

export function buildRelayerRequestPreview(
    input: unknown,
    config: RelayerRequestConfig,
): RelayerResult<RelayerRequestPreview> {
    const parsed = parseRelayerSubmitInput(input);
    if (!parsed.ok) {
        return parsed;
    }

    const configResult = validateRequestConfig(config);
    if (!configResult.ok) {
        return configResult;
    }

    const moveArguments: [string, string, string, number[], number[], number[]] = [
        config.registry,
        config.verifierRegistry,
        SUI_CLOCK_OBJECT_ID,
        [...parsed.value.payloadBcsBytes],
        [...parsed.value.signatureBytes],
        [...parsed.value.publicKeyBytes],
    ];
    const submitRequest = {
        target: config.target,
        registry: config.registry,
        verifierRegistry: config.verifierRegistry,
        clock: SUI_CLOCK_OBJECT_ID,
        verifierConfigKey: parsed.value.verifierConfigKey,
        verifierConfigVersion: parsed.value.verifierConfigVersion,
        enclaveInstancePublicKey: parsed.value.enclaveInstancePublicKey,
        arguments: cloneMoveArguments(moveArguments),
    };

    return {
        ok: true,
        value: {
            target: config.target,
            registry: config.registry,
            verifierRegistry: config.verifierRegistry,
            clock: SUI_CLOCK_OBJECT_ID,
            verifierConfigKey: parsed.value.verifierConfigKey,
            verifierConfigVersion: parsed.value.verifierConfigVersion,
            enclaveInstancePublicKey: parsed.value.enclaveInstancePublicKey,
            arguments: cloneMoveArguments(moveArguments),
            submitRequest,
        },
    };
}

export async function dryRunRelayerSubmit(
    input: unknown,
    config: RelayerDryRunConfig,
): Promise<RelayerResult<RelayerDryRunSuccess>> {
    const preview = buildRelayerRequestPreview(input, config);
    if (!preview.ok) {
        return preview;
    }

    const networkValidation = validateSuiNetworkGrpcUrl(config.network, config.grpcUrl);
    if (!networkValidation.ok) {
        return networkValidation;
    }

    if (!isNonEmptyString(config.senderAddress)) {
        return relayerSubmitFailed("Dry-run requires grpcUrl and senderAddress");
    }

    try {
        const client = config.client ?? createSuiGrpcClient(config.grpcUrl, config.network);
        const transaction = (config.transaction ??
            createSuiSubmitTransaction(preview.value, {
                senderAddress: config.senderAddress,
            })) as RelayerTransaction;
        const transactionBytes = await transaction.build({ client });
        const response = await client.simulateTransaction({
            transaction: transactionBytes,
            include: { effects: true },
        });
        const result = normalizeTransactionResult(response);
        if (!result.ok) {
            return result;
        }

        return {
            ok: true,
            value: {
                request: preview.value,
                transactionBytes: Array.from(transactionBytes),
                effects: result.value.effects,
            },
        };
    } catch (error) {
        return relayerSubmitFailed(errorMessage(error));
    }
}

export async function submitRelayerPayload(
    input: unknown,
    config: RelayerSubmitConfig,
): Promise<RelayerResult<RelayerSubmitSuccess>> {
    const preview = buildRelayerRequestPreview(input, config);
    if (!preview.ok) {
        return preview;
    }

    const networkValidation = validateSuiNetworkGrpcUrl(config.network, config.grpcUrl);
    if (!networkValidation.ok) {
        return networkValidation;
    }

    if (config.signer === undefined) {
        return relayerSubmitFailed("Submit requires explicit grpcUrl and signer");
    }

    const senderAddress = config.signer.toSuiAddress();
    if (!isNonEmptyString(senderAddress)) {
        return relayerSubmitFailed("Signer did not provide a sender address");
    }

    try {
        const client = config.client ?? createSuiGrpcClient(config.grpcUrl, config.network);
        const transaction =
            config.transaction ?? createSuiSubmitTransaction(preview.value, { senderAddress });
        const response = await client.signAndExecuteTransaction({
            transaction,
            signer: config.signer,
            include: { effects: true, events: true, objectTypes: true },
        });
        const result = normalizeTransactionResult(response);
        if (!result.ok) {
            return result;
        }
        const objectId = readCreatedDisasterEventObjectId(result.value);
        if (objectId === undefined) {
            return relayerSubmitFailed(
                "Sui response did not include created DisasterEvent object ID",
            );
        }

        const value: RelayerSubmitSuccess = {
            request: preview.value,
            objectId,
            effects: result.value.effects,
        };
        if (result.value.digest !== undefined) {
            value.digest = result.value.digest;
        }

        return {
            ok: true,
            value,
        };
    } catch (error) {
        return relayerSubmitFailed(errorMessage(error));
    }
}

export function createSuiSubmitTransaction(
    request: RelayerRequestPreview,
    options: { senderAddress: string },
): Transaction {
    const tx = new Transaction();
    tx.setSender(options.senderAddress);
    tx.moveCall({
        target: request.target,
        arguments: [
            tx.object(request.registry),
            tx.object(request.verifierRegistry),
            tx.object.clock(),
            tx.pure.vector("u8", Array.from(request.arguments[3])),
            tx.pure.vector("u8", Array.from(request.arguments[4])),
            tx.pure.vector("u8", Array.from(request.arguments[5])),
        ],
    });
    return tx;
}

export function parseRelayerSubmitInput(input: unknown): RelayerResult<ParsedRelayerSubmitInput> {
    const validation = validateRelayerSubmitInput(input);
    if (!validation.ok) {
        return relayerSubmitFailed(validation.message);
    }

    const payloadBcsBytes = parseHexBytes(validation.value.payload_bcs_hex, "payload_bcs_hex");
    if (!payloadBcsBytes.ok) {
        return payloadBcsBytes;
    }

    const signatureBytes = parseHexBytes(
        validation.value.signature,
        "signature",
        ED25519_SIGNATURE_BYTES,
    );
    if (!signatureBytes.ok) {
        return signatureBytes;
    }

    const publicKeyBytes = parseHexBytes(
        validation.value.public_key,
        "public_key",
        ED25519_PUBLIC_KEY_BYTES,
    );
    if (!publicKeyBytes.ok) {
        return publicKeyBytes;
    }

    const enclaveInstancePublicKeyBytes = parseHexBytes(
        validation.value.enclave_instance_public_key,
        "enclave_instance_public_key",
        ED25519_PUBLIC_KEY_BYTES,
    );
    if (!enclaveInstancePublicKeyBytes.ok) {
        return enclaveInstancePublicKeyBytes;
    }
    if (!bytesEqual(publicKeyBytes.value, enclaveInstancePublicKeyBytes.value)) {
        return relayerSubmitFailed("enclave_instance_public_key must match public_key");
    }

    return {
        ok: true,
        value: {
            payload: validation.value.payload,
            payloadBcsBytes: payloadBcsBytes.value,
            signatureBytes: signatureBytes.value,
            publicKeyBytes: publicKeyBytes.value,
            verifierConfigKey: validation.value.verifier_config_key,
            verifierConfigVersion: validation.value.verifier_config_version,
            enclaveInstancePublicKey: validation.value.enclave_instance_public_key,
            enclaveInstancePublicKeyBytes: enclaveInstancePublicKeyBytes.value,
        },
    };
}

function validateRequestConfig(config: RelayerRequestConfig): RelayerResult<RelayerRequestConfig> {
    if (
        !isNonEmptyString(config.target) ||
        !isNonEmptyString(config.registry) ||
        !isNonEmptyString(config.verifierRegistry)
    ) {
        return relayerSubmitFailed(
            "Relayer request requires target, registry, and verifierRegistry",
        );
    }

    return {
        ok: true,
        value: {
            target: config.target,
            registry: config.registry,
            verifierRegistry: config.verifierRegistry,
        },
    };
}

function createSuiGrpcClient(
    grpcUrl: string,
    network: SuiNetwork,
): RelayerDryRunClient & RelayerSubmitClient {
    return new SuiGrpcClient({
        network,
        baseUrl: grpcUrl,
    }) as unknown as RelayerDryRunClient & RelayerSubmitClient;
}

function validateSuiNetworkGrpcUrl(network: unknown, grpcUrl: unknown): RelayerResult<SuiNetwork> {
    if (network !== "mainnet" && network !== "testnet" && network !== "devnet") {
        return relayerSubmitFailed(`Unsupported Sui network: ${String(network)}`);
    }
    if (!isNonEmptyString(grpcUrl)) {
        return relayerSubmitFailed("RELAYER_GRPC_URL is required");
    }

    let url: URL;
    try {
        url = new URL(grpcUrl);
    } catch {
        return relayerSubmitFailed("RELAYER_GRPC_URL must be a valid URL");
    }

    if (url.protocol !== "https:") {
        return relayerSubmitFailed("RELAYER_GRPC_URL must use https");
    }
    if (url.username.length > 0 || url.password.length > 0) {
        return relayerSubmitFailed("RELAYER_GRPC_URL must not include credentials");
    }

    const expectedHost = `fullnode.${network}.sui.io`;
    if (url.hostname !== expectedHost) {
        return relayerSubmitFailed(
            `RELAYER_GRPC_URL host ${url.hostname} does not match RELAYER_NETWORK=${network}`,
        );
    }

    return { ok: true, value: network };
}

function parseHexBytes(
    value: string,
    fieldName: string,
    expectedLength?: number,
): RelayerResult<number[]> {
    const normalized = value.startsWith("0x") ? value.slice(2) : value;
    if (normalized.length === 0) {
        return relayerSubmitFailed(`${fieldName} must not be empty`);
    }

    if (normalized.length % 2 !== 0) {
        return relayerSubmitFailed(`${fieldName} must use an even number of hex characters`);
    }

    if (!/^[0-9a-fA-F]+$/.test(normalized)) {
        return relayerSubmitFailed(`${fieldName} must be hex encoded`);
    }

    const bytes = Array.from(Buffer.from(normalized, "hex"));
    if (expectedLength !== undefined && bytes.length !== expectedLength) {
        return relayerSubmitFailed(`${fieldName} must be ${expectedLength} bytes`);
    }

    return { ok: true, value: bytes };
}

function normalizeTransactionResult(
    response: RelayerExecutionResponse,
): RelayerResult<NormalizedTransactionResult> {
    if (!isRecord(response)) {
        return relayerSubmitFailed("Sui response was not an object");
    }

    if (response.$kind === "Transaction") {
        const transaction = response.Transaction;
        if (!isRecord(transaction)) {
            return relayerSubmitFailed("Sui response did not include transaction data");
        }

        const status = readExecutionStatus(transaction.status);
        if (status?.success === false) {
            return moveRejected(status.errorMessage ?? "Move transaction reported failure");
        }

        if (status?.success !== true) {
            return relayerSubmitFailed("Sui response did not include transaction status");
        }

        if (!isRecord(transaction.effects)) {
            return relayerSubmitFailed("Sui response did not include transaction effects");
        }

        const value: NormalizedTransactionResult = {
            effects: transaction.effects,
        };
        if (typeof transaction.digest === "string") {
            value.digest = transaction.digest;
        }
        if (Array.isArray(transaction.events)) {
            value.events = transaction.events.filter(isRecord);
        }
        if (isStringRecord(transaction.objectTypes)) {
            value.objectTypes = transaction.objectTypes;
        }

        return { ok: true, value };
    }

    if (response.$kind === "FailedTransaction") {
        const failedTransaction = response.FailedTransaction;
        const status = isRecord(failedTransaction)
            ? readExecutionStatus(failedTransaction.status)
            : undefined;

        return moveRejected(status?.errorMessage ?? "Move transaction failed");
    }

    return relayerSubmitFailed("Sui response used an unknown transaction result shape");
}

function relayerSubmitFailed<T = never>(message: string): RelayerResult<T> {
    return { ok: false, error_code: RELAYER_SUBMIT_FAILED, message };
}

function moveRejected<T = never>(message: string): RelayerResult<T> {
    return { ok: false, error_code: MOVE_REJECTED, message };
}

function readExecutionStatus(
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

function readCreatedDisasterEventObjectId(result: NormalizedTransactionResult): string | undefined {
    const eventObjectId = result.events
        ?.map((event) => {
            if (!isDisasterEventCreatedEvent(event)) {
                return undefined;
            }
            return readObjectIdFromParsedJson(readEventJson(event), "disaster_event_id");
        })
        .find(isNonEmptyString);
    if (eventObjectId !== undefined) {
        return eventObjectId;
    }

    const changedObjects = result.effects.changedObjects;
    if (!Array.isArray(changedObjects)) {
        return undefined;
    }

    const createdObjectIds = changedObjects.map(readCreatedObjectId).filter(isNonEmptyString);
    if (result.objectTypes !== undefined) {
        return createdObjectIds.find((objectId) =>
            result.objectTypes?.[objectId]?.endsWith("::disaster_event::DisasterEvent"),
        );
    }
    return createdObjectIds.length === 1 ? createdObjectIds[0] : undefined;
}

function isDisasterEventCreatedEvent(event: RelayerTransactionEvent): boolean {
    const eventType = typeof event.eventType === "string" ? event.eventType : event.type;
    return (
        typeof eventType === "string" &&
        eventType.endsWith("::disaster_event::DisasterEventCreated")
    );
}

function readEventJson(event: RelayerTransactionEvent): unknown {
    return event.json ?? event.parsedJson;
}

function readObjectIdFromParsedJson(input: unknown, key: string): string | undefined {
    if (!isRecord(input)) {
        return undefined;
    }
    const value = input[key];
    if (typeof value === "string") {
        return value;
    }
    if (isRecord(value) && typeof value.id === "string") {
        return value.id;
    }
    return undefined;
}

function readCreatedObjectId(input: unknown): string | undefined {
    if (!isRecord(input)) {
        return undefined;
    }
    if (input.outputState !== "ObjectWrite" || input.idOperation !== "Created") {
        return undefined;
    }
    return typeof input.objectId === "string" ? input.objectId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return (
        isRecord(value) &&
        Object.values(value).every((entry): entry is string => typeof entry === "string")
    );
}

function cloneMoveArguments(
    args: [string, string, string, number[], number[], number[]],
): [string, string, string, number[], number[], number[]] {
    return [args[0], args[1], args[2], [...args[3]], [...args[4]], [...args[5]]];
}

function bytesEqual(left: readonly number[], right: readonly number[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readJson(url: URL): Record<string, unknown> {
    return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
