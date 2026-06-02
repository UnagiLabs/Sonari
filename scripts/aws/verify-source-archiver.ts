import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
    type AwsCli,
    assertAsgIdle,
    assertExpectedAccount,
    assertSchedulesDisabled,
    DEFAULT_EXPECTED_ACCOUNT,
    DEFAULT_REGION,
    DEFAULT_STACK,
    describeStack,
    ExecFileAwsCli,
    isRecord,
    type PollOptions,
    parseArgs,
    parseStackOutputs,
    parseStackParameters,
    readStringOption,
    requireOutput,
    waitFor,
} from "./shared.js";

const execFileAsync = promisify(execFile);

const DEFAULT_N_SHARDS = 1000;
const DEFAULT_ARTIFACT_BYTES = new TextEncoder().encode(
    "sonari source archiver verification artifact\n",
);

export type VerifySourceArchiverOptions = {
    aws?: AwsCli;
    stack?: string;
    expectedAccount?: string;
    region?: string;
    walrusCli?: string;
    nShards?: number;
    nowMs?: () => number;
    artifactBytes?: Uint8Array;
    blobIdForBytes?: (bytes: Uint8Array) => Promise<string>;
    poll?: PollOptions;
};

export type VerifySourceArchiverResult = {
    sourceArchiverLambdaName: string;
    sourceArchiverUrl: string;
    resultBucket: string;
    artifactS3Key: string;
    expectedWalrusBlobId: string;
    walrusBlobId: string;
    successLogEvents: number;
    idle: true;
};

export async function runVerifySourceArchiver(
    options: VerifySourceArchiverOptions = {},
): Promise<VerifySourceArchiverResult> {
    const aws = options.aws ?? new ExecFileAwsCli(options.region ?? DEFAULT_REGION);
    const stack = options.stack ?? DEFAULT_STACK;
    const expectedAccount = options.expectedAccount ?? DEFAULT_EXPECTED_ACCOUNT;
    const poll = options.poll ?? { intervalMs: 5_000, timeoutMs: 2 * 60_000 };
    const nowMs = options.nowMs ?? Date.now;
    const artifactBytes = options.artifactBytes ?? DEFAULT_ARTIFACT_BYTES;
    const startedAtMs = nowMs();

    await assertExpectedAccount(aws, expectedAccount);
    const stackResponse = await describeStack(aws, stack);
    const outputs = parseStackOutputs(stackResponse);
    const parameters = parseStackParameters(stackResponse);
    await assertSchedulesDisabled(aws, outputs);

    assertSourceArchiverConfigured(stack, parameters, outputs);
    const sourceArchiverLambdaName = requireOutput(outputs, "SourceArchiverLambdaName");
    const sourceArchiverUrl = requireOutput(outputs, "SourceArchiverFunctionUrlOutput");
    const resultBucket = requireOutput(outputs, "RunnerResultBucketName");
    const sourceArchiverTokenSecretArn = requireParameter(
        parameters,
        "SourceArchiverTokenSecretArn",
    );
    const sourceArchiverWalrusSecretArn = requireParameter(
        parameters,
        "SourceArchiverWalrusEnvSecretArn",
    );
    const token = await getSecretString(aws, sourceArchiverTokenSecretArn);
    const walrusSecret = await getSecretString(aws, sourceArchiverWalrusSecretArn);
    const forbiddenLogValues = secretValuesForLogLeakCheck([
        token,
        ...secretStringValues(walrusSecret),
    ]);
    const expectedWalrusBlobId =
        options.blobIdForBytes === undefined
            ? await walrusBlobIdForBytes(artifactBytes, {
                  walrusCli: options.walrusCli ?? process.env.SONARI_WALRUS_CLI ?? "walrus",
                  nShards: options.nShards ?? DEFAULT_N_SHARDS,
              })
            : await options.blobIdForBytes(artifactBytes);
    const sourceHash = `0x${createHash("sha256").update(artifactBytes).digest("hex")}`;
    const artifactS3Key = `source-artifacts/source-archiver-verification/${startedAtMs}-artifact.bin`;

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "sonari-source-archiver-verify-"));
    try {
        const artifactPath = path.join(tempDir, "source-artifact.bin");
        const responsePath = path.join(tempDir, "source-archiver-response.json");
        await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
        await aws.json([
            "s3api",
            "put-object",
            "--bucket",
            resultBucket,
            "--key",
            artifactS3Key,
            "--body",
            artifactPath,
            "--content-type",
            "application/octet-stream",
        ]);

        await aws.json([
            "lambda",
            "invoke",
            "--function-name",
            sourceArchiverLambdaName,
            "--payload",
            JSON.stringify({
                headers: { "x-sonari-source-archiver-token": token },
                body: JSON.stringify({
                    artifact_s3_key: artifactS3Key,
                    expected_walrus_blob_id: expectedWalrusBlobId,
                    source_hash: sourceHash,
                    size_bytes: artifactBytes.byteLength,
                }),
            }),
            "--cli-binary-format",
            "raw-in-base64-out",
            responsePath,
        ]);
        const walrusBlobId = readWalrusBlobIdFromLambdaResponse(
            JSON.parse(await readFile(responsePath, "utf8")) as unknown,
        );
        if (walrusBlobId !== expectedWalrusBlobId) {
            throw new Error("SourceArchiver returned a Walrus blob id mismatch");
        }

        const successLogEvents = await waitFor(
            "SourceArchiver Walrus success log",
            poll,
            async () => {
                const events = readLogMessages(
                    await aws.json([
                        "logs",
                        "filter-log-events",
                        "--log-group-name",
                        `/aws/lambda/${sourceArchiverLambdaName}`,
                        "--start-time",
                        String(startedAtMs),
                        "--filter-pattern",
                        '"source_archiver.walrus_store.success"',
                    ]),
                ).filter(
                    (message) =>
                        message.includes("source_archiver.walrus_store.success") &&
                        message.includes(artifactS3Key) &&
                        message.includes(expectedWalrusBlobId),
                );
                return events.length > 0 ? events : null;
            },
        );

        const allLogMessages = readLogMessages(
            await aws.json([
                "logs",
                "filter-log-events",
                "--log-group-name",
                `/aws/lambda/${sourceArchiverLambdaName}`,
                "--start-time",
                String(startedAtMs),
            ]),
        );
        assertNoForbiddenLogValues(allLogMessages.join("\n"), forbiddenLogValues);

        await assertAsgIdle(aws, requireOutput(outputs, "RunnerAutoScalingGroupName"));
        await assertSchedulesDisabled(aws, outputs);

        return {
            sourceArchiverLambdaName,
            sourceArchiverUrl,
            resultBucket,
            artifactS3Key,
            expectedWalrusBlobId,
            walrusBlobId,
            successLogEvents: successLogEvents.length,
            idle: true,
        };
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true) {
        process.stdout.write(
            "Usage: pnpm aws:verify:source-archiver -- [--stack <name>] [--expected-account <id>] [--region <region>] [--walrus-cli <path>] [--n-shards <count>]\n",
        );
        return;
    }
    const result = await runVerifySourceArchiver({
        stack: readStringOption(args, "stack", DEFAULT_STACK),
        expectedAccount: readStringOption(args, "expected-account", DEFAULT_EXPECTED_ACCOUNT),
        region: readStringOption(args, "region", DEFAULT_REGION),
        walrusCli: readStringOption(args, "walrus-cli", process.env.SONARI_WALRUS_CLI ?? "walrus"),
        nShards: readPositiveIntegerOption(args, "n-shards", DEFAULT_N_SHARDS),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function walrusBlobIdForBytes(
    bytes: Uint8Array,
    input: { walrusCli: string; nShards: number },
): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "sonari-walrus-blob-id-"));
    try {
        const artifactPath = path.join(tempDir, "source-artifact.bin");
        await writeFile(artifactPath, bytes, { mode: 0o600 });
        const { stdout } = await execFileAsync(input.walrusCli, [
            "blob-id",
            "--n-shards",
            String(input.nShards),
            artifactPath,
        ]);
        return parseWalrusBlobIdOutput(stdout);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

export function parseWalrusBlobIdOutput(stdout: string): string {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
        throw new Error("walrus blob-id returned empty output");
    }
    const parsedJson = parseJsonWalrusBlobIdOutput(trimmed);
    if (parsedJson !== undefined) {
        return parsedJson;
    }
    const labeled = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.startsWith("Blob ID:"))
        ?.slice("Blob ID:".length)
        .trim();
    if (labeled !== undefined && labeled.length > 0) {
        return labeled;
    }
    const lastLine = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1);
    if (lastLine === undefined) {
        throw new Error("walrus blob-id returned empty output");
    }
    return lastLine;
}

function parseJsonWalrusBlobIdOutput(stdout: string): string | undefined {
    try {
        const parsed = JSON.parse(stdout) as unknown;
        if (typeof parsed === "string" && parsed.length > 0) {
            return parsed;
        }
        if (isRecord(parsed)) {
            if (typeof parsed.blobId === "string" && parsed.blobId.length > 0) {
                return parsed.blobId;
            }
            if (typeof parsed.blob_id === "string" && parsed.blob_id.length > 0) {
                return parsed.blob_id;
            }
        }
        return undefined;
    } catch {
        if (stdout.startsWith("{") || stdout.startsWith("[")) {
            throw new Error("walrus blob-id returned malformed JSON output");
        }
        return undefined;
    }
}

async function getSecretString(aws: AwsCli, secretArn: string): Promise<string> {
    const response = await aws.json([
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        secretArn,
    ]);
    if (!isRecord(response) || typeof response.SecretString !== "string") {
        throw new Error(`Secret ${secretArn} did not contain SecretString`);
    }
    return response.SecretString;
}

function readWalrusBlobIdFromLambdaResponse(value: unknown): string {
    if (!isRecord(value) || typeof value.statusCode !== "number") {
        throw new Error("SourceArchiver Lambda response must include statusCode");
    }
    if (value.statusCode !== 200) {
        throw new Error(`SourceArchiver Lambda returned statusCode ${value.statusCode}`);
    }
    if (typeof value.body !== "string") {
        throw new Error("SourceArchiver Lambda response body must be a string");
    }
    const body = JSON.parse(value.body) as unknown;
    if (!isRecord(body) || typeof body.walrus_blob_id !== "string") {
        throw new Error("SourceArchiver Lambda response body did not include walrus_blob_id");
    }
    return body.walrus_blob_id;
}

function readLogMessages(value: unknown): string[] {
    if (!isRecord(value) || !Array.isArray(value.events)) {
        return [];
    }
    return value.events
        .filter(isRecord)
        .map((event) => event.message)
        .filter((message): message is string => typeof message === "string");
}

function secretStringValues(secretString: string): string[] {
    try {
        const parsed = JSON.parse(secretString) as unknown;
        if (!isRecord(parsed)) {
            return [secretString];
        }
        return Object.values(parsed).filter((value): value is string => typeof value === "string");
    } catch {
        return [secretString];
    }
}

function secretValuesForLogLeakCheck(values: readonly string[]): string[] {
    return values.filter((value) => value.length >= 8);
}

function assertNoForbiddenLogValues(logText: string, forbiddenValues: readonly string[]): void {
    if (forbiddenValues.some((value) => logText.includes(value))) {
        throw new Error("CloudWatch logs contained forbidden SourceArchiver secret material");
    }
}

function requireParameter(parameters: Record<string, string>, key: string): string {
    const value = parameters[key];
    if (value === undefined || value.length === 0) {
        throw new Error(`CloudFormation parameter ${key} is required`);
    }
    return value;
}

function assertSourceArchiverConfigured(
    stack: string,
    parameters: Record<string, string>,
    outputs: Record<string, string | undefined>,
): void {
    const requiredParameters = [
        "SourceArchiverTokenSecretArn",
        "SourceArchiverWalrusEnvSecretArn",
        "SourceArchiverWalrusLayerArn",
    ];
    const requiredOutputs = ["SourceArchiverLambdaName", "SourceArchiverFunctionUrlOutput"];
    const missingParameters = requiredParameters.filter((key) => {
        const value = parameters[key];
        return value === undefined || value.length === 0;
    });
    const missingOutputs = requiredOutputs.filter((key) => {
        const value = outputs[key];
        return value === undefined || value.length === 0;
    });
    if (missingParameters.length > 0 || missingOutputs.length > 0) {
        throw new Error(
            [
                `SourceArchiver is not configured for stack ${stack}`,
                `set ${requiredParameters.join(", ")}`,
            ].join(": "),
        );
    }
}

function readPositiveIntegerOption(
    options: Record<string, string | boolean>,
    key: string,
    fallback: number,
): number {
    const value = options[key];
    if (value === undefined || value === false) {
        return fallback;
    }
    if (typeof value !== "string") {
        throw new Error(`--${key} requires a value`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`--${key} must be a positive integer`);
    }
    return parsed;
}

if (process.argv[1]?.endsWith("verify-source-archiver.ts")) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
