import { readFileSync } from "node:fs";
import { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";
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
    rpcUrl: string;
    senderAddress: string;
    client?: RelayerDryRunClient;
    transaction?: RelayerTransaction;
}

export interface RelayerSubmitConfig extends RelayerRequestConfig {
    rpcUrl: string;
    signer?: RelayerSigner;
    client?: RelayerSubmitClient;
    transaction?: unknown;
}

export interface RelayerSigner {
    toSuiAddress(): string;
}

export interface RelayerTransaction {
    build(input: { client: unknown }): Promise<Uint8Array>;
}

export interface RelayerDryRunClient {
    dryRunTransactionBlock(input: {
        transactionBlock: Uint8Array;
    }): Promise<RelayerExecutionResponse>;
}

export interface RelayerSubmitClient {
    signAndExecuteTransaction(input: {
        transaction: unknown;
        signer: RelayerSigner;
        options: { showEffects: true };
    }): Promise<RelayerExecutionResponse>;
}

export interface RelayerExecutionResponse {
    digest?: string;
    effects?: {
        status?: {
            status?: string;
            error?: string;
        };
    };
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
    effects: NonNullable<RelayerExecutionResponse["effects"]>;
}

export interface RelayerSubmitSuccess {
    request: RelayerRequestPreview;
    digest?: string;
    effects: NonNullable<RelayerExecutionResponse["effects"]>;
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

    if (!isNonEmptyString(config.rpcUrl) || !isNonEmptyString(config.senderAddress)) {
        return relayerSubmitFailed("Dry-run requires rpcUrl and senderAddress");
    }

    try {
        const client = config.client ?? createSuiClient(config.rpcUrl);
        const transaction = (config.transaction ??
            createSuiSubmitTransaction(preview.value, {
                senderAddress: config.senderAddress,
            })) as RelayerTransaction;
        const transactionBytes = await transaction.build({ client });
        const response = await client.dryRunTransactionBlock({
            transactionBlock: transactionBytes,
        });
        const effectsResult = normalizeEffects(response);
        if (!effectsResult.ok) {
            return effectsResult;
        }

        return {
            ok: true,
            value: {
                request: preview.value,
                transactionBytes: Array.from(transactionBytes),
                effects: effectsResult.value,
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

    if (!isNonEmptyString(config.rpcUrl) || config.signer === undefined) {
        return relayerSubmitFailed("Submit requires explicit rpcUrl and signer");
    }

    const senderAddress = config.signer.toSuiAddress();
    if (!isNonEmptyString(senderAddress)) {
        return relayerSubmitFailed("Signer did not provide a sender address");
    }

    try {
        const client = config.client ?? createSuiClient(config.rpcUrl);
        const transaction =
            config.transaction ?? createSuiSubmitTransaction(preview.value, { senderAddress });
        const response = await client.signAndExecuteTransaction({
            transaction,
            signer: config.signer,
            options: { showEffects: true },
        });
        const effectsResult = normalizeEffects(response);
        if (!effectsResult.ok) {
            return effectsResult;
        }

        const value: RelayerSubmitSuccess = {
            request: preview.value,
            effects: effectsResult.value,
        };
        if (response.digest !== undefined) {
            value.digest = response.digest;
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

function createSuiClient(rpcUrl: string): RelayerDryRunClient & RelayerSubmitClient {
    return new SuiClient({
        url: rpcUrl,
        network: inferSuiNetwork(rpcUrl),
    }) as unknown as RelayerDryRunClient & RelayerSubmitClient;
}

function inferSuiNetwork(rpcUrl: string): "mainnet" | "testnet" | "devnet" | "localnet" {
    if (rpcUrl.includes("mainnet")) {
        return "mainnet";
    }

    if (rpcUrl.includes("devnet")) {
        return "devnet";
    }

    if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
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

function normalizeEffects(
    response: RelayerExecutionResponse,
): RelayerResult<NonNullable<RelayerExecutionResponse["effects"]>> {
    if (response.effects?.status?.status === "success") {
        return { ok: true, value: response.effects };
    }

    if (response.effects?.status?.status === "failure") {
        return {
            ok: false,
            error_code: MOVE_REJECTED,
            message: response.effects.status.error ?? "Move transaction effects reported failure",
        };
    }

    return relayerSubmitFailed("Sui response did not include transaction effects status");
}

function relayerSubmitFailed<T = never>(message: string): RelayerResult<T> {
    return { ok: false, error_code: RELAYER_SUBMIT_FAILED, message };
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
