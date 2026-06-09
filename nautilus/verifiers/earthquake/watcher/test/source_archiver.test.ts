import { createHash } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { describe, expect, it } from "vitest";
import {
    computeBackoffDelayMs,
    createSourceArchiverHandler,
    DEFAULT_WALRUS_STORE_RETRY_POLICY,
    loadVerifiedSourceArtifact,
    parseSourceArchiverEvent,
    readWalrusPrivateKeySecret,
    SourceArchiverError,
    type SourceArchiverLogEvent,
    type SecretStringReader,
    storeVerifiedSourceArtifact,
    type SourceArtifactS3Reader,
    type WalrusSdkStoreClient,
    type WalrusSdkStoreConfig,
    type WalrusSdkStoreClientFactory,
    WalrusSdkStoreRunner,
    type WalrusStoreClock,
    type WalrusSdkStoreRunnerOptions,
    type WalrusStoreResult,
    type WalrusStoreRunner,
} from "../src/source_archiver.js";

const validBytes = new TextEncoder().encode("source artifact bytes");
const validRequest = {
    artifact_s3_key: "source-artifacts/us7000sonari/1/0-detail_geojson-hash.bin",
    expected_walrus_blob_id: "testBlob_123456",
    source_hash: sha256Hex(validBytes),
    size_bytes: validBytes.byteLength,
};
const validBlobObjectId = `0x${"1".repeat(64)}`;
const validTxDigest = "5UGQGJ9nvy9M2LaWqfXWsm8YkK9fnmWwW7dpqgGNtMqF";

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
    it("stores verified bytes and returns the expected blob id metadata", async () => {
        const artifact = await verifiedArtifact();
        const walrus = new RecordingWalrusStoreRunner({
            walrusBlobId: "testBlob_123456",
            walrusBlobObjectId: validBlobObjectId,
            walrusTxDigest: validTxDigest,
        });

        await expect(storeVerifiedSourceArtifact({ artifact, walrus })).resolves.toEqual({
            walrusBlobId: "testBlob_123456",
            walrusBlobObjectId: validBlobObjectId,
            walrusTxDigest: validTxDigest,
        });
        expect(walrus.stores).toEqual([artifact]);
    });

    it("classifies blob id mismatch as integrity failure", async () => {
        await expect(
            storeVerifiedSourceArtifact({
                artifact: await verifiedArtifact(),
                walrus: new RecordingWalrusStoreRunner({ walrusBlobId: "otherBlob_123456" }),
            }),
        ).rejects.toMatchObject({
            kind: "integrity",
            statusCode: 422,
        });
    });

    it("classifies Walrus store failure as retryable", async () => {
        const walrus = new RecordingWalrusStoreRunner({ walrusBlobId: "testBlob_123456" });
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

    it("accepts only a raw ED25519 suiprivkey secret", async () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();

        await expect(
            readWalrusPrivateKeySecret("secret-arn", new RecordingSecretStringReader(privateKey)),
        ).resolves.toBe(privateKey);

        const rejectedSecrets = [
            "",
            JSON.stringify({ SONARI_WALRUS_CLIENT_CONFIG_YAML: "default_context: testnet\n" }),
            "keystore:\n  File: /tmp/sui.keystore\n",
            Secp256k1Keypair.generate().getSecretKey(),
            "suiprivkey-not-valid",
        ];
        for (const secret of rejectedSecrets) {
            await expect(
                readWalrusPrivateKeySecret(
                    "secret-arn",
                    new RecordingSecretStringReader(secret),
                ),
            ).rejects.toMatchObject({
                kind: "configuration",
                statusCode: 500,
            });
        }
    });

    it("writes blobs with the SDK upload relay defaults and returns object metadata", async () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();
        const sdk = new RecordingWalrusSdkClientFactory({
            blobId: "testBlob_123456",
            blobObjectId: validBlobObjectId,
            txDigest: validTxDigest,
        });
        const logger = new RecordingSourceArchiverLogger();
        const runner = new WalrusSdkStoreRunner({ suiPrivateKey: privateKey }, sdk, logger.log);

        await expect(runner.store(await verifiedArtifact())).resolves.toEqual({
            walrusBlobId: "testBlob_123456",
            walrusBlobObjectId: validBlobObjectId,
            walrusTxDigest: validTxDigest,
        });

        expect(sdk.creates).toEqual([
            {
                suiNetwork: "testnet",
                suiRpcUrl: "https://fullnode.testnet.sui.io:443",
                uploadRelayUrl: "https://upload-relay.testnet.walrus.space",
                uploadRelayTipMaxMist: 1_000,
            },
        ]);
        expect(sdk.writeBlobInputs).toHaveLength(1);
        expect(sdk.writeBlobInputs[0]).toMatchObject({
            blob: validBytes,
            epochs: 1,
            deletable: false,
        });
        expect(sdk.writeBlobInputs[0]?.signer).toBeDefined();
        expect(logger.events).toEqual([
            expect.objectContaining({
                event: "source_archiver.walrus_store.start",
                suiNetwork: "testnet",
                suiRpcUrl: "https://fullnode.testnet.sui.io:443",
                uploadRelayUrl: "https://upload-relay.testnet.walrus.space",
                uploadRelayTipMaxMist: 1_000,
                epochs: 1,
                deletable: false,
            }),
            expect.objectContaining({
                event: "source_archiver.walrus_store.step",
                step: "registered",
                blobId: "testBlob_123456",
                blobObjectId: validBlobObjectId,
                txDigest: validTxDigest,
                durationMs: expect.any(Number),
            }),
            expect.objectContaining({
                event: "source_archiver.walrus_store.success",
                walrusBlobId: "testBlob_123456",
                walrusBlobObjectId: validBlobObjectId,
                walrusTxDigest: validTxDigest,
            }),
        ]);
        expect(JSON.stringify(logger.events)).not.toContain(privateKey);
    });

    it("passes explicit SDK network, RPC, relay, tip cap, epochs, and deletable config", async () => {
        const sdk = new RecordingWalrusSdkClientFactory({
            blobId: "testBlob_123456",
            blobObjectId: validBlobObjectId,
        });
        const runner = new WalrusSdkStoreRunner(
            {
                suiPrivateKey: Ed25519Keypair.generate().getSecretKey(),
                suiNetwork: "mainnet",
                suiRpcUrl: "https://fullnode.mainnet.sui.io:443",
                uploadRelayUrl: "https://upload-relay.mainnet.walrus.space/",
                uploadRelayTipMaxMist: 2_000,
                epochs: 3,
                deletable: true,
            },
            sdk,
        );

        await expect(runner.store(await verifiedArtifact())).resolves.toMatchObject({
            walrusBlobId: "testBlob_123456",
        });

        expect(sdk.creates).toEqual([
            {
                suiNetwork: "mainnet",
                suiRpcUrl: "https://fullnode.mainnet.sui.io:443",
                uploadRelayUrl: "https://upload-relay.mainnet.walrus.space",
                uploadRelayTipMaxMist: 2_000,
            },
        ]);
        expect(sdk.writeBlobInputs[0]).toMatchObject({
            blob: validBytes,
            epochs: 3,
            deletable: true,
        });
    });

    it("rejects unsupported SDK network and unsafe numeric config fail-closed", () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();
        const cases: Array<Partial<WalrusSdkStoreConfig>> = [
            { suiNetwork: "devnet" as WalrusSdkStoreConfig["suiNetwork"] },
            { suiRpcUrl: "http://fullnode.testnet.sui.io:443" },
            { uploadRelayUrl: "ftp://upload-relay.testnet.walrus.space" },
            { uploadRelayTipMaxMist: -1 },
            { epochs: 0 },
        ];

        for (const config of cases) {
            expect(
                () =>
                    new WalrusSdkStoreRunner({
                        suiPrivateKey: privateKey,
                        ...config,
                    }),
            ).toThrow(
                expect.objectContaining({
                    kind: "configuration",
                    statusCode: 500,
                }),
            );
        }
    });

    it("classifies invalid SDK blob metadata as retryable", async () => {
        const sdk = new RecordingWalrusSdkClientFactory({
            blobId: "bad/blob/id",
            blobObjectId: validBlobObjectId,
        });
        const runner = new WalrusSdkStoreRunner(
            { suiPrivateKey: Ed25519Keypair.generate().getSecretKey() },
            sdk,
        );

        await expect(runner.store(await verifiedArtifact())).rejects.toMatchObject({
            kind: "retryable",
            statusCode: 502,
        });
    });

    it("logs SDK failure diagnostics and redacts sensitive error messages", async () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();
        const sdk = new RecordingWalrusSdkClientFactory({
            blobId: "testBlob_123456",
            blobObjectId: validBlobObjectId,
        });
        const socketCause = Object.assign(
            new Error(
                `getaddrinfo ENOTFOUND upload-relay.testnet.walrus.space token=abc ${privateKey}`,
            ),
            {
                code: "ENOTFOUND",
                errno: -3008,
                syscall: "getaddrinfo",
                hostname: "upload-relay.testnet.walrus.space",
                host: "upload-relay.testnet.walrus.space",
                port: 443,
                address: "203.0.113.10",
                reason: "dns lookup failed",
                type: "system",
            },
        );
        sdk.failWrite = Object.assign(
            new TypeError(`fetch failed with private key ${privateKey}`, { cause: socketCause }),
            {
                code: "UND_ERR_SOCKET",
            },
        );
        sdk.failWrite.stack = `TypeError: fetch failed with private key ${privateKey}
    at walrus secret token frame
    at writeBlob`;
        const logger = new RecordingSourceArchiverLogger();
        const runner = new WalrusSdkStoreRunner({ suiPrivateKey: privateKey }, sdk, logger.log, {
            clock: instantClock,
        });

        await expect(runner.store(await verifiedArtifact())).rejects.toMatchObject({
            kind: "retryable",
            statusCode: 502,
        });

        const failure = logger.events.at(-1);
        expect(failure).toMatchObject({
            event: "source_archiver.walrus_store.failure",
            errorName: "TypeError",
            errorClass: "TypeError",
            errorCode: "UND_ERR_SOCKET",
            errorCauseChain: [
                expect.objectContaining({
                    name: "TypeError",
                    code: "UND_ERR_SOCKET",
                }),
                expect.objectContaining({
                    name: "Error",
                    code: "ENOTFOUND",
                    errno: "-3008",
                    syscall: "getaddrinfo",
                    hostname: "upload-relay.testnet.walrus.space",
                    host: "upload-relay.testnet.walrus.space",
                    port: "443",
                    address: "203.0.113.10",
                    reason: "dns lookup failed",
                    type: "system",
                }),
            ],
            stackTop: [
                expect.stringMatching(/^\[redacted-sensitive-message sha256=[0-9a-f]{64}\]$/u),
                expect.stringMatching(/^\[redacted-sensitive-message sha256=[0-9a-f]{64}\]$/u),
                "    at writeBlob",
            ],
        });
        if (failure?.event !== "source_archiver.walrus_store.failure") {
            throw new Error("expected Walrus store failure event");
        }
        expect(failure.errorMessage).toMatch(
            /^\[redacted-sensitive-message sha256=[0-9a-f]{64}\]$/u,
        );
        expect(failure.errorCauseChain[0]?.message).toMatch(
            /^\[redacted-sensitive-message sha256=[0-9a-f]{64}\]$/u,
        );
        expect(failure.errorCauseChain[1]?.message).toMatch(
            /^\[redacted-sensitive-message sha256=[0-9a-f]{64}\]$/u,
        );
        expect(JSON.stringify(logger.events)).not.toContain(privateKey);
    });
});

describe("source archiver HTTP handler", () => {
    it("returns the stored blob id and optional metadata for an authorized valid request", async () => {
        const handler = createSourceArchiverHandler({
            bucket: "sonari-results",
            s3: new RecordingS3Reader(validBytes),
            walrus: new RecordingWalrusStoreRunner({
                walrusBlobId: "testBlob_123456",
                walrusBlobObjectId: validBlobObjectId,
                walrusTxDigest: validTxDigest,
            }),
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
            body: JSON.stringify({
                walrus_blob_id: "testBlob_123456",
                walrus_blob_object_id: validBlobObjectId,
                walrus_tx_digest: validTxDigest,
            }),
        });
    });

    it("preserves the existing minimal success response when SDK metadata is absent", async () => {
        const handler = createSourceArchiverHandler({
            bucket: "sonari-results",
            s3: new RecordingS3Reader(validBytes),
            walrus: new RecordingWalrusStoreRunner({ walrusBlobId: "testBlob_123456" }),
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
            walrus: new RecordingWalrusStoreRunner({ walrusBlobId: "testBlob_123456" }),
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
            walrus: new RecordingWalrusStoreRunner({ walrusBlobId: "testBlob_123456" }),
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
        const walrus = new RecordingWalrusStoreRunner({ walrusBlobId: "testBlob_123456" });
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

    constructor(private readonly result: WalrusStoreResult) {}

    async store(input: Awaited<ReturnType<typeof verifiedArtifact>>): Promise<WalrusStoreResult> {
        this.stores.push(input);
        if (this.failStore) {
            throw new Error("walrus network unavailable");
        }
        return this.result;
    }
}

class RecordingWalrusSdkClientFactory implements WalrusSdkStoreClientFactory {
    readonly creates: Array<{
        suiNetwork: "mainnet" | "testnet";
        suiRpcUrl: string;
        uploadRelayUrl: string;
        uploadRelayTipMaxMist: number;
    }> = [];
    readonly writeBlobInputs: Array<Parameters<WalrusSdkStoreClient["walrus"]["writeBlob"]>[0]> =
        [];
    /** Always throws on every call. Takes precedence over failWriteTimes. */
    failWrite?: Error;
    /** Throws on the first N calls, then succeeds. */
    failWriteTimes?: number;
    /** Error to throw when failWriteTimes applies. Defaults to a generic 502-like error. */
    failWriteError?: Error;

    constructor(
        private readonly result: {
            blobId: string;
            blobObjectId: string;
            txDigest?: string;
        },
    ) {}

    create(input: {
        suiNetwork: "mainnet" | "testnet";
        suiRpcUrl: string;
        uploadRelayUrl: string;
        uploadRelayTipMaxMist: number;
    }): WalrusSdkStoreClient {
        this.creates.push(input);
        return {
            walrus: {
                writeBlob: async (writeInput) => {
                    this.writeBlobInputs.push(writeInput);
                    if (this.failWrite !== undefined) {
                        throw this.failWrite;
                    }
                    if (
                        this.failWriteTimes !== undefined &&
                        this.writeBlobInputs.length <= this.failWriteTimes
                    ) {
                        throw this.failWriteError ?? new Error("walrus upload relay 502");
                    }
                    await writeInput.onStep?.({
                        step: "registered",
                        blobId: this.result.blobId,
                        blobObjectId: this.result.blobObjectId,
                        txDigest: this.result.txDigest ?? validTxDigest,
                    });
                    return {
                        blobId: this.result.blobId,
                        blobObject: {
                            id: this.result.blobObjectId,
                        },
                    };
                },
            },
        };
    }
}

class RecordingSourceArchiverLogger {
    readonly events: SourceArchiverLogEvent[] = [];

    readonly log = (event: SourceArchiverLogEvent): void => {
        this.events.push(event);
    };
}

class RecordingSecretStringReader implements SecretStringReader {
    constructor(private readonly secretString: string) {}

    async getSecretString(): Promise<string> {
        return this.secretString;
    }
}

async function verifiedArtifact() {
    return loadVerifiedSourceArtifact({
        bucket: "sonari-results",
        request: parseSourceArchiverEvent({ body: JSON.stringify(validRequest) }),
        s3: new RecordingS3Reader(validBytes),
    });
}

describe("source archiver backoff delay", () => {
    const policy = {
        initialDelayMs: 500,
        backoffRate: 2,
        maxDelayMs: 5_000,
        jitterRatio: 0.25,
    };

    it("returns exponential base delay when jitter is zero (attempt 0,1,2)", () => {
        expect(computeBackoffDelayMs(policy, 0, () => 0)).toBe(500);
        expect(computeBackoffDelayMs(policy, 1, () => 0)).toBe(1_000);
        expect(computeBackoffDelayMs(policy, 2, () => 0)).toBe(2_000);
    });

    it("caps delay at maxDelayMs when base exceeds it", () => {
        // attempt=10: base = 500 * 2^10 = 512_000 >> 5_000
        expect(computeBackoffDelayMs(policy, 10, () => 0)).toBe(5_000);
    });

    it("adds jitter up to capped * jitterRatio and never exceeds maxDelayMs * (1 + jitterRatio)", () => {
        // attempt=10 で capped=5_000。jitter上振れ最大 = 5_000 * 0.25 = 1_250
        const maxAllowed = Math.round(policy.maxDelayMs * (1 + policy.jitterRatio));
        const result = computeBackoffDelayMs(policy, 10, () => 0.9999);
        expect(result).toBeGreaterThanOrEqual(5_000);
        expect(result).toBeLessThanOrEqual(maxAllowed);
    });

    it("always returns a non-negative integer", () => {
        for (const attempt of [0, 1, 2, 5, 10]) {
            const result = computeBackoffDelayMs(policy, attempt, () => Math.random());
            expect(Number.isInteger(result)).toBe(true);
            expect(result).toBeGreaterThanOrEqual(0);
        }
    });

    it("DEFAULT_WALRUS_STORE_RETRY_POLICY total time budget is under 210 seconds", () => {
        const p = DEFAULT_WALRUS_STORE_RETRY_POLICY;
        // perAttemptTimeoutMs * maxAttempts (実行時間上限)
        const executionBudget = p.perAttemptTimeoutMs * p.maxAttempts;
        // attempt 0 .. maxAttempts-2 の最悪バックオフ合計 (random=()=>1 相当で最大ジッタ)
        let worstCaseBackoffTotal = 0;
        for (let attempt = 0; attempt < p.maxAttempts - 1; attempt++) {
            worstCaseBackoffTotal += computeBackoffDelayMs(
                {
                    initialDelayMs: p.initialDelayMs,
                    backoffRate: p.backoffRate,
                    maxDelayMs: p.maxDelayMs,
                    jitterRatio: p.jitterRatio,
                },
                attempt,
                () => 0.9999,
            );
        }
        expect(executionBudget + worstCaseBackoffTotal).toBeLessThan(210_000);
    });
});

function sha256Hex(bytes: Uint8Array): string {
    return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Helpers shared by the retry describe block
// ---------------------------------------------------------------------------

/** Clock that resolves sleep immediately and runs op() directly (no real timers). */
const instantClock: WalrusStoreClock = {
    sleep: () => Promise.resolve(),
    runWithTimeout: <T>(_ms: number, op: () => Promise<T>) => op(),
};

// ---------------------------------------------------------------------------
// source archiver Walrus store retry
// ---------------------------------------------------------------------------

describe("source archiver Walrus store retry", () => {
    it("retries once on transient failure and succeeds", async () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();
        const sdk = new RecordingWalrusSdkClientFactory({
            blobId: "testBlob_123456",
            blobObjectId: validBlobObjectId,
            txDigest: validTxDigest,
        });
        sdk.failWriteTimes = 1; // first call throws, second succeeds
        const runner = new WalrusSdkStoreRunner({ suiPrivateKey: privateKey }, sdk, undefined, {
            clock: instantClock,
            random: () => 0,
        });

        await expect(runner.store(await verifiedArtifact())).resolves.toMatchObject({
            walrusBlobId: "testBlob_123456",
        });
        expect(sdk.writeBlobInputs).toHaveLength(2);
    });

    it("stops retrying after maxAttempts exhausted and rejects with retryable", async () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();
        const sdk = new RecordingWalrusSdkClientFactory({
            blobId: "testBlob_123456",
            blobObjectId: validBlobObjectId,
        });
        sdk.failWriteTimes = 10; // always fails within 3 attempts
        const runner = new WalrusSdkStoreRunner({ suiPrivateKey: privateKey }, sdk, undefined, {
            retryPolicy: { maxAttempts: 3 },
            clock: instantClock,
            random: () => 0,
        });

        await expect(runner.store(await verifiedArtifact())).rejects.toMatchObject({
            kind: "retryable",
            statusCode: 502,
        });
        expect(sdk.writeBlobInputs).toHaveLength(3);
    });

    it("does not retry on bad_request error", async () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();
        const sdk = new RecordingWalrusSdkClientFactory({
            blobId: "testBlob_123456",
            blobObjectId: validBlobObjectId,
        });
        sdk.failWriteTimes = 1;
        sdk.failWriteError = new SourceArchiverError("invalid blob", "bad_request", 400);
        const runner = new WalrusSdkStoreRunner({ suiPrivateKey: privateKey }, sdk, undefined, {
            clock: instantClock,
        });

        await expect(runner.store(await verifiedArtifact())).rejects.toMatchObject({
            kind: "bad_request",
            statusCode: 400,
        });
        expect(sdk.writeBlobInputs).toHaveLength(1);
    });

    it("does not retry on configuration error", async () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();
        const sdk = new RecordingWalrusSdkClientFactory({
            blobId: "testBlob_123456",
            blobObjectId: validBlobObjectId,
        });
        sdk.failWriteTimes = 1;
        sdk.failWriteError = new SourceArchiverError("misconfigured", "configuration", 500);
        const runner = new WalrusSdkStoreRunner({ suiPrivateKey: privateKey }, sdk, undefined, {
            clock: instantClock,
        });

        await expect(runner.store(await verifiedArtifact())).rejects.toMatchObject({
            kind: "configuration",
            statusCode: 500,
        });
        expect(sdk.writeBlobInputs).toHaveLength(1);
    });

    it("does not retry on integrity error", async () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();
        const sdk = new RecordingWalrusSdkClientFactory({
            blobId: "testBlob_123456",
            blobObjectId: validBlobObjectId,
        });
        sdk.failWriteTimes = 1;
        sdk.failWriteError = new SourceArchiverError("hash mismatch", "integrity", 422);
        const runner = new WalrusSdkStoreRunner({ suiPrivateKey: privateKey }, sdk, undefined, {
            clock: instantClock,
        });

        await expect(runner.store(await verifiedArtifact())).rejects.toMatchObject({
            kind: "integrity",
            statusCode: 422,
        });
        expect(sdk.writeBlobInputs).toHaveLength(1);
    });

    it("times out a single attempt and rejects with retryable (real timer)", async () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();
        // SDK that never resolves
        const neverSdk: WalrusSdkStoreClientFactory = {
            create: () => ({
                walrus: {
                    writeBlob: () => new Promise<never>(() => { /* intentionally never resolves */ }),
                },
            }),
        };
        const runner = new WalrusSdkStoreRunner({ suiPrivateKey: privateKey }, neverSdk, undefined, {
            retryPolicy: { perAttemptTimeoutMs: 5, maxAttempts: 1 },
            // no clock override — uses real timers
        });

        await expect(runner.store(await verifiedArtifact())).rejects.toMatchObject({
            kind: "retryable",
        });
    }, 2000);

    it("retries after per-attempt timeout injected via clock", async () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();
        let callCount = 0;
        // clock that simulates timeout on first runWithTimeout call, succeeds on second
        const timeoutOnFirstClock: WalrusStoreClock = {
            sleep: () => Promise.resolve(),
            runWithTimeout: <T>(_ms: number, op: () => Promise<T>): Promise<T> => {
                callCount += 1;
                if (callCount === 1) {
                    return Promise.reject(
                        new SourceArchiverError("timeout", "retryable", 504),
                    ) as Promise<T>;
                }
                return op();
            },
        };
        const sdk = new RecordingWalrusSdkClientFactory({
            blobId: "testBlob_123456",
            blobObjectId: validBlobObjectId,
            txDigest: validTxDigest,
        });
        const runner = new WalrusSdkStoreRunner({ suiPrivateKey: privateKey }, sdk, undefined, {
            retryPolicy: { maxAttempts: 3 },
            clock: timeoutOnFirstClock,
            random: () => 0,
        });

        await expect(runner.store(await verifiedArtifact())).resolves.toMatchObject({
            walrusBlobId: "testBlob_123456",
        });
        // writeBlob is only called during the second runWithTimeout (first was short-circuited)
        expect(sdk.writeBlobInputs).toHaveLength(1);
    });

    it("emits retry log with redacted error message and no private key leakage", async () => {
        const privateKey = Ed25519Keypair.generate().getSecretKey();
        const sdk = new RecordingWalrusSdkClientFactory({
            blobId: "testBlob_123456",
            blobObjectId: validBlobObjectId,
            txDigest: validTxDigest,
        });
        sdk.failWriteTimes = 1;
        sdk.failWriteError = Object.assign(
            new Error(`upload failed private key ${privateKey}`),
            { stack: `Error: upload failed private key ${privateKey}\n    at someFrame` },
        );
        const logger = new RecordingSourceArchiverLogger();
        const runner = new WalrusSdkStoreRunner({ suiPrivateKey: privateKey }, sdk, logger.log, {
            clock: instantClock,
            random: () => 0,
        });

        await expect(runner.store(await verifiedArtifact())).resolves.toMatchObject({
            walrusBlobId: "testBlob_123456",
        });

        const retryEvent = logger.events.find(
            (e) => e.event === "source_archiver.walrus_store.retry",
        );
        expect(retryEvent).toBeDefined();
        if (retryEvent?.event !== "source_archiver.walrus_store.retry") {
            throw new Error("expected retry event");
        }
        expect(retryEvent.errorMessage).toMatch(
            /^\[redacted-sensitive-message sha256=[0-9a-f]{64}\]$/u,
        );
        expect(JSON.stringify(logger.events)).not.toContain(privateKey);
    });
});
