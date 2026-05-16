import { readFileSync } from "node:fs";
import type { Signer } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { type RelayerSubmitInput, validateRelayerSubmitInput } from "@sonari/oracle-shared";

export const relayerPackage = "@sonari/oracle-relayer";

export const RELAYER_SUBMIT_FAILED = "RELAYER_SUBMIT_FAILED";
export const MOVE_REJECTED = "MOVE_REJECTED";

export type RelayerErrorCode = typeof RELAYER_SUBMIT_FAILED | typeof MOVE_REJECTED;

export type RelayerResult<T> =
    | { ok: true; value: T }
    | { ok: false; error_code: RelayerErrorCode; message: string };

export interface RelayerRequestConfig {
    target: string;
    registry: string;
}

export interface RelayerDryRunConfig extends RelayerRequestConfig {
    grpcUrl: string;
    senderAddress: string;
    client?: RelayerDryRunClient;
    transaction?: RelayerTransaction;
}

export interface RelayerSubmitConfig extends RelayerRequestConfig {
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
        include: { effects: true };
    }): Promise<RelayerExecutionResponse>;
}

export type RelayerTransactionEffects = Record<string, unknown>;

export interface RelayerTransactionResult {
    digest?: string;
    status?: RelayerExecutionStatus;
    effects?: RelayerTransactionEffects;
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
}

export interface ParsedRelayerSubmitInput {
    payload: RelayerSubmitInput["payload"];
    payloadBcsBytes: number[];
    signatureBytes: number[];
    publicKeyBytes: number[];
}

export interface RelayerRequestPreview {
    target: string;
    registry: string;
    arguments: [string, number[], number[], number[]];
    submitRequest: {
        target: string;
        registry: string;
        arguments: [string, number[], number[], number[]];
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
    effects: RelayerTransactionEffects;
}

const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;

export function loadFixtureRelayerSubmitInput(caseId: string): RelayerSubmitInput {
    if (caseId !== "usgs/finalized_minimal") {
        throw new Error(`Unsupported relayer fixture case: ${caseId}`);
    }

    const fixtureRoot = new URL("../../fixtures/usgs/finalized_minimal/expected/", import.meta.url);
    const payload = readJson(new URL("unsigned_payload_v1.json", fixtureRoot));
    const hashes = readJson(new URL("expected_hashes.json", fixtureRoot));
    const signature = readJson(new URL("signature.json", fixtureRoot));

    if (
        typeof hashes.unsigned_bcs_payload_hex !== "string" ||
        typeof signature.signature !== "string" ||
        typeof signature.public_key !== "string"
    ) {
        throw new Error(`Relayer fixture case is malformed: ${caseId}`);
    }

    return {
        status: "finalized",
        payload,
        payload_bcs_hex: hashes.unsigned_bcs_payload_hex,
        signature: signature.signature,
        public_key: signature.public_key,
    };
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

    const moveArguments: [string, number[], number[], number[]] = [
        config.registry,
        [...parsed.value.payloadBcsBytes],
        [...parsed.value.signatureBytes],
        [...parsed.value.publicKeyBytes],
    ];
    const submitRequest = {
        target: config.target,
        registry: config.registry,
        arguments: cloneMoveArguments(moveArguments),
    };

    return {
        ok: true,
        value: {
            target: config.target,
            registry: config.registry,
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

    if (!isNonEmptyString(config.grpcUrl) || !isNonEmptyString(config.senderAddress)) {
        return relayerSubmitFailed("Dry-run requires grpcUrl and senderAddress");
    }

    try {
        const client = config.client ?? createSuiGrpcClient(config.grpcUrl);
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

    if (!isNonEmptyString(config.grpcUrl) || config.signer === undefined) {
        return relayerSubmitFailed("Submit requires explicit grpcUrl and signer");
    }

    const senderAddress = config.signer.toSuiAddress();
    if (!isNonEmptyString(senderAddress)) {
        return relayerSubmitFailed("Signer did not provide a sender address");
    }

    try {
        const client = config.client ?? createSuiGrpcClient(config.grpcUrl);
        const transaction =
            config.transaction ?? createSuiSubmitTransaction(preview.value, { senderAddress });
        const response = await client.signAndExecuteTransaction({
            transaction,
            signer: config.signer,
            include: { effects: true },
        });
        const result = normalizeTransactionResult(response);
        if (!result.ok) {
            return result;
        }

        const value: RelayerSubmitSuccess = {
            request: preview.value,
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
            tx.pure.vector("u8", Array.from(request.arguments[1])),
            tx.pure.vector("u8", Array.from(request.arguments[2])),
            tx.pure.vector("u8", Array.from(request.arguments[3])),
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

    return {
        ok: true,
        value: {
            payload: validation.value.payload,
            payloadBcsBytes: payloadBcsBytes.value,
            signatureBytes: signatureBytes.value,
            publicKeyBytes: publicKeyBytes.value,
        },
    };
}

function validateRequestConfig(config: RelayerRequestConfig): RelayerResult<RelayerRequestConfig> {
    if (!isNonEmptyString(config.target) || !isNonEmptyString(config.registry)) {
        return relayerSubmitFailed("Relayer request requires target and registry");
    }

    return { ok: true, value: { target: config.target, registry: config.registry } };
}

function createSuiGrpcClient(grpcUrl: string): RelayerDryRunClient & RelayerSubmitClient {
    return new SuiGrpcClient({
        network: inferSuiNetwork(grpcUrl),
        baseUrl: grpcUrl,
    }) as unknown as RelayerDryRunClient & RelayerSubmitClient;
}

function inferSuiNetwork(grpcUrl: string): "mainnet" | "testnet" | "devnet" | "localnet" {
    if (grpcUrl.includes("mainnet")) {
        return "mainnet";
    }

    if (grpcUrl.includes("devnet")) {
        return "devnet";
    }

    if (grpcUrl.includes("127.0.0.1") || grpcUrl.includes("localhost")) {
        return "localnet";
    }

    return "testnet";
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function cloneMoveArguments(
    args: [string, number[], number[], number[]],
): [string, number[], number[], number[]] {
    return [args[0], [...args[1]], [...args[2]], [...args[3]]];
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
