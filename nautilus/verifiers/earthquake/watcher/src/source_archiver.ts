import { createHash } from "node:crypto";

const SOURCE_ARTIFACT_PREFIX = "source-artifacts/";
const SOURCE_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const WALRUS_BLOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;

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
}): Promise<{ request: SourceArchiverRequest; bytes: Uint8Array }> {
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

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
