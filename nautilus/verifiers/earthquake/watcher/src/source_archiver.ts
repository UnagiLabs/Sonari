import { createHash, timingSafeEqual } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { decodeSuiPrivateKey, type Signer } from "@mysten/sui/cryptography";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { type WriteBlobStep, walrus } from "@mysten/walrus";

const SOURCE_ARTIFACT_PREFIX = "source-artifacts/";
const SOURCE_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const WALRUS_BLOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const SUI_OBJECT_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_SUI_NETWORK: WalrusSdkNetwork = "testnet";
const DEFAULT_SUI_RPC_URL = "https://fullnode.testnet.sui.io:443";
const DEFAULT_WALRUS_UPLOAD_RELAY_URL = "https://upload-relay.testnet.walrus.space";
const DEFAULT_WALRUS_UPLOAD_RELAY_TIP_MAX_MIST = 1_000;
const DEFAULT_WALRUS_EPOCHS = 1;
const DEFAULT_WALRUS_DELETABLE = false;
const SENSITIVE_OUTPUT_LINE_PATTERN =
    /\b(token|secret|private|keystore|wallet|credential|password|api[_-]?key|suiprivkey)\b/iu;
const ERROR_CAUSE_CHAIN_MAX_DEPTH = 5;
const ERROR_STACK_TOP_MAX_LINES = 3;
const ERROR_CAUSE_DIAGNOSTIC_KEYS = [
    "code",
    "errno",
    "syscall",
    "hostname",
    "host",
    "port",
    "address",
    "reason",
    "type",
] as const;

export type SourceArchiverErrorKind = "bad_request" | "configuration" | "integrity" | "retryable";

export class SourceArchiverError extends Error {
    constructor(
        message: string,
        readonly kind: SourceArchiverErrorKind,
        readonly statusCode: number,
    ) {
        super(message);
        this.name = "SourceArchiverError";
    }
}

export interface SourceArchiverRequest {
    artifactS3Key: string;
    expectedWalrusBlobId: string;
    sourceHash: string;
    sizeBytes: number;
}

export interface SourceArtifactS3Reader {
    getObjectBytes(input: { bucket: string; key: string }): Promise<Uint8Array>;
}

export interface VerifiedSourceArtifact {
    request: SourceArchiverRequest;
    bytes: Uint8Array;
}

export interface WalrusStoreResult {
    walrusBlobId: string;
    walrusBlobObjectId?: string;
    walrusTxDigest?: string;
}

export interface WalrusStoreRunner {
    /**
     * Implementations may throw arbitrary errors; storeVerifiedSourceArtifact
     * normalizes them into SourceArchiverError at this interface boundary.
     */
    store(input: VerifiedSourceArtifact): Promise<WalrusStoreResult>;
}

export type WalrusSdkNetwork = "mainnet" | "testnet";

export interface WalrusSdkStoreConfig {
    suiPrivateKey: string;
    suiNetwork?: WalrusSdkNetwork | undefined;
    suiRpcUrl?: string | undefined;
    uploadRelayUrl?: string | undefined;
    uploadRelayTipMaxMist?: number | undefined;
    epochs?: number | undefined;
    deletable?: boolean | undefined;
}

export interface WalrusSdkStoreClient {
    walrus: {
        writeBlob(input: {
            blob: Uint8Array;
            signer: Signer;
            epochs: number;
            deletable: boolean;
            onStep?: (step: WriteBlobStep) => void | Promise<void>;
        }): Promise<{
            blobId: string;
            blobObject: {
                id: string;
            };
        }>;
    };
}

export interface WalrusSdkStoreClientFactory {
    create(input: {
        suiNetwork: WalrusSdkNetwork;
        suiRpcUrl: string;
        uploadRelayUrl: string;
        uploadRelayTipMaxMist: number;
    }): WalrusSdkStoreClient;
}

export interface SourceArchiverHttpEvent {
    body?: string | null;
    isBase64Encoded?: boolean;
    headers?: Record<string, string | undefined> | null;
}

export interface SourceArchiverHttpResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

export interface SecretStringReader {
    getSecretString(secretArn: string): Promise<string>;
}

interface SourceArchiverRequestLogContext {
    artifactS3Key: string;
    sizeBytes: number;
    sourceHash: string;
    expectedWalrusBlobId: string;
}

interface SourceArchiverErrorCauseDiagnostic {
    name: string;
    message: string;
    code?: string;
    errno?: string;
    syscall?: string;
    hostname?: string;
    host?: string;
    port?: string;
    address?: string;
    reason?: string;
    type?: string;
}

export type SourceArchiverHandlerFailureStage =
    | "auth"
    | "request_parse"
    | "load_artifact"
    | "walrus_store"
    | "unexpected";

export type SourceArchiverLogEvent =
    | (SourceArchiverRequestLogContext & {
          event: "source_archiver.walrus_store.start";
          suiNetwork: WalrusSdkNetwork;
          suiRpcUrl: string;
          uploadRelayUrl: string;
          uploadRelayTipMaxMist: number;
          epochs: number;
          deletable: boolean;
      })
    | (SourceArchiverRequestLogContext & {
          event: "source_archiver.walrus_store.success";
          walrusBlobId: string;
          walrusBlobObjectId?: string;
          walrusTxDigest?: string;
          durationMs: number;
      })
    | {
          event: "source_archiver.walrus_store.step";
          step: WriteBlobStep["step"];
          blobId: string;
          blobObjectId?: string;
          txDigest?: string;
          durationMs: number;
      }
    | (SourceArchiverRequestLogContext & {
          event: "source_archiver.walrus_store.failure";
          durationMs: number;
          errorName: string;
          errorMessage: string;
          errorClass: string;
          errorCode?: string;
          errorCauseChain: SourceArchiverErrorCauseDiagnostic[];
          stackTop: string[];
      })
    | (Partial<SourceArchiverRequestLogContext> & {
          event: "source_archiver.handler.failure";
          stage: SourceArchiverHandlerFailureStage;
          errorKind: SourceArchiverErrorKind;
          statusCode: number;
      });

export type SourceArchiverLogger = (event: SourceArchiverLogEvent) => void;

class DefaultWalrusSdkStoreClientFactory implements WalrusSdkStoreClientFactory {
    create(input: {
        suiNetwork: WalrusSdkNetwork;
        suiRpcUrl: string;
        uploadRelayUrl: string;
        uploadRelayTipMaxMist: number;
    }): WalrusSdkStoreClient {
        return new SuiJsonRpcClient({
            url: input.suiRpcUrl,
            network: input.suiNetwork,
        }).$extend(
            walrus({
                uploadRelay: {
                    host: input.uploadRelayUrl,
                    sendTip: { max: input.uploadRelayTipMaxMist },
                },
            }),
        );
    }
}

export class WalrusSdkStoreRunner implements WalrusStoreRunner {
    private readonly signer: Signer;
    private readonly suiNetwork: WalrusSdkNetwork;
    private readonly suiRpcUrl: string;
    private readonly uploadRelayUrl: string;
    private readonly uploadRelayTipMaxMist: number;
    private readonly epochs: number;
    private readonly deletable: boolean;

    constructor(
        config: WalrusSdkStoreConfig,
        private readonly clientFactory: WalrusSdkStoreClientFactory = new DefaultWalrusSdkStoreClientFactory(),
        private readonly logger: SourceArchiverLogger = defaultSourceArchiverLogger,
    ) {
        this.signer = signerFromRawSuiPrivateKey(config.suiPrivateKey);
        this.suiNetwork = validateSuiNetwork(config.suiNetwork ?? DEFAULT_SUI_NETWORK);
        this.suiRpcUrl = validateUrl(config.suiRpcUrl ?? DEFAULT_SUI_RPC_URL, "Sui RPC URL");
        this.uploadRelayUrl = validateUrl(
            config.uploadRelayUrl ?? DEFAULT_WALRUS_UPLOAD_RELAY_URL,
            "Walrus upload relay URL",
        );
        this.uploadRelayTipMaxMist = validateNonNegativeInteger(
            config.uploadRelayTipMaxMist ?? DEFAULT_WALRUS_UPLOAD_RELAY_TIP_MAX_MIST,
            "Walrus upload relay tip max MIST",
        );
        this.epochs = validatePositiveInteger(
            config.epochs ?? DEFAULT_WALRUS_EPOCHS,
            "Walrus epochs",
        );
        this.deletable = config.deletable ?? DEFAULT_WALRUS_DELETABLE;
    }

    async store(input: VerifiedSourceArtifact): Promise<WalrusStoreResult> {
        const startedAt = Date.now();
        const context = sourceArchiverRequestLogContext(input.request);
        this.logger({
            event: "source_archiver.walrus_store.start",
            ...context,
            suiNetwork: this.suiNetwork,
            suiRpcUrl: this.suiRpcUrl,
            uploadRelayUrl: this.uploadRelayUrl,
            uploadRelayTipMaxMist: this.uploadRelayTipMaxMist,
            epochs: this.epochs,
            deletable: this.deletable,
        });

        let registeredBlobObjectId: string | undefined;
        let registeredTxDigest: string | undefined;
        try {
            const client = this.clientFactory.create({
                suiNetwork: this.suiNetwork,
                suiRpcUrl: this.suiRpcUrl,
                uploadRelayUrl: this.uploadRelayUrl,
                uploadRelayTipMaxMist: this.uploadRelayTipMaxMist,
            });
            const result = await client.walrus.writeBlob({
                blob: input.bytes,
                signer: this.signer,
                epochs: this.epochs,
                deletable: this.deletable,
                onStep: (step) => {
                    this.logger(walrusStoreStepLogEvent(step, startedAt));
                    if (step.step !== "registered") {
                        return;
                    }
                    registeredBlobObjectId = step.blobObjectId;
                    registeredTxDigest = step.txDigest;
                },
            });
            const walrusBlobId = validateWalrusBlobIdFromOutput(result.blobId);
            const walrusBlobObjectId = readWalrusBlobObjectId(
                result.blobObject.id,
                registeredBlobObjectId,
            );
            const storeResult = {
                walrusBlobId,
                ...optionalProperty("walrusBlobObjectId", walrusBlobObjectId),
                ...optionalProperty("walrusTxDigest", registeredTxDigest),
            };
            this.logger({
                event: "source_archiver.walrus_store.success",
                ...context,
                ...storeResult,
                durationMs: durationMsSince(startedAt),
            });
            return storeResult;
        } catch (error) {
            if (error instanceof SourceArchiverError) {
                this.logger(walrusStoreFailureLogEvent(context, startedAt, error));
                throw error;
            }
            this.logger(walrusStoreFailureLogEvent(context, startedAt, error));
            const message = error instanceof Error ? error.message : String(error);
            throw new SourceArchiverError(`Walrus SDK store failed: ${message}`, "retryable", 502);
        }
    }
}

export function createSourceArchiverHandler(input: {
    bucket: string;
    s3: SourceArtifactS3Reader;
    walrus: WalrusStoreRunner;
    authToken: () => Promise<string>;
    logger?: SourceArchiverLogger;
}): (event: SourceArchiverHttpEvent) => Promise<SourceArchiverHttpResponse> {
    const logger = input.logger ?? defaultSourceArchiverLogger;
    return async (event) => {
        let stage: SourceArchiverHandlerFailureStage = "auth";
        let request: SourceArchiverRequest | undefined;
        try {
            await verifyArchiverToken(event, input.authToken);
            stage = "request_parse";
            request = parseSourceArchiverEvent(event);
            stage = "load_artifact";
            const artifact = await loadVerifiedSourceArtifact({
                bucket: input.bucket,
                request,
                s3: input.s3,
            });
            stage = "walrus_store";
            const stored = await storeVerifiedSourceArtifact({ artifact, walrus: input.walrus });
            return jsonResponse(200, {
                walrus_blob_id: stored.walrusBlobId,
                ...optionalProperty("walrus_blob_object_id", stored.walrusBlobObjectId),
                ...optionalProperty("walrus_tx_digest", stored.walrusTxDigest),
            });
        } catch (error) {
            if (error instanceof SourceArchiverError) {
                logger({
                    event: "source_archiver.handler.failure",
                    ...(request === undefined ? {} : sourceArchiverRequestLogContext(request)),
                    stage,
                    errorKind: error.kind,
                    statusCode: error.statusCode,
                });
                return jsonResponse(error.statusCode, { error: error.kind });
            }
            logger({
                event: "source_archiver.handler.failure",
                ...(request === undefined ? {} : sourceArchiverRequestLogContext(request)),
                stage: "unexpected",
                errorKind: "retryable",
                statusCode: 500,
            });
            return jsonResponse(500, { error: "retryable" });
        }
    };
}

export async function sourceArchiverHandler(
    event: SourceArchiverHttpEvent,
): Promise<SourceArchiverHttpResponse> {
    const secrets = defaultAwsSecretStringReader();
    const logger = defaultSourceArchiverLogger;
    const handler = createSourceArchiverHandler({
        bucket: requiredEnv("RESULT_BUCKET"),
        s3: defaultAwsSourceArtifactS3Reader(),
        walrus: {
            store: async (artifact) =>
                new WalrusSdkStoreRunner(
                    walrusSdkStoreConfig({
                        suiPrivateKey: await readWalrusPrivateKeySecret(
                            requiredEnv("SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN"),
                            secrets,
                        ),
                        suiNetwork: readSuiNetworkEnv("SUI_NETWORK"),
                        suiRpcUrl: readOptionalStringEnv("SUI_RPC_URL"),
                        uploadRelayUrl: readOptionalStringEnv("WALRUS_UPLOAD_RELAY_URL"),
                        uploadRelayTipMaxMist: readOptionalNonNegativeIntegerEnv(
                            "WALRUS_UPLOAD_RELAY_TIP_MAX_MIST",
                        ),
                        epochs: readOptionalPositiveIntegerEnv("WALRUS_EPOCHS"),
                        deletable: readOptionalBooleanEnv("WALRUS_DELETABLE"),
                    }),
                    defaultWalrusSdkStoreClientFactory(),
                    logger,
                ).store(artifact),
        },
        authToken: () => secrets.getSecretString(requiredEnv("SOURCE_ARCHIVER_TOKEN_SECRET_ARN")),
        logger,
    });
    return handler(event);
}

export function parseSourceArchiverEvent(event: {
    body?: string | null;
    isBase64Encoded?: boolean;
}): SourceArchiverRequest {
    const body = parseEventBody(event);
    if (!isRecord(body)) {
        throw badRequest("archiver request body must be a JSON object");
    }

    const artifactS3Key = readString(body, "artifact_s3_key");
    if (
        !artifactS3Key.startsWith(SOURCE_ARTIFACT_PREFIX) ||
        artifactS3Key.length === SOURCE_ARTIFACT_PREFIX.length
    ) {
        throw badRequest("artifact_s3_key must point to source-artifacts/");
    }

    const expectedWalrusBlobId = readString(body, "expected_walrus_blob_id");
    if (!WALRUS_BLOB_ID_PATTERN.test(expectedWalrusBlobId)) {
        throw badRequest("expected_walrus_blob_id is invalid");
    }

    const sourceHash = readString(body, "source_hash");
    if (!SOURCE_HASH_PATTERN.test(sourceHash)) {
        throw badRequest("source_hash must be lowercase 0x plus 64 hex characters");
    }

    const sizeBytes = body.size_bytes;
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw badRequest("size_bytes must be a safe non-negative integer");
    }

    return {
        artifactS3Key,
        expectedWalrusBlobId,
        sourceHash,
        sizeBytes,
    };
}

export async function loadVerifiedSourceArtifact(input: {
    bucket: string;
    request: SourceArchiverRequest;
    s3: SourceArtifactS3Reader;
}): Promise<VerifiedSourceArtifact> {
    const bytes = await readSourceArtifact(input);
    const sourceHash = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    if (sourceHash !== input.request.sourceHash) {
        throw integrityFailure("source_hash did not match staged artifact bytes");
    }
    if (bytes.byteLength !== input.request.sizeBytes) {
        throw integrityFailure("size_bytes did not match staged artifact bytes");
    }
    return { request: input.request, bytes };
}

export async function storeVerifiedSourceArtifact(input: {
    artifact: VerifiedSourceArtifact;
    walrus: WalrusStoreRunner;
}): Promise<WalrusStoreResult> {
    try {
        const stored = await input.walrus.store(input.artifact);
        if (stored.walrusBlobId !== input.artifact.request.expectedWalrusBlobId) {
            throw integrityFailure("Walrus store result did not match expected blob id");
        }
        return stored;
    } catch (error) {
        if (error instanceof SourceArchiverError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new SourceArchiverError(`Walrus store failed: ${message}`, "retryable", 502);
    }
}

export async function readWalrusPrivateKeySecret(
    secretArn: string,
    reader: SecretStringReader,
): Promise<string> {
    const secret = (await reader.getSecretString(secretArn)).trim();
    if (secret.length === 0) {
        throw sourceArchiverConfigurationError(`${secretArn} must contain a raw Sui private key`);
    }
    if (!secret.startsWith("suiprivkey")) {
        throw sourceArchiverConfigurationError(
            `${secretArn} must contain only a raw suiprivkey value`,
        );
    }
    signerFromRawSuiPrivateKey(secret);
    return secret;
}

function signerFromRawSuiPrivateKey(privateKey: string): Signer {
    const trimmed = privateKey.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("suiprivkey")) {
        throw sourceArchiverConfigurationError(
            "SourceArchiver private key must be a raw suiprivkey",
        );
    }
    try {
        const decoded = decodeSuiPrivateKey(trimmed);
        if (decoded.scheme !== "ED25519") {
            throw sourceArchiverConfigurationError("SourceArchiver private key must use ED25519");
        }
        return Ed25519Keypair.fromSecretKey(decoded.secretKey);
    } catch (error) {
        if (error instanceof SourceArchiverError) {
            throw error;
        }
        throw sourceArchiverConfigurationError("SourceArchiver private key is invalid");
    }
}

function sourceArchiverRequestLogContext(
    request: SourceArchiverRequest,
): SourceArchiverRequestLogContext {
    return {
        artifactS3Key: request.artifactS3Key,
        sizeBytes: request.sizeBytes,
        sourceHash: request.sourceHash,
        expectedWalrusBlobId: request.expectedWalrusBlobId,
    };
}

function walrusStoreFailureLogEvent(
    context: SourceArchiverRequestLogContext,
    startedAt: number,
    error: unknown,
): SourceArchiverLogEvent {
    const errorCode = readDiagnosticStringProperty(error, "code");
    return {
        event: "source_archiver.walrus_store.failure",
        ...context,
        durationMs: durationMsSince(startedAt),
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: redactSensitiveErrorMessage(
            error instanceof Error ? error.message : String(error),
        ),
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
        ...optionalProperty("errorCode", errorCode),
        errorCauseChain: errorCauseChainDiagnostics(error),
        stackTop: errorStackTop(error),
    };
}

function redactSensitiveErrorMessage(message: string): string {
    if (!SENSITIVE_OUTPUT_LINE_PATTERN.test(message)) {
        return message;
    }
    return `[redacted-sensitive-message sha256=${createHash("sha256").update(message).digest("hex")}]`;
}

function walrusStoreStepLogEvent(step: WriteBlobStep, startedAt: number): SourceArchiverLogEvent {
    return {
        event: "source_archiver.walrus_store.step",
        step: step.step,
        blobId: step.blobId,
        ...optionalProperty("blobObjectId", readWalrusStepBlobObjectId(step)),
        ...optionalProperty("txDigest", readWalrusStepTxDigest(step)),
        durationMs: durationMsSince(startedAt),
    };
}

function readWalrusStepBlobObjectId(step: WriteBlobStep): string | undefined {
    if (step.step === "registered" || step.step === "uploaded" || step.step === "certified") {
        return step.blobObjectId;
    }
    return undefined;
}

function readWalrusStepTxDigest(step: WriteBlobStep): string | undefined {
    if (step.step === "registered" || step.step === "uploaded") {
        return step.txDigest;
    }
    return undefined;
}

function errorCauseChainDiagnostics(error: unknown): SourceArchiverErrorCauseDiagnostic[] {
    const diagnostics: SourceArchiverErrorCauseDiagnostic[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < ERROR_CAUSE_CHAIN_MAX_DEPTH; depth += 1) {
        if (current === undefined || current === null) {
            break;
        }
        diagnostics.push(errorCauseDiagnostic(current));
        current = readUnknownProperty(current, "cause");
    }
    return diagnostics;
}

function errorCauseDiagnostic(error: unknown): SourceArchiverErrorCauseDiagnostic {
    return {
        name: error instanceof Error ? error.name : typeof error,
        message: redactSensitiveErrorMessage(
            error instanceof Error ? error.message : String(error),
        ),
        ...errorCauseDiagnosticProperties(error),
    };
}

function errorCauseDiagnosticProperties(
    error: unknown,
): Partial<Pick<SourceArchiverErrorCauseDiagnostic, (typeof ERROR_CAUSE_DIAGNOSTIC_KEYS)[number]>> {
    const diagnostics: Partial<
        Pick<SourceArchiverErrorCauseDiagnostic, (typeof ERROR_CAUSE_DIAGNOSTIC_KEYS)[number]>
    > = {};
    for (const key of ERROR_CAUSE_DIAGNOSTIC_KEYS) {
        const value = readDiagnosticStringProperty(error, key);
        if (value !== undefined) {
            diagnostics[key] = redactSensitiveErrorMessage(value);
        }
    }
    return diagnostics;
}

function errorStackTop(error: unknown): string[] {
    if (!(error instanceof Error) || error.stack === undefined) {
        return [];
    }
    return error.stack
        .split("\n")
        .slice(0, ERROR_STACK_TOP_MAX_LINES)
        .map((line) => redactSensitiveErrorMessage(line));
}

function readDiagnosticStringProperty(error: unknown, key: string): string | undefined {
    const value = readUnknownProperty(error, key);
    if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
    ) {
        return String(value);
    }
    return undefined;
}

function readUnknownProperty(input: unknown, key: string): unknown {
    if (!isRecord(input)) {
        return undefined;
    }
    return input[key];
}

function durationMsSince(startedAt: number): number {
    return Math.max(0, Date.now() - startedAt);
}

function defaultSourceArchiverLogger(event: SourceArchiverLogEvent): void {
    console.log(JSON.stringify(event));
}

function optionalProperty<Key extends string, Value>(
    key: Key,
    value: Value | undefined,
): Partial<Record<Key, Value>> {
    return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

async function readSourceArtifact(input: {
    bucket: string;
    request: SourceArchiverRequest;
    s3: SourceArtifactS3Reader;
}): Promise<Uint8Array> {
    try {
        return await input.s3.getObjectBytes({
            bucket: input.bucket,
            key: input.request.artifactS3Key,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SourceArchiverError(
            `S3 source artifact read failed: ${message}`,
            "retryable",
            502,
        );
    }
}

function parseEventBody(event: { body?: string | null; isBase64Encoded?: boolean }): unknown {
    if (event.body === undefined || event.body === null || event.body.length === 0) {
        throw badRequest("archiver request body is required");
    }
    const text =
        event.isBase64Encoded === true
            ? Buffer.from(event.body, "base64").toString("utf8")
            : event.body;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw badRequest("archiver request body must be valid JSON");
    }
}

async function verifyArchiverToken(
    event: SourceArchiverHttpEvent,
    authToken: () => Promise<string>,
): Promise<void> {
    const expected = (await authToken()).trim();
    const actual = readHeader(event.headers, "x-sonari-source-archiver-token")?.trim();
    if (expected.length === 0 || actual === undefined || !constantTimeEqual(actual, expected)) {
        throw new SourceArchiverError("source archiver token is invalid", "bad_request", 401);
    }
}

function readHeader(
    headers: Record<string, string | undefined> | null | undefined,
    name: string,
): string | undefined {
    if (headers === undefined || headers === null) {
        return undefined;
    }
    const expected = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === expected) {
            return value;
        }
    }
    return undefined;
}

function constantTimeEqual(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return (
        actualBuffer.byteLength === expectedBuffer.byteLength &&
        timingSafeEqual(actualBuffer, expectedBuffer)
    );
}

function jsonResponse(
    statusCode: number,
    body: Record<string, unknown>,
): SourceArchiverHttpResponse {
    return {
        statusCode,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    };
}

class AwsSourceArtifactS3Reader implements SourceArtifactS3Reader {
    private readonly client = new S3Client({});

    async getObjectBytes(input: { bucket: string; key: string }): Promise<Uint8Array> {
        const result = await this.client.send(
            new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
        );
        if (result.Body === undefined) {
            throw new Error(`S3 object was empty: ${input.key}`);
        }
        return result.Body.transformToByteArray();
    }
}

class AwsSecretStringReader implements SecretStringReader {
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

let awsSourceArtifactS3Reader: SourceArtifactS3Reader | undefined;
let awsSecretStringReader: SecretStringReader | undefined;
let walrusSdkStoreClientFactory: WalrusSdkStoreClientFactory | undefined;

function defaultAwsSourceArtifactS3Reader(): SourceArtifactS3Reader {
    awsSourceArtifactS3Reader ??= new AwsSourceArtifactS3Reader();
    return awsSourceArtifactS3Reader;
}

function defaultAwsSecretStringReader(): SecretStringReader {
    awsSecretStringReader ??= new AwsSecretStringReader();
    return awsSecretStringReader;
}

function defaultWalrusSdkStoreClientFactory(): WalrusSdkStoreClientFactory {
    walrusSdkStoreClientFactory ??= new DefaultWalrusSdkStoreClientFactory();
    return walrusSdkStoreClientFactory;
}

function sourceArchiverConfigurationError(message: string): SourceArchiverError {
    return new SourceArchiverError(message, "configuration", 500);
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw sourceArchiverConfigurationError(`${name} is required`);
    }
    return value;
}

function readOptionalStringEnv(name: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value.length === 0 ? undefined : value;
}

function readSuiNetworkEnv(name: string): WalrusSdkNetwork | undefined {
    const value = readOptionalStringEnv(name);
    if (value === undefined) {
        return undefined;
    }
    return validateSuiNetwork(value);
}

function readOptionalPositiveIntegerEnv(name: string): number | undefined {
    const value = readOptionalStringEnv(name);
    if (value === undefined) {
        return undefined;
    }
    return validatePositiveInteger(Number(value), name);
}

function readOptionalNonNegativeIntegerEnv(name: string): number | undefined {
    const value = readOptionalStringEnv(name);
    if (value === undefined) {
        return undefined;
    }
    return validateNonNegativeInteger(Number(value), name);
}

function readOptionalBooleanEnv(name: string): boolean | undefined {
    const value = readOptionalStringEnv(name);
    if (value === undefined) {
        return undefined;
    }
    if (value === "true") {
        return true;
    }
    if (value === "false") {
        return false;
    }
    throw sourceArchiverConfigurationError(`${name} must be true or false`);
}

function walrusSdkStoreConfig(input: WalrusSdkStoreConfig): WalrusSdkStoreConfig {
    return {
        suiPrivateKey: input.suiPrivateKey,
        ...(input.suiNetwork === undefined ? {} : { suiNetwork: input.suiNetwork }),
        ...(input.suiRpcUrl === undefined ? {} : { suiRpcUrl: input.suiRpcUrl }),
        ...(input.uploadRelayUrl === undefined ? {} : { uploadRelayUrl: input.uploadRelayUrl }),
        ...(input.uploadRelayTipMaxMist === undefined
            ? {}
            : { uploadRelayTipMaxMist: input.uploadRelayTipMaxMist }),
        ...(input.epochs === undefined ? {} : { epochs: input.epochs }),
        ...(input.deletable === undefined ? {} : { deletable: input.deletable }),
    };
}

function validateSuiNetwork(value: string): WalrusSdkNetwork {
    if (value === "mainnet" || value === "testnet") {
        return value;
    }
    throw sourceArchiverConfigurationError("SUI_NETWORK must be mainnet or testnet");
}

function validateUrl(value: string, label: string): string {
    const trimmed = value.trim();
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "https:") {
            throw new Error("expected https");
        }
        return trimmed.replace(/\/$/u, "");
    } catch {
        throw sourceArchiverConfigurationError(`${label} must be a valid https URL`);
    }
}

function validatePositiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw sourceArchiverConfigurationError(`${label} must be a positive integer`);
    }
    return value;
}

function validateNonNegativeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw sourceArchiverConfigurationError(`${label} must be a non-negative integer`);
    }
    return value;
}

function readWalrusBlobObjectId(
    returnedBlobObjectId: string | undefined,
    registeredBlobObjectId: string | undefined,
): string | undefined {
    const blobObjectId = returnedBlobObjectId ?? registeredBlobObjectId;
    if (blobObjectId === undefined) {
        return undefined;
    }
    if (!SUI_OBJECT_ID_PATTERN.test(blobObjectId)) {
        throw new SourceArchiverError(
            "Walrus SDK returned an invalid blob object id",
            "retryable",
            502,
        );
    }
    return blobObjectId;
}

function readString(body: Record<string, unknown>, key: string): string {
    const value = body[key];
    if (typeof value !== "string" || value.length === 0) {
        throw badRequest(`${key} is required`);
    }
    return value;
}

function badRequest(message: string): SourceArchiverError {
    return new SourceArchiverError(message, "bad_request", 400);
}

function integrityFailure(message: string): SourceArchiverError {
    return new SourceArchiverError(message, "integrity", 422);
}

function validateWalrusBlobIdFromOutput(blobId: string): string {
    if (!WALRUS_BLOB_ID_PATTERN.test(blobId)) {
        throw new SourceArchiverError("Walrus SDK returned an invalid blob id", "retryable", 502);
    }
    return blobId;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
