import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
    createSourceArchiverHandler,
    loadVerifiedSourceArtifact,
    parseSourceArchiverEvent,
    parseWalrusBlobId,
    parseWalrusStoreResult,
    SourceArchiverError,
    type SourceArchiverLogEvent,
    storeVerifiedSourceArtifact,
    WalrusCliStoreRunner,
    type SourceArtifactS3Reader,
    type WalrusStoreCommandRunner,
    type WalrusStoreRunner,
} from "../src/source_archiver.js";

const validBytes = new TextEncoder().encode("source artifact bytes");
const validRequest = {
    artifact_s3_key: "source-artifacts/us7000sonari/1/0-detail_geojson-hash.bin",
    expected_walrus_blob_id: "testBlob_123456",
    source_hash: sha256Hex(validBytes),
    size_bytes: validBytes.byteLength,
};

describe("source archiver request parsing", () => {
    it("parses a valid RunnerControl request body", () => {
        expect(parseSourceArchiverEvent({ body: JSON.stringify(validRequest) })).toEqual({
            artifactS3Key: validRequest.artifact_s3_key,
            expectedWalrusBlobId: validRequest.expected_walrus_blob_id,
            sourceHash: validRequest.source_hash,
            sizeBytes: validRequest.size_bytes,
        });
    });

    it("rejects artifact keys outside source-artifacts", () => {
        expect(() =>
            parseSourceArchiverEvent({
                body: JSON.stringify({
                    ...validRequest,
                    artifact_s3_key: "results/us7000sonari/finalized.json",
                }),
            }),
        ).toThrow(SourceArchiverError);
    });

    it("rejects unsafe source hash, size, and Walrus blob id fields", () => {
        const cases = [
            { source_hash: `0x${"A".repeat(64)}` },
            { source_hash: `0x${"0".repeat(63)}` },
            { size_bytes: -1 },
            { size_bytes: Number.MAX_SAFE_INTEGER + 1 },
            { expected_walrus_blob_id: "short" },
            { expected_walrus_blob_id: "bad/blob/id" },
        ];

        for (const patch of cases) {
            expect(() =>
                parseSourceArchiverEvent({
                    body: JSON.stringify({ ...validRequest, ...patch }),
                }),
            ).toThrow(SourceArchiverError);
        }
    });
});

describe("source archiver S3 verification", () => {
    it("returns S3 bytes only when hash and size match", async () => {
        const s3 = new RecordingS3Reader(validBytes);

        await expect(
            loadVerifiedSourceArtifact({
                bucket: "sonari-results",
                request: parseSourceArchiverEvent({ body: JSON.stringify(validRequest) }),
                s3,
            }),
        ).resolves.toEqual({
            request: parseSourceArchiverEvent({ body: JSON.stringify(validRequest) }),
            bytes: validBytes,
        });
        expect(s3.reads).toEqual([
            {
                bucket: "sonari-results",
                key: validRequest.artifact_s3_key,
            },
        ]);
    });

    it("classifies S3 read failure as retryable", async () => {
        const s3 = new RecordingS3Reader(validBytes);
        s3.failRead = true;

        await expect(
            loadVerifiedSourceArtifact({
                bucket: "sonari-results",
                request: parseSourceArchiverEvent({ body: JSON.stringify(validRequest) }),
                s3,
            }),
        ).rejects.toMatchObject({
            kind: "retryable",
            statusCode: 502,
        });
    });

    it("classifies source hash mismatch as integrity failure", async () => {
        await expect(
            loadVerifiedSourceArtifact({
                bucket: "sonari-results",
                request: parseSourceArchiverEvent({ body: JSON.stringify(validRequest) }),
                s3: new RecordingS3Reader(new TextEncoder().encode("tampered")),
            }),
        ).rejects.toMatchObject({
            kind: "integrity",
            statusCode: 422,
        });
    });

    it("classifies source size mismatch as integrity failure", async () => {
        await expect(
            loadVerifiedSourceArtifact({
                bucket: "sonari-results",
                request: {
                    ...parseSourceArchiverEvent({ body: JSON.stringify(validRequest) }),
                    sizeBytes: validBytes.byteLength + 1,
                },
                s3: new RecordingS3Reader(validBytes),
            }),
        ).rejects.toMatchObject({
            kind: "integrity",
            statusCode: 422,
        });
    });
});

describe("source archiver Walrus store", () => {
    it("stores verified bytes and returns the expected blob id", async () => {
        const artifact = await verifiedArtifact();
        const walrus = new RecordingWalrusStoreRunner("testBlob_123456");

        await expect(storeVerifiedSourceArtifact({ artifact, walrus })).resolves.toEqual({
            walrusBlobId: "testBlob_123456",
        });
        expect(walrus.stores).toEqual([artifact]);
    });

    it("classifies blob id mismatch as integrity failure", async () => {
        await expect(
            storeVerifiedSourceArtifact({
                artifact: await verifiedArtifact(),
                walrus: new RecordingWalrusStoreRunner("otherBlob_123456"),
            }),
        ).rejects.toMatchObject({
            kind: "integrity",
            statusCode: 422,
        });
    });

    it("classifies Walrus store failure as retryable", async () => {
        const walrus = new RecordingWalrusStoreRunner("testBlob_123456");
        walrus.failStore = true;

        await expect(
            storeVerifiedSourceArtifact({
                artifact: await verifiedArtifact(),
                walrus,
            }),
        ).rejects.toMatchObject({
            kind: "retryable",
            statusCode: 502,
        });
    });

    it("parses Walrus JSON store output with an already certified blob id", () => {
        expect(
            parseWalrusStoreResult(
                JSON.stringify({
                    blobStoreResult: {
                        alreadyCertified: {
                            blobId: "testBlob_123456",
                        },
                    },
                }),
            ),
        ).toBe("testBlob_123456");
    });

    it("parses Walrus JSON store output with a newly created blob object id", () => {
        expect(
            parseWalrusStoreResult(
                JSON.stringify({
                    blobStoreResult: {
                        newlyCreated: {
                            blobObject: {
                                blobId: "testBlob_123456",
                            },
                        },
                    },
                }),
            ),
        ).toBe("testBlob_123456");
    });

    it("validates blob ids parsed from Walrus JSON store output", () => {
        expect(() =>
            parseWalrusStoreResult(
                JSON.stringify({
                    blobStoreResult: {
                        alreadyCertified: {
                            blobId: "bad/blob/id",
                        },
                    },
                }),
            ),
        ).toThrow(SourceArchiverError);
    });

    it("classifies empty Walrus stdout as retryable", () => {
        expect(() => parseWalrusStoreResult("")).toThrow(SourceArchiverError);
        expect(() => parseWalrusStoreResult("")).toThrow(
            expect.objectContaining({
                kind: "retryable",
                statusCode: 502,
            }),
        );
    });

    it("classifies malformed JSON-looking Walrus stdout as retryable without human fallback", () => {
        expect(() =>
            parseWalrusStoreResult('{"blobStoreResult":\nBlob ID: testBlob_123456\n'),
        ).toThrow(
            expect.objectContaining({
                kind: "retryable",
                statusCode: 502,
            }),
        );
    });

    it("classifies Walrus JSON output missing a blob id as retryable", () => {
        expect(() =>
            parseWalrusStoreResult(
                JSON.stringify({
                    blobStoreResult: {
                        newlyCreated: {
                            blobObject: {},
                        },
                    },
                }),
            ),
        ).toThrow(
            expect.objectContaining({
                kind: "retryable",
                statusCode: 502,
            }),
        );
    });

    it("classifies ambiguous Walrus JSON output with multiple blob ids as retryable", () => {
        expect(() =>
            parseWalrusStoreResult(
                JSON.stringify({
                    blobStoreResult: {
                        alreadyCertified: {
                            blobId: "testBlob_123456",
                        },
                        newlyCreated: {
                            blobObject: {
                                blobId: "otherBlob_123456",
                            },
                        },
                    },
                }),
            ),
        ).toThrow(
            expect.objectContaining({
                kind: "retryable",
                statusCode: 502,
            }),
        );
    });

    it("falls back only to explicit Blob ID human output", () => {
        expect(parseWalrusStoreResult("Success: stored\nBlob ID: testBlob_123456\n")).toBe(
            "testBlob_123456",
        );
        expect(parseWalrusBlobId("Success: stored\nBlob ID: testBlob_123456\n")).toBe(
            "testBlob_123456",
        );
        expect(() => parseWalrusStoreResult("Success: stored\ntestBlob_123456\n")).toThrow(
            SourceArchiverError,
        );
        expect(() => parseWalrusStoreResult("Success: stored\n")).toThrow(SourceArchiverError);
    });

    it("runs walrus JSON store with a temp file containing the source bytes and configured epochs", async () => {
        const command = new RecordingWalrusCommandRunner(walrusJsonStdout("testBlob_123456"));
        const runner = new WalrusCliStoreRunner(
            {
                cliPath: "/opt/sonari/bin/walrus",
                timeoutMs: 12_000,
                epochs: 1,
                env: { WALRUS_CONFIG: "/tmp/walrus.yaml" },
            },
            command,
        );

        await expect(runner.store(await verifiedArtifact())).resolves.toBe("testBlob_123456");
        expect(command.runs).toHaveLength(1);
        expect(command.runs[0]).toMatchObject({
            cliPath: "/opt/sonari/bin/walrus",
            timeoutMs: 12_000,
            env: { WALRUS_CONFIG: "/tmp/walrus.yaml" },
        });
        expect(command.runs[0]?.args[0]).toBe("json");
        expect(command.runs[0]?.args).toHaveLength(2);
        const payload = command.storePayloads[0];
        expect(payload?.command.store.files).toEqual([command.artifactPaths[0]]);
        expect(payload?.command.store.epochs).toBe(1);
        expect(command.tempFileBytes).toEqual([validBytes]);
    });

    it("omits epochs from the Walrus JSON store payload when epochs are not configured", async () => {
        const command = new RecordingWalrusCommandRunner(walrusJsonStdout("testBlob_123456"));
        const runner = new WalrusCliStoreRunner(
            {
                cliPath: "/opt/sonari/bin/walrus",
            },
            command,
        );

        await expect(runner.store(await verifiedArtifact())).resolves.toBe("testBlob_123456");

        expect(command.runs[0]?.args[0]).toBe("json");
        const payload = command.storePayloads[0];
        expect(payload?.command.store.files).toEqual([command.artifactPaths[0]]);
        expect(payload?.command.store).not.toHaveProperty("epochs");
        expect(command.tempFileBytes).toEqual([validBytes]);
    });

    it("logs Walrus CLI success context without exposing environment values", async () => {
        const command = new RecordingWalrusCommandRunner(
            walrusJsonStdout("testBlob_123456"),
            "progress: stored\n",
        );
        const logger = new RecordingSourceArchiverLogger();
        const runner = new WalrusCliStoreRunner(
            {
                cliPath: "/opt/sonari/bin/walrus",
                timeoutMs: 12_000,
                epochs: 1,
                env: {
                    WALRUS_CONFIG: "/tmp/walrus.yaml",
                    WALRUS_CONTEXT: "devnet",
                },
            },
            command,
            logger.log,
        );

        await expect(runner.store(await verifiedArtifact())).resolves.toBe("testBlob_123456");

        expect(logger.events).toHaveLength(2);
        expect(logger.events[0]).toMatchObject({
            event: "source_archiver.walrus_store.start",
            artifactS3Key: validRequest.artifact_s3_key,
            sizeBytes: validRequest.size_bytes,
            sourceHash: validRequest.source_hash,
            expectedWalrusBlobId: validRequest.expected_walrus_blob_id,
            cliPath: "/opt/sonari/bin/walrus",
            timeoutMs: 12_000,
            epochs: 1,
            envKeys: ["WALRUS_CONFIG", "WALRUS_CONTEXT"],
        });
        expect(logger.events[0]).not.toHaveProperty("env");
        expect(logger.events[1]).toMatchObject({
            event: "source_archiver.walrus_store.success",
            walrusBlobId: "testBlob_123456",
            stdout: {
                truncated: false,
                text: walrusJsonStdout("testBlob_123456"),
            },
            stderr: {
                truncated: false,
                text: "progress: stored\n",
            },
        });
        expect(logger.events[1]).toHaveProperty("durationMs");
    });

    it("logs Walrus CLI failure diagnostics and redacts sensitive output lines", async () => {
        const command = new RecordingWalrusCommandRunner("unused");
        command.failRun = {
            name: "Error",
            message: "Command failed: walrus",
            code: 78,
            killed: true,
            signal: "SIGTERM",
            stdout: "ok line\nwallet private key = abc123\nnext line\n",
            stderr: "token=secret-value\nkeystore path /tmp/wallet\nnetwork 502\n",
        };
        const logger = new RecordingSourceArchiverLogger();
        const runner = new WalrusCliStoreRunner(
            {
                cliPath: "/opt/sonari/bin/walrus",
                timeoutMs: 55_000,
                env: { WALRUS_CONFIG: "/tmp/walrus.yaml" },
            },
            command,
            logger.log,
        );

        await expect(runner.store(await verifiedArtifact())).rejects.toMatchObject({
            kind: "retryable",
            statusCode: 502,
        });

        const failure = logger.events.at(-1);
        expect(failure).toMatchObject({
            event: "source_archiver.walrus_store.failure",
            artifactS3Key: validRequest.artifact_s3_key,
            exitCode: 78,
            signal: "SIGTERM",
            killed: true,
            timedOut: true,
            errorName: "Error",
            errorMessage: "Command failed: walrus",
            stdout: { truncated: false },
            stderr: { truncated: false },
        });
        if (failure?.event !== "source_archiver.walrus_store.failure") {
            throw new Error("expected Walrus store failure event");
        }
        expect(failure.stdout.text).toMatch(
            /^ok line\n\[redacted-sensitive-line sha256=[0-9a-f]{64}\]\nnext line\n$/u,
        );
        expect(failure.stderr.text).toMatch(
            /^\[redacted-sensitive-line sha256=[0-9a-f]{64}\]\n\[redacted-sensitive-line sha256=[0-9a-f]{64}\]\nnetwork 502\n$/u,
        );
    });
});

describe("source archiver HTTP handler", () => {
    it("returns the stored blob id for an authorized valid request", async () => {
        const handler = createSourceArchiverHandler({
            bucket: "sonari-results",
            s3: new RecordingS3Reader(validBytes),
            walrus: new RecordingWalrusStoreRunner("testBlob_123456"),
            authToken: async () => "archiver-token",
        });

        await expect(
            handler({
                headers: { "x-sonari-source-archiver-token": "archiver-token" },
                body: JSON.stringify(validRequest),
            }),
        ).resolves.toEqual({
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ walrus_blob_id: "testBlob_123456" }),
        });
    });

    it("rejects missing or wrong source archiver token before S3 read", async () => {
        const s3 = new RecordingS3Reader(validBytes);
        const handler = createSourceArchiverHandler({
            bucket: "sonari-results",
            s3,
            walrus: new RecordingWalrusStoreRunner("testBlob_123456"),
            authToken: async () => "archiver-token",
        });

        await expect(handler({ body: JSON.stringify(validRequest) })).resolves.toMatchObject({
            statusCode: 401,
        });
        expect(s3.reads).toEqual([]);
    });

    it("returns integrity status without leaking mismatch details", async () => {
        const handler = createSourceArchiverHandler({
            bucket: "sonari-results",
            s3: new RecordingS3Reader(new TextEncoder().encode("tampered")),
            walrus: new RecordingWalrusStoreRunner("testBlob_123456"),
            authToken: async () => "archiver-token",
        });

        await expect(
            handler({
                headers: { "X-Sonari-Source-Archiver-Token": "archiver-token" },
                body: JSON.stringify(validRequest),
            }),
        ).resolves.toEqual({
            statusCode: 422,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "integrity" }),
        });
    });

    it("returns retryable status without leaking Walrus failure details and logs request context", async () => {
        const walrus = new RecordingWalrusStoreRunner("testBlob_123456");
        walrus.failStore = true;
        const logger = new RecordingSourceArchiverLogger();
        const handler = createSourceArchiverHandler({
            bucket: "sonari-results",
            s3: new RecordingS3Reader(validBytes),
            walrus,
            authToken: async () => "archiver-token",
            logger: logger.log,
        });

        await expect(
            handler({
                headers: { "x-sonari-source-archiver-token": "archiver-token" },
                body: JSON.stringify(validRequest),
            }),
        ).resolves.toEqual({
            statusCode: 502,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "retryable" }),
        });

        expect(logger.events.at(-1)).toMatchObject({
            event: "source_archiver.handler.failure",
            stage: "walrus_store",
            errorKind: "retryable",
            statusCode: 502,
            artifactS3Key: validRequest.artifact_s3_key,
            sizeBytes: validRequest.size_bytes,
            sourceHash: validRequest.source_hash,
            expectedWalrusBlobId: validRequest.expected_walrus_blob_id,
        });
        expect(JSON.stringify(logger.events)).not.toContain("walrus network unavailable");
    });

    it("returns retryable status and redacts sensitive Walrus CLI error messages", async () => {
        const command = new RecordingWalrusCommandRunner("unused");
        command.failRun = {
            name: "Error",
            message:
                "Command failed: /opt/sonari/bin/walrus store /tmp/source token=abc private keystore wallet password api key",
            code: 1,
            killed: false,
            signal: "SIGTERM",
            stdout: "",
            stderr: "",
        };
        const logger = new RecordingSourceArchiverLogger();
        const handler = createSourceArchiverHandler({
            bucket: "sonari-results",
            s3: new RecordingS3Reader(validBytes),
            walrus: new WalrusCliStoreRunner(
                {
                    cliPath: "/opt/sonari/bin/walrus",
                    timeoutMs: 55_000,
                },
                command,
                logger.log,
            ),
            authToken: async () => "archiver-token",
            logger: logger.log,
        });

        const response = await handler({
            headers: { "x-sonari-source-archiver-token": "archiver-token" },
            body: JSON.stringify(validRequest),
        });

        expect(response).toEqual({
            statusCode: 502,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "retryable" }),
        });
        const failure = logger.events.find(
            (event) => event.event === "source_archiver.walrus_store.failure",
        );
        expect(failure).toMatchObject({
            event: "source_archiver.walrus_store.failure",
            errorName: "Error",
        });
        if (failure?.event !== "source_archiver.walrus_store.failure") {
            throw new Error("expected Walrus store failure event");
        }
        expect(failure.errorMessage).toMatch(
            /^\[redacted-sensitive-message sha256=[0-9a-f]{64}\]$/u,
        );
        const serializedResponse = JSON.stringify(response);
        expect(serializedResponse).not.toContain("/opt/sonari/bin/walrus");
        expect(serializedResponse).not.toContain("token=abc");
        expect(serializedResponse).not.toContain("password");
    });
});

class RecordingS3Reader implements SourceArtifactS3Reader {
    readonly reads: Array<{ bucket: string; key: string }> = [];
    failRead = false;

    constructor(private readonly bytes: Uint8Array) {}

    async getObjectBytes(input: { bucket: string; key: string }): Promise<Uint8Array> {
        this.reads.push(input);
        if (this.failRead) {
            throw new Error("S3 unavailable");
        }
        return this.bytes;
    }
}

class RecordingWalrusStoreRunner implements WalrusStoreRunner {
    readonly stores: Awaited<ReturnType<typeof verifiedArtifact>>[] = [];
    failStore = false;

    constructor(private readonly walrusBlobId: string) {}

    async store(input: Awaited<ReturnType<typeof verifiedArtifact>>): Promise<string> {
        this.stores.push(input);
        if (this.failStore) {
            throw new Error("walrus network unavailable");
        }
        return this.walrusBlobId;
    }
}

interface WalrusJsonStorePayload {
    command: {
        store: {
            files: string[];
            epochs?: number;
        };
    };
}

class RecordingWalrusCommandRunner implements WalrusStoreCommandRunner {
    readonly runs: Array<{
        cliPath: string;
        args: string[];
        timeoutMs: number;
        env?: Record<string, string>;
    }> = [];
    readonly storePayloads: WalrusJsonStorePayload[] = [];
    readonly artifactPaths: string[] = [];
    readonly tempFileBytes: Uint8Array[] = [];

    failRun?: {
        name: string;
        message: string;
        code: number;
        killed: boolean;
        signal: string;
        stdout: string;
        stderr: string;
    };

    constructor(
        private readonly stdout: string,
        private readonly stderr = "",
    ) {}

    async run(input: {
        cliPath: string;
        args: string[];
        timeoutMs: number;
        env?: Record<string, string>;
    }): Promise<{ stdout: string; stderr: string }> {
        this.runs.push(input);
        const payload = parseWalrusJsonStorePayload(input.args[1]);
        this.storePayloads.push(payload);
        const artifactPath = payload.command.store.files[0];
        if (artifactPath === undefined) {
            throw new Error("Walrus JSON payload command.store.files was empty");
        }
        this.artifactPaths.push(artifactPath);
        this.tempFileBytes.push(new Uint8Array(await readFile(artifactPath)));
        if (this.failRun !== undefined) {
            const error = new Error(this.failRun.message) as Error & {
                code: number;
                killed: boolean;
                signal: string;
                stdout: string;
                stderr: string;
            };
            error.name = this.failRun.name;
            error.code = this.failRun.code;
            error.killed = this.failRun.killed;
            error.signal = this.failRun.signal;
            error.stdout = this.failRun.stdout;
            error.stderr = this.failRun.stderr;
            throw error;
        }
        return { stdout: this.stdout, stderr: this.stderr };
    }
}

class RecordingSourceArchiverLogger {
    readonly events: SourceArchiverLogEvent[] = [];

    readonly log = (event: SourceArchiverLogEvent): void => {
        this.events.push(event);
    };
}

async function verifiedArtifact() {
    return loadVerifiedSourceArtifact({
        bucket: "sonari-results",
        request: parseSourceArchiverEvent({ body: JSON.stringify(validRequest) }),
        s3: new RecordingS3Reader(validBytes),
    });
}

function walrusJsonStdout(blobId: string): string {
    return JSON.stringify({
        blobStoreResult: {
            alreadyCertified: {
                blobId,
            },
        },
    });
}

function sha256Hex(bytes: Uint8Array): string {
    return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseWalrusJsonStorePayload(payloadJson: string | undefined): WalrusJsonStorePayload {
    if (payloadJson === undefined) {
        throw new Error("Walrus JSON payload missing");
    }
    const payload = JSON.parse(payloadJson) as unknown;
    if (!isRecord(payload)) {
        throw new Error("Walrus JSON payload must be an object");
    }
    const command = payload.command;
    if (!isRecord(command)) {
        throw new Error("Walrus JSON payload command missing");
    }
    const store = command.store;
    if (
        !isRecord(store) ||
        !Array.isArray(store.files) ||
        !store.files.every((file) => typeof file === "string")
    ) {
        throw new Error("Walrus JSON payload command.store.files missing");
    }
    if (store.epochs !== undefined && typeof store.epochs !== "number") {
        throw new Error("Walrus JSON payload command.store.epochs must be a number");
    }
    return {
        command: {
            store: {
                files: store.files,
                ...(store.epochs === undefined ? {} : { epochs: store.epochs }),
            },
        },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
