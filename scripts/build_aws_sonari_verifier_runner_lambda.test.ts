import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AWS Sonari verifier runner Lambda artifact builder", () => {
    it("creates one Lambda zip with both domains and unified runner control", async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), "sonari-verifier-lambda-zip-"));
        tempDirs.push(tempDir);
        const outPath = path.join(tempDir, "custom", "sonari-verifier-runner-lambda.zip");

        await execFileAsync("pnpm", [
            "tsx",
            "scripts/build_aws_sonari_verifier_runner_lambda.ts",
            "--out",
            outPath,
        ]);

        const entries = await readZipEntries(outPath);

        expect([...entries.keys()].sort()).toEqual(
            expect.arrayContaining([
                "dist/src/lambda.js",
                "dist/src/runner_workflow.js",
                "dist/src/source_archiver.js",
                "node_modules/@mysten/walrus-wasm/index.js",
                "node_modules/@mysten/walrus-wasm/index.mjs",
                "node_modules/@mysten/walrus-wasm/nodejs/walrus_wasm.js",
                "node_modules/@mysten/walrus-wasm/nodejs/walrus_wasm_bg.wasm",
                "node_modules/@mysten/walrus-wasm/package.json",
                "package.json",
            ]),
        );
        expect([...entries.keys()].filter((entry) => entry.startsWith("dist/src/")).sort()).toEqual(
            ["dist/src/lambda.js", "dist/src/runner_workflow.js", "dist/src/source_archiver.js"],
        );
        expect(JSON.parse(entries.get("package.json")?.toString("utf8") ?? "")).toEqual({
            type: "module",
        });

        const lambdaJs = entries.get("dist/src/lambda.js")?.toString("utf8") ?? "";
        const runnerWorkflowJs = entries.get("dist/src/runner_workflow.js")?.toString("utf8") ?? "";
        const sourceArchiverJs = entries.get("dist/src/source_archiver.js")?.toString("utf8") ?? "";

        expect(lambdaJs).toContain("scheduledHandler");
        expect(lambdaJs).toContain("manualHandler");
        expect(lambdaJs).toContain("submitVerificationHandler");
        expect(lambdaJs).toContain("batchVerifierHandler");
        expect(lambdaJs).toContain("jobStreamHandler");
        expect(lambdaJs).toContain("createRequire(import.meta.url)");
        expect(runnerWorkflowJs).toContain("handler");
        expect(runnerWorkflowJs).toContain("earthquake");
        expect(runnerWorkflowJs).toContain("membership_identity");
        expect(runnerWorkflowJs).toContain("EARTHQUAKE_NITRO_ENCLAVE_PROCESS_COMMAND");
        expect(runnerWorkflowJs).toContain("MEMBERSHIP_NITRO_ENCLAVE_PROCESS_COMMAND");
        expect(runnerWorkflowJs).toContain("RUNNER_LEASE_TABLE_NAME");
        expect(runnerWorkflowJs).toContain("UpdateItemCommand");
        expect(runnerWorkflowJs).toContain("DeleteItemCommand");
        expect(runnerWorkflowJs).toContain("function runnerLeaseStore()");
        expect(sourceArchiverJs).toContain("sourceArchiverHandler");
        expect(sourceArchiverJs).toContain("SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN");
        expect(sourceArchiverJs).toContain("SOURCE_ARCHIVER_TOKEN_SECRET_ARN");
        expect(sourceArchiverJs).toContain("WalrusSdkStoreRunner");
        expect(sourceArchiverJs).toContain('from "@mysten/walrus-wasm"');
        expect(sourceArchiverJs).not.toContain("WalrusCliStoreRunner");
        expect(runnerWorkflowJs).not.toContain(
            "const leaseStore = new DynamoDbSharedRunnerLeaseStore",
        );
        expect(runnerWorkflowJs).toContain("capacity_busy");
        expect(runnerWorkflowJs).toContain("verifier_kind: verifierKind");
        expect(runnerWorkflowJs).toContain("ConditionalCheckFailedException");
        expect(runnerWorkflowJs).toContain("createRequire(import.meta.url)");
        expect(lambdaJs).not.toContain("workspace:");
        expect(runnerWorkflowJs).not.toContain("workspace:");
    });

    it("keeps the shared lease held until owner stop completes", async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), "sonari-verifier-lambda-zip-"));
        tempDirs.push(tempDir);
        const outPath = path.join(tempDir, "custom", "sonari-verifier-runner-lambda.zip");

        await execFileAsync("pnpm", [
            "tsx",
            "scripts/build_aws_sonari_verifier_runner_lambda.ts",
            "--out",
            outPath,
        ]);

        const entries = await readZipEntries(outPath);
        const runnerWorkflowJs = entries.get("dist/src/runner_workflow.js")?.toString("utf8") ?? "";
        const stopDispatchIndex = runnerWorkflowJs.indexOf(
            "const stopResult = await dispatchDomainHandler",
        );
        const releaseAfterStopIndex = runnerWorkflowJs.indexOf(
            "await releaseRunnerLease",
            stopDispatchIndex,
        );
        const capacityBusyIndex = runnerWorkflowJs.indexOf("buildCapacityBusyResult");

        expect(stopDispatchIndex).toBeGreaterThan(-1);
        expect(releaseAfterStopIndex).toBeGreaterThan(stopDispatchIndex);
        expect(capacityBusyIndex).toBeGreaterThan(-1);
    });

    it("accepts pnpm's argument separator through the root package script", async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), "sonari-verifier-lambda-zip-"));
        tempDirs.push(tempDir);
        const outPath = path.join(tempDir, "custom", "sonari-verifier-runner-lambda.zip");

        await execFileAsync("pnpm", [
            "build:aws-sonari-verifier-runner-lambda",
            "--",
            "--out",
            outPath,
        ]);

        const entries = await readZipEntries(outPath);

        expect([...entries.keys()].sort()).toEqual(
            expect.arrayContaining([
                "dist/src/lambda.js",
                "dist/src/runner_workflow.js",
                "dist/src/source_archiver.js",
                "node_modules/@mysten/walrus-wasm/nodejs/walrus_wasm_bg.wasm",
                "package.json",
            ]),
        );
        expect([...entries.keys()].filter((entry) => entry.startsWith("dist/src/")).sort()).toEqual(
            ["dist/src/lambda.js", "dist/src/runner_workflow.js", "dist/src/source_archiver.js"],
        );
    });
});

async function readZipEntries(zipPath: string): Promise<Map<string, Buffer>> {
    const buffer = await readFile(zipPath);
    const eocdOffset = findEndOfCentralDirectory(buffer);
    const entryCount = buffer.readUInt16LE(eocdOffset + 10);
    const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
    const entries = new Map<string, Buffer>();
    let offset = centralDirectoryOffset;

    for (let index = 0; index < entryCount; index += 1) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error(`Invalid central directory header at ${offset}`);
        }

        const compressionMethod = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const fileNameLength = buffer.readUInt16LE(offset + 28);
        const extraFieldLength = buffer.readUInt16LE(offset + 30);
        const fileCommentLength = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        const nameStart = offset + 46;
        const name = buffer.toString("utf8", nameStart, nameStart + fileNameLength);

        entries.set(
            name,
            readLocalFile(buffer, localHeaderOffset, compressedSize, compressionMethod),
        );
        offset = nameStart + fileNameLength + extraFieldLength + fileCommentLength;
    }

    return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
    for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
        if (buffer.readUInt32LE(offset) === 0x06054b50) {
            return offset;
        }
    }
    throw new Error("ZIP end of central directory record not found");
}

function readLocalFile(
    buffer: Buffer,
    localHeaderOffset: number,
    compressedSize: number,
    compressionMethod: number,
): Buffer {
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`Invalid local file header at ${localHeaderOffset}`);
    }
    const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const extraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) {
        return Buffer.from(compressed);
    }
    if (compressionMethod === 8) {
        return inflateRawSync(compressed);
    }
    throw new Error(`Unsupported ZIP compression method ${compressionMethod}`);
}
