import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
    loadVerifiedSourceArtifact,
    parseSourceArchiverEvent,
    parseWalrusBlobId,
    SourceArchiverError,
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

    it("parses Walrus CLI store output formats", () => {
        expect(parseWalrusBlobId("Success: stored\nBlob ID: testBlob_123456\n")).toBe(
            "testBlob_123456",
        );
        expect(parseWalrusBlobId("Success: stored\ntestBlob_123456\n")).toBe("testBlob_123456");
        expect(() => parseWalrusBlobId("Success: stored\n")).toThrow(SourceArchiverError);
    });

    it("runs walrus store with a temp file containing the source bytes", async () => {
        const command = new RecordingWalrusCommandRunner("Blob ID: testBlob_123456\n");
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
        expect(command.runs[0]?.args[0]).toBe("store");
        expect(command.runs[0]?.args.slice(2)).toEqual(["--epochs", "1"]);
        expect(command.tempFileBytes).toEqual([validBytes]);
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

class RecordingWalrusCommandRunner implements WalrusStoreCommandRunner {
    readonly runs: Array<{
        cliPath: string;
        args: string[];
        timeoutMs: number;
        env?: Record<string, string>;
    }> = [];
    readonly tempFileBytes: Uint8Array[] = [];

    constructor(private readonly stdout: string) {}

    async run(input: {
        cliPath: string;
        args: string[];
        timeoutMs: number;
        env?: Record<string, string>;
    }): Promise<{ stdout: string; stderr: string }> {
        this.runs.push(input);
        const artifactPath = input.args[1];
        if (artifactPath === undefined) {
            throw new Error("artifact path missing");
        }
        this.tempFileBytes.push(new Uint8Array(await readFile(artifactPath)));
        return { stdout: this.stdout, stderr: "" };
    }
}

async function verifiedArtifact() {
    return loadVerifiedSourceArtifact({
        bucket: "sonari-results",
        request: parseSourceArchiverEvent({ body: JSON.stringify(validRequest) }),
        s3: new RecordingS3Reader(validBytes),
    });
}

function sha256Hex(bytes: Uint8Array): string {
    return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}
