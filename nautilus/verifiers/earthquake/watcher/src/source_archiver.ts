import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const SOURCE_ARTIFACT_PREFIX = "source-artifacts/";
const SOURCE_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const WALRUS_BLOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const DEFAULT_WALRUS_STORE_TIMEOUT_MS = 55_000;
const CLI_OUTPUT_SUMMARY_MAX_CHARS = 4096;
const SENSITIVE_OUTPUT_LINE_PATTERN =
    /\b(token|secret|private|keystore|wallet|credential|password|api[_-]?key)\b/iu;

const execFileAsync = promisify(execFile);

export type SourceArchiverErrorKind = "bad_request" | "integrity" | "retryable";

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

export interface WalrusStoreRunner {
    store(input: VerifiedSourceArtifact): Promise<string>;
}

export interface WalrusStoreCommandRunner {
    run(input: {
        cliPath: string;
        args: string[];
        timeoutMs: number;
        env?: Record<string, string>;
    }): Promise<{ stdout: string; stderr: string }>;
}

export interface WalrusCliStoreConfig {
    cliPath: string;
    timeoutMs?: number;
    epochs?: number;
    env?: Record<string, string>;
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

export interface CliOutputSummary {
    text: string;
    truncated: boolean;
}

interface SourceArchiverRequestLogContext {
    artifactS3Key: string;
    sizeBytes: number;
    sourceHash: string;
    expectedWalrusBlobId: string;
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
          cliPath: string;
          timeoutMs: number;
          epochs?: number;
          envKeys: string[];
      })
    | (SourceArchiverRequestLogContext & {
          event: "source_archiver.walrus_store.success";
          walrusBlobId: string;
          durationMs: number;
          stdout: CliOutputSummary;
          stderr: CliOutputSummary;
      })
    | (SourceArchiverRequestLogContext & {
          event: "source_archiver.walrus_store.failure";
          durationMs: number;
          exitCode?: number | string;
          signal?: string;
          killed?: boolean;
          timedOut: boolean;
          errorName: string;
          errorMessage: string;
          stdout: CliOutputSummary;
          stderr: CliOutputSummary;
      })
    | (Partial<SourceArchiverRequestLogContext> & {
          event: "source_archiver.handler.failure";
          stage: SourceArchiverHandlerFailureStage;
          errorKind: SourceArchiverErrorKind;
          statusCode: number;
      });

export type SourceArchiverLogger = (event: SourceArchiverLogEvent) => void;

export class WalrusCliStoreRunner implements WalrusStoreRunner {
    private readonly timeoutMs: number;

    constructor(
        private readonly config: WalrusCliStoreConfig,
        private readonly commandRunner: WalrusStoreCommandRunner = new NodeWalrusStoreCommandRunner(),
        private readonly logger: SourceArchiverLogger = defaultSourceArchiverLogger,
    ) {
        this.timeoutMs = config.timeoutMs ?? DEFAULT_WALRUS_STORE_TIMEOUT_MS;
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
            throw new SourceArchiverError(
                "Walrus store timeout must be a positive integer",
                "retryable",
                500,
            );
        }
        if (
            config.epochs !== undefined &&
            (!Number.isSafeInteger(config.epochs) || config.epochs <= 0)
        ) {
            throw new SourceArchiverError(
                "Walrus store epochs must be a positive integer",
                "retryable",
                500,
            );
        }
    }

    async store(input: VerifiedSourceArtifact): Promise<string> {
        const tempDir = await mkdtemp(path.join(tmpdir(), "sonari-source-archiver-"));
        const artifactPath = path.join(tempDir, "source-artifact.bin");
        const startedAt = Date.now();
        const context = sourceArchiverRequestLogContext(input.request);
        try {
            await writeFile(artifactPath, input.bytes);
            const args = ["store", artifactPath];
            if (this.config.epochs !== undefined) {
                args.push("--epochs", String(this.config.epochs));
            }
            const commandInput: {
                cliPath: string;
                args: string[];
                timeoutMs: number;
                env?: Record<string, string>;
            } = {
                cliPath: this.config.cliPath,
                args,
                timeoutMs: this.timeoutMs,
            };
            if (this.config.env !== undefined) {
                commandInput.env = this.config.env;
            }
            this.logger({
                event: "source_archiver.walrus_store.start",
                ...context,
                cliPath: this.config.cliPath,
                timeoutMs: this.timeoutMs,
                ...(this.config.epochs === undefined ? {} : { epochs: this.config.epochs }),
                envKeys: Object.keys(this.config.env ?? {}).sort(),
            });
            const output = await this.commandRunner.run(commandInput);
            const blobId = parseWalrusStoreResult(output.stdout);
            this.logger({
                event: "source_archiver.walrus_store.success",
                ...context,
                walrusBlobId: blobId,
                durationMs: durationMsSince(startedAt),
                stdout: summarizeCliOutput(output.stdout),
                stderr: summarizeCliOutput(output.stderr),
            });
            return blobId;
        } catch (error) {
            if (error instanceof SourceArchiverError) {
                this.logger(walrusStoreFailureLogEvent(context, startedAt, error));
                throw error;
            }
            this.logger(walrusStoreFailureLogEvent(context, startedAt, error));
            const message = error instanceof Error ? error.message : String(error);
            throw new SourceArchiverError(`Walrus store failed: ${message}`, "retryable", 502);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    }
}

export class NodeWalrusStoreCommandRunner implements WalrusStoreCommandRunner {
    async run(input: {
        cliPath: string;
        args: string[];
        timeoutMs: number;
        env?: Record<string, string>;
    }): Promise<{ stdout: string; stderr: string }> {
        const output = await execFileAsync(input.cliPath, input.args, {
            timeout: input.timeoutMs,
            maxBuffer: 1024 * 1024,
            env: input.env === undefined ? process.env : { ...process.env, ...input.env },
        });
        return { stdout: output.stdout, stderr: output.stderr };
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
            return jsonResponse(200, { walrus_blob_id: stored.walrusBlobId });
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
    const secrets = new AwsSecretStringReader();
    const logger = defaultSourceArchiverLogger;
    const handler = createSourceArchiverHandler({
        bucket: requiredEnv("RESULT_BUCKET"),
        s3: new AwsSourceArtifactS3Reader(),
        walrus: {
            store: async (artifact) =>
                new WalrusCliStoreRunner(
                    walrusCliStoreConfig({
                        cliPath: requiredEnv("SOURCE_ARCHIVER_WALRUS_CLI"),
                        timeoutMs: readOptionalPositiveIntegerEnv(
                            "SOURCE_ARCHIVER_WALRUS_TIMEOUT_MS",
                        ),
                        epochs: readOptionalPositiveIntegerEnv("SOURCE_ARCHIVER_WALRUS_EPOCHS"),
                        env: await readWalrusEnvironmentSecret(
                            requiredEnv("SOURCE_ARCHIVER_WALRUS_ENV_SECRET_ARN"),
                            secrets,
                        ),
                    }),
                    new NodeWalrusStoreCommandRunner(),
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
}): Promise<{ walrusBlobId: string }> {
    try {
        const walrusBlobId = await input.walrus.store(input.artifact);
        if (walrusBlobId !== input.artifact.request.expectedWalrusBlobId) {
            throw integrityFailure("Walrus store result did not match expected blob id");
        }
        return { walrusBlobId };
    } catch (error) {
        if (error instanceof SourceArchiverError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new SourceArchiverError(`Walrus store failed: ${message}`, "retryable", 502);
    }
}

export function parseWalrusStoreResult(output: string): string {
    const parsedJson = parseJsonOutput(output);
    if (parsedJson !== undefined) {
        const jsonBlobId = readWalrusStoreResultBlobId(parsedJson);
        if (jsonBlobId !== undefined) {
            return validateWalrusBlobIdFromOutput(jsonBlobId);
        }
        throw missingWalrusBlobId();
    }

    const labeled = output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.startsWith("Blob ID:"))
        ?.slice("Blob ID:".length)
        .trim();
    if (labeled !== undefined && labeled.length > 0) {
        return validateWalrusBlobIdFromOutput(labeled);
    }

    throw missingWalrusBlobId();
}

export function parseWalrusBlobId(output: string): string {
    return parseWalrusStoreResult(output);
}

function parseJsonOutput(output: string): unknown | undefined {
    const trimmed = output.trim();
    if (trimmed.length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        return undefined;
    }
}

function readWalrusStoreResultBlobId(output: unknown): string | undefined {
    if (!isRecord(output)) {
        return undefined;
    }
    const blobStoreResult = output.blobStoreResult;
    if (!isRecord(blobStoreResult)) {
        return undefined;
    }

    const alreadyCertified = blobStoreResult.alreadyCertified;
    if (isRecord(alreadyCertified) && typeof alreadyCertified.blobId === "string") {
        return alreadyCertified.blobId;
    }

    const newlyCreated = blobStoreResult.newlyCreated;
    if (!isRecord(newlyCreated)) {
        return undefined;
    }
    const blobObject = newlyCreated.blobObject;
    if (isRecord(blobObject) && typeof blobObject.blobId === "string") {
        return blobObject.blobId;
    }
    return undefined;
}

function missingWalrusBlobId(): SourceArchiverError {
    return new SourceArchiverError(
        "Walrus store output did not include a blob id",
        "retryable",
        502,
    );
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
    const durationMs = durationMsSince(startedAt);
    return {
        event: "source_archiver.walrus_store.failure",
        ...context,
        durationMs,
        ...optionalProperty("exitCode", readErrorStringOrNumberProperty(error, "code")),
        ...optionalProperty("signal", readErrorStringProperty(error, "signal")),
        ...optionalProperty("killed", readErrorBooleanProperty(error, "killed")),
        timedOut: readErrorBooleanProperty(error, "killed") === true,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        stdout: summarizeCliOutput(readErrorStringProperty(error, "stdout") ?? ""),
        stderr: summarizeCliOutput(readErrorStringProperty(error, "stderr") ?? ""),
    };
}

function summarizeCliOutput(output: string): CliOutputSummary {
    const redacted = output
        .split(/\r?\n/u)
        .map((line) => {
            if (!SENSITIVE_OUTPUT_LINE_PATTERN.test(line)) {
                return line;
            }
            return `[redacted-sensitive-line sha256=${createHash("sha256").update(line).digest("hex")}]`;
        })
        .join("\n");
    if (redacted.length <= CLI_OUTPUT_SUMMARY_MAX_CHARS) {
        return { text: redacted, truncated: false };
    }
    return {
        text: redacted.slice(0, CLI_OUTPUT_SUMMARY_MAX_CHARS),
        truncated: true,
    };
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

function readErrorStringOrNumberProperty(error: unknown, key: string): string | number | undefined {
    const value = readErrorProperty(error, key);
    return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function readErrorStringProperty(error: unknown, key: string): string | undefined {
    const value = readErrorProperty(error, key);
    if (typeof value === "string") {
        return value;
    }
    if (Buffer.isBuffer(value)) {
        return value.toString("utf8");
    }
    return undefined;
}

function readErrorBooleanProperty(error: unknown, key: string): boolean | undefined {
    const value = readErrorProperty(error, key);
    return typeof value === "boolean" ? value : undefined;
}

function readErrorProperty(error: unknown, key: string): unknown {
    if (!isRecord(error)) {
        return undefined;
    }
    return error[key];
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

async function readWalrusEnvironmentSecret(
    secretArn: string,
    reader: SecretStringReader,
): Promise<Record<string, string>> {
    const parsed = JSON.parse(await reader.getSecretString(secretArn)) as unknown;
    if (!isRecord(parsed)) {
        throw new Error(`${secretArn} must contain a JSON object`);
    }
    return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => {
            const [key, value] = entry;
            return key.length > 0 && typeof value === "string" && value.length > 0;
        }),
    );
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function readOptionalPositiveIntegerEnv(name: string): number | undefined {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function walrusCliStoreConfig(input: {
    cliPath: string;
    timeoutMs: number | undefined;
    epochs: number | undefined;
    env: Record<string, string>;
}): WalrusCliStoreConfig {
    const config: WalrusCliStoreConfig = {
        cliPath: input.cliPath,
        env: input.env,
    };
    if (input.timeoutMs !== undefined) {
        config.timeoutMs = input.timeoutMs;
    }
    if (input.epochs !== undefined) {
        config.epochs = input.epochs;
    }
    return config;
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
        throw new SourceArchiverError(
            "Walrus store output included an invalid blob id",
            "retryable",
            502,
        );
    }
    return blobId;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
