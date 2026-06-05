import { decodeSuiPrivateKey, type Signer } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import {
    IDENTITY_PROVIDER_BCS,
    IDENTITY_RESULT_INTENT,
    type IdentityProvider,
    type IdentityVerificationResult,
} from "@sonari/membership-verifier-shared";
import {
    createSuiEnclaveRegistrationTransaction,
    type EnclaveRegistrationEvent,
    type EnclaveRegistrationExecutionResponse,
    type EnclaveVerificationMetadata,
    isHexBytes,
    normalizeHex,
    parseHexByteVector,
    readEnclaveRegistrationMetadata,
} from "@sonari/verifier-contracts";

export const RELAYER_SUBMIT_FAILED = "RELAYER_SUBMIT_FAILED";
export const MOVE_REJECTED = "MOVE_REJECTED";

export type IdentityVerificationSuiErrorCode = typeof RELAYER_SUBMIT_FAILED | typeof MOVE_REJECTED;

export type IdentityVerificationSuiResult<T> =
    | { ok: true; value: T }
    | {
          ok: false;
          error_code: IdentityVerificationSuiErrorCode;
          message: string;
          digest?: string | undefined;
      };

export type SuiNetwork = "mainnet" | "testnet" | "devnet";
export type IdentityVerificationRelayerMode = "dry_run" | "submit";
export type IdentityVerificationSigner = Signer;

export interface IdentityVerificationSubmitConfig {
    readonly packageId: string;
    readonly pauseStateId: string;
    readonly identityRegistryId: string;
    readonly membershipRegistryId: string;
    readonly verifierRegistryId: string;
    readonly clockId: string;
    readonly network?: SuiNetwork;
    readonly grpcUrl?: string;
    readonly senderAddress?: string;
    readonly allowSubmit?: boolean;
    readonly signer?: IdentityVerificationSigner;
    readonly client?: IdentityVerificationSubmitClient;
    readonly transaction?: unknown;
}

export interface IdentityVerificationSuiRequest {
    readonly target: string;
    readonly packageId: string;
    readonly pauseStateId: string;
    readonly identityRegistryId: string;
    readonly membershipRegistryId: string;
    readonly verifierRegistryId: string;
    readonly membershipPassId: string;
    readonly clockId: string;
    readonly arguments: [
        string,
        string,
        string,
        string,
        string,
        string,
        number[],
        number[],
        number[],
    ];
}

export interface IdentityVerificationDryRunSuccess {
    readonly mode: "dry_run";
    readonly request: IdentityVerificationSuiRequest;
    readonly transactionBytes: number[];
    readonly effects: Record<string, unknown>;
}

export interface IdentityVerificationSubmitSuccess {
    readonly mode: "submit";
    readonly request: IdentityVerificationSuiRequest;
    readonly digest: string;
    readonly effects: Record<string, unknown>;
    readonly readback: MembershipPassReadback;
}

export interface MembershipPassReadback {
    readonly objectId: string;
    readonly identityVerified: true;
    readonly identityProviderMask: number;
    readonly identityVerifiedAtMs: number;
    readonly identityExpiresAtMs: number;
    readonly termsVersion: number;
    readonly signedStatementHash: string;
}

export interface IdentityVerificationSubmitTransaction {
    build(input: { client: unknown }): Promise<Uint8Array>;
}

export interface IdentityVerificationSubmitClient {
    simulateTransaction(input: {
        transaction: Uint8Array;
        include: { effects: true };
    }): Promise<IdentityVerificationExecutionResponse>;
    signAndExecuteTransaction(input: {
        transaction: unknown;
        signer: IdentityVerificationSigner;
        include: { effects: true; events: true; objectTypes: true };
    }): Promise<IdentityVerificationExecutionResponse>;
    waitForTransaction(input: { digest: string }): Promise<unknown>;
    getObject(input: { objectId: string; include: { json: true } }): Promise<unknown>;
}

export type IdentityVerificationExecutionResponse =
    | {
          $kind: "Transaction";
          Transaction: IdentityVerificationTransactionResult;
          FailedTransaction?: never;
      }
    | {
          $kind: "FailedTransaction";
          Transaction?: never;
          FailedTransaction: IdentityVerificationTransactionResult;
      }
    | Record<string, unknown>;

export interface IdentityVerificationTransactionResult {
    readonly digest?: string;
    readonly status?: IdentityVerificationExecutionStatus;
    readonly effects?: Record<string, unknown>;
}

export type IdentityVerificationExecutionStatus =
    | { readonly success: true; readonly error: null }
    | { readonly success: false; readonly error?: { readonly message?: string } | string | null };

interface ParsedSignedIdentityPayload {
    readonly payloadBcsBytes: number[];
    readonly signatureBytes: number[];
    readonly publicKeyBytes: number[];
    readonly membershipIdBytes: number[];
}

interface NormalizedTransactionResult {
    readonly digest?: string;
    readonly effects: Record<string, unknown>;
}

const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;

export function createEd25519SuiSignerFromPrivateKey(value: string): Ed25519Keypair {
    const decoded = decodeSuiPrivateKey(value);
    if (decoded.scheme !== "ED25519") {
        throw new Error("Only Ed25519 Sui private keys are supported for membership submit");
    }

    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
}

export function buildIdentityVerificationSuiRequest(
    input: unknown,
    config: IdentityVerificationSubmitConfig,
): IdentityVerificationSuiResult<IdentityVerificationSuiRequest> {
    const parsed = parseSignedIdentityPayload(input);
    if (!parsed.ok) {
        return parsed;
    }
    const configResult = validateRequestConfig(config);
    if (!configResult.ok) {
        return configResult;
    }

    // membership_id from the verified result is used as the dynamic membershipPassId (Sui object id)
    const membershipPassId = `0x${Buffer.from(parsed.value.membershipIdBytes).toString("hex")}`;
    const target = `${config.packageId}::accessor::update_identity_verification`;
    const args: IdentityVerificationSuiRequest["arguments"] = [
        config.pauseStateId,
        config.identityRegistryId,
        config.membershipRegistryId,
        config.verifierRegistryId,
        membershipPassId,
        config.clockId,
        [...parsed.value.payloadBcsBytes],
        [...parsed.value.signatureBytes],
        [...parsed.value.publicKeyBytes],
    ];

    return {
        ok: true,
        value: {
            target,
            packageId: config.packageId,
            pauseStateId: config.pauseStateId,
            identityRegistryId: config.identityRegistryId,
            membershipRegistryId: config.membershipRegistryId,
            verifierRegistryId: config.verifierRegistryId,
            membershipPassId,
            clockId: config.clockId,
            arguments: args,
        },
    };
}

export async function dryRunIdentityVerificationSubmit(
    input: unknown,
    config: IdentityVerificationSubmitConfig,
): Promise<IdentityVerificationSuiResult<IdentityVerificationDryRunSuccess>> {
    const request = buildIdentityVerificationSuiRequest(input, config);
    if (!request.ok) {
        return request;
    }
    if (
        config.network === undefined ||
        config.grpcUrl === undefined ||
        config.senderAddress === undefined
    ) {
        return relayerSubmitFailed("dry_run requires network, grpcUrl, and senderAddress");
    }
    const network = validateSuiNetworkGrpcUrl(config.network, config.grpcUrl);
    if (!network.ok) {
        return network;
    }

    try {
        const client = config.client ?? createSuiGrpcClient(config.grpcUrl, config.network);
        const transaction = (config.transaction ??
            createIdentityVerificationTransaction(request.value, {
                senderAddress: config.senderAddress,
            })) as IdentityVerificationSubmitTransaction;
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
                mode: "dry_run",
                request: request.value,
                transactionBytes: Array.from(transactionBytes),
                effects: result.value.effects,
            },
        };
    } catch (error) {
        return relayerSubmitFailed(errorMessage(error));
    }
}

export async function submitIdentityVerificationPayload(
    input: unknown,
    config: IdentityVerificationSubmitConfig,
): Promise<IdentityVerificationSuiResult<IdentityVerificationSubmitSuccess>> {
    const request = buildIdentityVerificationSuiRequest(input, config);
    if (!request.ok) {
        return request;
    }
    if (config.allowSubmit !== true) {
        return relayerSubmitFailed("submit requires RELAYER_ALLOW_SUBMIT=true");
    }
    if (config.network === undefined || config.grpcUrl === undefined) {
        return relayerSubmitFailed("submit requires network and grpcUrl");
    }
    const network = validateSuiNetworkGrpcUrl(config.network, config.grpcUrl);
    if (!network.ok) {
        return network;
    }
    if (config.signer === undefined) {
        return relayerSubmitFailed("submit requires signer material");
    }
    const expectedReadback = parseExpectedIdentityVerificationResult(input);
    if (!expectedReadback.ok) {
        return expectedReadback;
    }

    try {
        const senderAddress = config.signer.toSuiAddress();
        if (!isNonEmptyString(senderAddress)) {
            return relayerSubmitFailed("Signer did not provide a sender address");
        }
        if (config.senderAddress !== undefined && config.senderAddress !== senderAddress) {
            return relayerSubmitFailed("Signer address does not match RELAYER_SENDER_ADDRESS");
        }
        const client = config.client ?? createSuiGrpcClient(config.grpcUrl, config.network);
        const transaction =
            config.transaction ??
            createIdentityVerificationTransaction(request.value, {
                senderAddress,
            });
        const response = await client.signAndExecuteTransaction({
            transaction,
            signer: config.signer,
            include: { effects: true, events: true, objectTypes: true },
        });
        const result = normalizeTransactionResult(response);
        if (!result.ok) {
            return result;
        }
        if (!isNonEmptyString(result.value.digest)) {
            return relayerSubmitFailed("Sui response did not include transaction digest");
        }
        let readback: IdentityVerificationSuiResult<MembershipPassReadback>;
        try {
            await client.waitForTransaction({ digest: result.value.digest });
            const object = await client.getObject({
                objectId: request.value.membershipPassId,
                include: { json: true },
            });
            readback = parseMembershipPassReadback(
                object,
                expectedReadback.value,
                config.packageId,
            );
        } catch (error) {
            return relayerSubmitFailedWithDigest(errorMessage(error), result.value.digest);
        }
        if (!readback.ok) {
            return { ...readback, digest: result.value.digest };
        }

        return {
            ok: true,
            value: {
                mode: "submit",
                request: request.value,
                digest: result.value.digest,
                effects: result.value.effects,
                readback: readback.value,
            },
        };
    } catch (error) {
        return relayerSubmitFailed(errorMessage(error));
    }
}

export function createIdentityVerificationTransaction(
    request: IdentityVerificationSuiRequest,
    options: { senderAddress: string },
): Transaction {
    const tx = new Transaction();
    tx.setSender(options.senderAddress);
    tx.moveCall({
        target: request.target,
        arguments: [
            tx.object(request.pauseStateId),
            tx.object(request.identityRegistryId),
            tx.object(request.membershipRegistryId),
            tx.object(request.verifierRegistryId),
            tx.object(request.membershipPassId),
            tx.object(request.clockId),
            tx.pure.vector("u8", request.arguments[6]),
            tx.pure.vector("u8", request.arguments[7]),
            tx.pure.vector("u8", request.arguments[8]),
        ],
    });
    return tx;
}

export function parseMembershipPassReadback(
    input: unknown,
    expected: IdentityVerificationResult,
    expectedPackageId: string,
): IdentityVerificationSuiResult<MembershipPassReadback> {
    const object = parseSuiObjectReadback(input);
    if (!object.ok) {
        return object;
    }
    if (object.value.objectId !== expected.membership_id) {
        return relayerSubmitFailed(
            `MembershipPass readback id mismatch: expected ${expected.membership_id}`,
        );
    }
    const expectedType = `${expectedPackageId}::membership::MembershipPass`;
    if (object.value.type !== expectedType) {
        return relayerSubmitFailed(
            `MembershipPass readback type mismatch: expected ${expectedType}`,
        );
    }

    const fields = object.value.fields;
    const identityVerified = readBooleanField(fields.identity_verified, "identity_verified");
    if (!identityVerified.ok) {
        return identityVerified;
    }
    if (!identityVerified.value) {
        return relayerSubmitFailed("MembershipPass readback identity_verified was not true");
    }

    const providerMask = readU8Field(fields.identity_provider_mask, "identity_provider_mask");
    if (!providerMask.ok) {
        return providerMask;
    }
    const providerBit = providerBitFor(expected.provider);
    if ((providerMask.value & providerBit) !== providerBit) {
        return relayerSubmitFailed(
            "MembershipPass readback provider mask does not include payload provider",
        );
    }

    const verifiedAtMs = readU64Field(fields.identity_verified_at_ms, "identity_verified_at_ms");
    if (!verifiedAtMs.ok) {
        return verifiedAtMs;
    }
    if (verifiedAtMs.value !== expected.issued_at_ms) {
        return relayerSubmitFailed(
            "MembershipPass readback verified timestamp does not match payload",
        );
    }

    const expiresAtMs = readU64Field(fields.identity_expires_at_ms, "identity_expires_at_ms");
    if (!expiresAtMs.ok) {
        return expiresAtMs;
    }
    if (expiresAtMs.value !== expected.expires_at_ms) {
        return relayerSubmitFailed(
            "MembershipPass readback expiry timestamp does not match payload",
        );
    }

    const termsVersion = readU64Field(fields.terms_version, "terms_version");
    if (!termsVersion.ok) {
        return termsVersion;
    }
    if (termsVersion.value !== expected.terms_version) {
        return relayerSubmitFailed("MembershipPass readback terms_version does not match payload");
    }

    const signedStatementHash = readHex32Field(
        fields.signed_statement_hash,
        "signed_statement_hash",
    );
    if (!signedStatementHash.ok) {
        return signedStatementHash;
    }
    if (signedStatementHash.value !== expected.signed_statement_hash.toLowerCase()) {
        return relayerSubmitFailed(
            "MembershipPass readback signed_statement_hash does not match payload",
        );
    }

    return {
        ok: true,
        value: {
            objectId: object.value.objectId,
            identityVerified: true,
            identityProviderMask: providerMask.value,
            identityVerifiedAtMs: verifiedAtMs.value,
            identityExpiresAtMs: expiresAtMs.value,
            termsVersion: termsVersion.value,
            signedStatementHash: signedStatementHash.value,
        },
    };
}

function parseSignedIdentityPayload(
    input: unknown,
): IdentityVerificationSuiResult<ParsedSignedIdentityPayload> {
    if (!isRecord(input) || input.status !== "verified") {
        return relayerSubmitFailed("Expected verified membership TEE result");
    }
    if (
        typeof input.payload_bcs_hex !== "string" ||
        typeof input.signature !== "string" ||
        typeof input.public_key !== "string"
    ) {
        return relayerSubmitFailed(
            "Verified membership TEE result requires payload_bcs_hex, signature, and public_key",
        );
    }

    const payloadBcsBytes = parseHexBytes(input.payload_bcs_hex, "payload_bcs_hex");
    if (!payloadBcsBytes.ok) {
        return payloadBcsBytes;
    }
    const signatureBytes = parseHexBytes(input.signature, "signature", ED25519_SIGNATURE_BYTES);
    if (!signatureBytes.ok) {
        return signatureBytes;
    }
    const publicKeyBytes = parseHexBytes(input.public_key, "public_key", ED25519_PUBLIC_KEY_BYTES);
    if (!publicKeyBytes.ok) {
        return publicKeyBytes;
    }
    // membership_id is a Sui object id (32 bytes) used as the dynamic membershipPassId
    if (typeof input.membership_id !== "string") {
        return relayerSubmitFailed("Verified membership TEE result requires membership_id");
    }
    const SUI_OBJECT_ID_BYTES = 32;
    const membershipIdBytes = parseHexBytes(
        input.membership_id,
        "membership_id",
        SUI_OBJECT_ID_BYTES,
    );
    if (!membershipIdBytes.ok) {
        return membershipIdBytes;
    }

    return {
        ok: true,
        value: {
            payloadBcsBytes: payloadBcsBytes.value,
            signatureBytes: signatureBytes.value,
            publicKeyBytes: publicKeyBytes.value,
            membershipIdBytes: membershipIdBytes.value,
        },
    };
}

function parseExpectedIdentityVerificationResult(
    input: unknown,
): IdentityVerificationSuiResult<IdentityVerificationResult> {
    if (!isRecord(input) || input.status !== "verified") {
        return relayerSubmitFailed("Expected verified membership TEE result");
    }
    const intent = readExpectedString(input.intent, "intent");
    if (!intent.ok) {
        return intent;
    }
    if (intent.value !== IDENTITY_RESULT_INTENT) {
        return relayerSubmitFailed(`intent must be ${IDENTITY_RESULT_INTENT}`);
    }
    const verifierFamily = readExpectedString(input.verifier_family, "verifier_family");
    if (!verifierFamily.ok) {
        return verifierFamily;
    }
    if (verifierFamily.value !== "identity") {
        return relayerSubmitFailed("verifier_family must be identity");
    }
    const verifierVersion = readExpectedU64(input.verifier_version, "verifier_version");
    if (!verifierVersion.ok) {
        return verifierVersion;
    }
    const registryId = readExpectedHex32(input.registry_id, "registry_id");
    if (!registryId.ok) {
        return registryId;
    }
    const membershipId = readExpectedHex32(input.membership_id, "membership_id");
    if (!membershipId.ok) {
        return membershipId;
    }
    const owner = readExpectedHex32(input.owner, "owner");
    if (!owner.ok) {
        return owner;
    }
    const provider = readExpectedProvider(input.provider);
    if (!provider.ok) {
        return provider;
    }
    if (input.verified !== true) {
        return relayerSubmitFailed("verified must be true");
    }
    const duplicateKeyHash = readExpectedHex32(input.duplicate_key_hash, "duplicate_key_hash");
    if (!duplicateKeyHash.ok) {
        return duplicateKeyHash;
    }
    const evidenceHash = readExpectedHex32(input.evidence_hash, "evidence_hash");
    if (!evidenceHash.ok) {
        return evidenceHash;
    }
    const issuedAtMs = readExpectedU64(input.issued_at_ms, "issued_at_ms");
    if (!issuedAtMs.ok) {
        return issuedAtMs;
    }
    const expiresAtMs = readExpectedU64(input.expires_at_ms, "expires_at_ms");
    if (!expiresAtMs.ok) {
        return expiresAtMs;
    }
    const termsVersion = readExpectedU64(input.terms_version, "terms_version");
    if (!termsVersion.ok) {
        return termsVersion;
    }
    const signedStatementHash = readExpectedHex32(
        input.signed_statement_hash,
        "signed_statement_hash",
    );
    if (!signedStatementHash.ok) {
        return signedStatementHash;
    }

    return {
        ok: true,
        value: {
            intent: intent.value,
            verifier_family: "identity",
            verifier_version: verifierVersion.value,
            registry_id: registryId.value,
            membership_id: membershipId.value,
            owner: owner.value,
            provider: provider.value,
            verified: true,
            duplicate_key_hash: duplicateKeyHash.value,
            evidence_hash: evidenceHash.value,
            issued_at_ms: issuedAtMs.value,
            expires_at_ms: expiresAtMs.value,
            terms_version: termsVersion.value,
            signed_statement_hash: signedStatementHash.value,
        },
    };
}

function validateRequestConfig(
    config: IdentityVerificationSubmitConfig,
): IdentityVerificationSuiResult<IdentityVerificationSubmitConfig> {
    const missing = [
        ["packageId", config.packageId],
        ["pauseStateId", config.pauseStateId],
        ["identityRegistryId", config.identityRegistryId],
        ["membershipRegistryId", config.membershipRegistryId],
        ["verifierRegistryId", config.verifierRegistryId],
        ["clockId", config.clockId],
    ]
        .filter(([, value]) => !isNonEmptyString(value))
        .map(([name]) => name);
    if (missing.length > 0) {
        return relayerSubmitFailed(`Sui submission config missing: ${missing.join(", ")}`);
    }
    return { ok: true, value: config };
}

function parseHexBytes(
    value: string,
    fieldName: string,
    expectedLength?: number,
): IdentityVerificationSuiResult<number[]> {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
        return relayerSubmitFailed(`${fieldName} must be 0x-prefixed even-length hex bytes`);
    }
    const bytes = Array.from(Buffer.from(value.slice(2), "hex"));
    if (expectedLength !== undefined && bytes.length !== expectedLength) {
        return relayerSubmitFailed(`${fieldName} must be ${expectedLength} bytes`);
    }
    return { ok: true, value: bytes };
}

function readExpectedString(
    input: unknown,
    fieldName: string,
): IdentityVerificationSuiResult<string> {
    if (typeof input === "string" && input.length > 0) {
        return { ok: true, value: input };
    }
    return relayerSubmitFailed(`Verified membership TEE result requires ${fieldName}`);
}

function readExpectedProvider(input: unknown): IdentityVerificationSuiResult<IdentityProvider> {
    if (input === "kyc" || input === "world_id") {
        return { ok: true, value: input };
    }
    return relayerSubmitFailed("provider must be kyc or world_id");
}

function readExpectedU64(input: unknown, fieldName: string): IdentityVerificationSuiResult<number> {
    if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0) {
        return { ok: true, value: input };
    }
    return relayerSubmitFailed(`${fieldName} must be a safe unsigned integer`);
}

function readExpectedHex32(
    input: unknown,
    fieldName: string,
): IdentityVerificationSuiResult<string> {
    if (typeof input === "string" && /^0x[0-9a-fA-F]{64}$/.test(input)) {
        return { ok: true, value: input.toLowerCase() };
    }
    return relayerSubmitFailed(`${fieldName} must be a 32-byte 0x-prefixed hex string`);
}

function createSuiGrpcClient(
    grpcUrl: string,
    network: SuiNetwork,
): IdentityVerificationSubmitClient {
    return new SuiGrpcClient({
        network,
        baseUrl: grpcUrl,
    }) as unknown as IdentityVerificationSubmitClient;
}

function validateSuiNetworkGrpcUrl(
    network: unknown,
    grpcUrl: unknown,
): IdentityVerificationSuiResult<SuiNetwork> {
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

function normalizeTransactionResult(
    response: IdentityVerificationExecutionResponse,
): IdentityVerificationSuiResult<NormalizedTransactionResult> {
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
        return {
            ok: true,
            value: {
                effects: transaction.effects,
                ...(typeof transaction.digest === "string" ? { digest: transaction.digest } : {}),
            },
        };
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

function readExecutionStatus(
    value: unknown,
):
    | { readonly success: true; readonly errorMessage?: undefined }
    | { readonly success: false; readonly errorMessage?: string }
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

function relayerSubmitFailed<T = never>(message: string): IdentityVerificationSuiResult<T> {
    return { ok: false, error_code: RELAYER_SUBMIT_FAILED, message };
}

function relayerSubmitFailedWithDigest<T = never>(
    message: string,
    digest: string,
): IdentityVerificationSuiResult<T> {
    return { ok: false, error_code: RELAYER_SUBMIT_FAILED, message, digest };
}

function moveRejected<T = never>(message: string): IdentityVerificationSuiResult<T> {
    return { ok: false, error_code: MOVE_REJECTED, message };
}

interface SuiObjectReadback {
    readonly objectId: string;
    readonly type: string;
    readonly fields: Record<string, unknown>;
}

function parseSuiObjectReadback(input: unknown): IdentityVerificationSuiResult<SuiObjectReadback> {
    if (!isRecord(input)) {
        return relayerSubmitFailed("MembershipPass readback response was not an object");
    }
    const data = isRecord(input.data) ? input.data : isRecord(input.object) ? input.object : input;
    const objectId = readStringAlias(data, ["objectId", "object_id"], "object id");
    if (!objectId.ok) {
        return objectId;
    }
    const type = readStringAlias(data, ["type"], "object type");
    if (!type.ok) {
        return type;
    }
    const content = data.content;
    const fields = isRecord(content) && isRecord(content.fields) ? content.fields : data.json;
    if (!isRecord(fields)) {
        return relayerSubmitFailed(
            "MembershipPass readback response did not include object fields",
        );
    }
    return {
        ok: true,
        value: {
            objectId: objectId.value,
            type: type.value,
            fields,
        },
    };
}

function readStringAlias(
    input: Record<string, unknown>,
    aliases: readonly string[],
    fieldName: string,
): IdentityVerificationSuiResult<string> {
    for (const alias of aliases) {
        const value = input[alias];
        if (typeof value === "string" && value.length > 0) {
            return { ok: true, value };
        }
    }
    return relayerSubmitFailed(`MembershipPass readback missing ${fieldName}`);
}

function readBooleanField(
    input: unknown,
    fieldName: string,
): IdentityVerificationSuiResult<boolean> {
    if (typeof input === "boolean") {
        return { ok: true, value: input };
    }
    return relayerSubmitFailed(`MembershipPass readback ${fieldName} must be boolean`);
}

function readU8Field(input: unknown, fieldName: string): IdentityVerificationSuiResult<number> {
    const value = readU64Field(input, fieldName);
    if (!value.ok) {
        return value;
    }
    if (value.value > 0xff) {
        return relayerSubmitFailed(`MembershipPass readback ${fieldName} must fit in u8`);
    }
    return value;
}

function readU64Field(input: unknown, fieldName: string): IdentityVerificationSuiResult<number> {
    if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0) {
        return { ok: true, value: input };
    }
    if (typeof input === "string" && /^(?:0|[1-9][0-9]*)$/.test(input)) {
        const value = Number(input);
        if (Number.isSafeInteger(value)) {
            return { ok: true, value };
        }
    }
    return relayerSubmitFailed(`MembershipPass readback ${fieldName} must be a safe u64`);
}

function readHex32Field(input: unknown, fieldName: string): IdentityVerificationSuiResult<string> {
    if (typeof input === "string" && /^0x[0-9a-fA-F]{64}$/.test(input)) {
        return { ok: true, value: input.toLowerCase() };
    }
    if (
        Array.isArray(input) &&
        input.length === 32 &&
        input.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff)
    ) {
        return {
            ok: true,
            value: `0x${input
                .map((byte) => (byte as number).toString(16).padStart(2, "0"))
                .join("")}`,
        };
    }
    return relayerSubmitFailed(`MembershipPass readback ${fieldName} must be 32-byte hex`);
}

function providerBitFor(provider: IdentityProvider): number {
    return IDENTITY_PROVIDER_BCS[provider];
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ============================================================
// Enclave registration (case A: real submit)
// ============================================================

export const IDENTITY_VERIFIER_CONFIG_KEY = 2;
export const IDENTITY_VERIFIER_FAMILY = 4;
export const IDENTITY_VERIFIER_VERSION = 1;

export type SuiEnclaveRegistrationEvent = EnclaveRegistrationEvent;
export type SuiEnclaveRegistrationExecutionResponse = EnclaveRegistrationExecutionResponse;

export interface SuiEnclaveRegistrationClient {
    signAndExecuteTransaction(input: {
        transaction: unknown;
        signer: IdentityVerificationSigner;
        include: { effects: true; events: true };
    }): Promise<SuiEnclaveRegistrationExecutionResponse>;
}

export interface SuiEnclaveRegistrationConfig {
    readonly target: string;
    readonly verifierRegistry: string;
    readonly allowSubmit: boolean;
    readonly instanceTtlMs: number;
    readonly configurationError?: string | undefined;
    readonly signer?: IdentityVerificationSigner | undefined;
    readonly client?: SuiEnclaveRegistrationClient | undefined;
    readonly transaction?: unknown;
    readonly loadSigner?: (() => Promise<IdentityVerificationSigner>) | undefined;
    readonly network?: SuiNetwork | undefined;
    readonly grpcUrl?: string | undefined;
    readonly senderAddress?: string | undefined;
    readonly now?: (() => number) | undefined;
}

/**
 * Case A: enclave register is always a real submit (no dry-run).
 * update_identity_verification semantics are unchanged.
 */
export class SuiEnclaveRegistrationAdapter {
    constructor(private readonly config: SuiEnclaveRegistrationConfig) {}

    async register(input: {
        jobId: string;
        attestationDocumentHex: string;
        publicKey: string;
    }): Promise<EnclaveVerificationMetadata> {
        if (this.config.configurationError !== undefined) {
            throw new Error(this.config.configurationError);
        }
        if (!this.config.allowSubmit) {
            throw new Error(
                "enclave registration requires allowSubmit=true (case A: register is always real submit)",
            );
        }
        const network = this.config.network;
        const grpcUrl = this.config.grpcUrl;

        if (!isHexBytes(input.attestationDocumentHex)) {
            throw new Error("attestation_document_hex must be hex encoded");
        }
        if (!isHexBytes(input.publicKey, 32)) {
            throw new Error("attestation public_key must be 32 bytes");
        }
        if (!Number.isSafeInteger(this.config.instanceTtlMs) || this.config.instanceTtlMs <= 0) {
            throw new Error("instanceTtlMs must be a positive safe integer");
        }

        const signer = this.config.signer ?? (await this.config.loadSigner?.());
        const resolvedSenderAddress =
            signer !== undefined ? signer.toSuiAddress() : this.config.senderAddress;
        if (!isNonEmptyString(resolvedSenderAddress)) {
            throw new Error(
                "enclave registration requires a signer or senderAddress with a valid Sui address",
            );
        }

        const nowMs = this.config.now?.() ?? Date.now();
        const expiresAtMs = nowMs + this.config.instanceTtlMs;
        if (!Number.isSafeInteger(expiresAtMs)) {
            throw new Error("enclave instance expiry exceeded safe integer range");
        }

        const client: SuiEnclaveRegistrationClient =
            this.config.client ??
            (() => {
                if (!isNonEmptyString(network) || !isNonEmptyString(grpcUrl)) {
                    throw new Error(
                        "enclave registration requires network and grpcUrl when no client is provided",
                    );
                }
                return new SuiGrpcClient({
                    network: network as SuiNetwork,
                    baseUrl: grpcUrl,
                }) as unknown as SuiEnclaveRegistrationClient;
            })();

        const transaction =
            this.config.transaction ??
            createSuiEnclaveRegistrationTransaction({
                target: this.config.target,
                verifierRegistry: this.config.verifierRegistry,
                attestationDocumentBytes: parseHexByteVector(input.attestationDocumentHex),
                expiresAtMs,
                senderAddress: resolvedSenderAddress,
                configKey: IDENTITY_VERIFIER_CONFIG_KEY,
            });

        // Case A: always real submit, never dry-run
        const resolvedSigner = signer;
        if (resolvedSigner === undefined) {
            throw new Error(
                "enclave registration requires a signer (loadSigner or signer) for real submit",
            );
        }

        const response = await client.signAndExecuteTransaction({
            transaction,
            signer: resolvedSigner,
            include: { effects: true, events: true },
        });

        const events = readSuccessfulEnclaveRegistrationEvents(response);
        const metadata = readEnclaveRegistrationMetadata(events, {
            expectedFamily: IDENTITY_VERIFIER_FAMILY,
            expectedVersion: IDENTITY_VERIFIER_VERSION,
            configKey: IDENTITY_VERIFIER_CONFIG_KEY,
        });

        if (normalizeHex(metadata.enclave_instance_public_key) !== normalizeHex(input.publicKey)) {
            throw new Error("registered enclave public key does not match attestation");
        }

        return metadata;
    }
}

function readSuccessfulEnclaveRegistrationEvents(
    response: SuiEnclaveRegistrationExecutionResponse,
): SuiEnclaveRegistrationEvent[] {
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
        ? (response.Transaction.events as SuiEnclaveRegistrationEvent[]).filter(isRecord)
        : [];
}

function readEnclaveExecutionStatus(
    value: unknown,
):
    | { readonly success: true; readonly errorMessage?: undefined }
    | { readonly success: false; readonly errorMessage?: string }
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

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isNonEmptyString(input: unknown): input is string {
    return typeof input === "string" && input.length > 0;
}
