import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const SOURCE_ARTIFACT_PREFIX = "source-artifacts/";
const SOURCE_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const WALRUS_BLOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const DEFAULT_WALRUS_STORE_TIMEOUT_MS = 55_000;

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

export class WalrusCliStoreRunner implements WalrusStoreRunner {
    private readonly timeoutMs: number;

    constructor(
        private readonly config: WalrusCliStoreConfig,
        private readonly commandRunner: WalrusStoreCommandRunner = new NodeWalrusStoreCommandRunner(),
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
            const output = await this.commandRunner.run(commandInput);
            return parseWalrusBlobId(output.stdout);
        } catch (error) {
            if (error instanceof SourceArchiverError) {
                throw error;
            }
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

export function parseWalrusBlobId(output: string): string {
    const labeled = output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.startsWith("Blob ID:"))
        ?.slice("Blob ID:".length)
        .trim();
    if (labeled !== undefined && labeled.length > 0) {
        return validateWalrusBlobIdFromOutput(labeled);
    }

    const fallback = output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !line.startsWith("Success:"))
        .at(-1);
    if (fallback === undefined) {
        throw new SourceArchiverError(
            "Walrus store output did not include a blob id",
            "retryable",
            502,
        );
    }
    return validateWalrusBlobIdFromOutput(fallback);
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
