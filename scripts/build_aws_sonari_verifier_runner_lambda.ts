import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ZipFile } from "yazl";

const DEFAULT_OUTPUT_PATH = "dist/aws/sonari-verifier-runner-lambda.zip";
const DEFAULT_WORK_DIR = ".build/aws-sonari-verifier-runner-lambda";
const ZIP_ENTRY_MTIME = new Date("1980-01-01T00:00:00.000Z");
const REQUIRE_BANNER = [
    'import { createRequire } from "node:module";',
    "const require = createRequire(import.meta.url);",
].join("\n");

const UNIFIED_LAMBDA_ENTRYPOINT = `
export {
    manualHandler,
    scheduledHandler,
} from "./nautilus/verifiers/earthquake/watcher/src/lambda.js";
export {
    batchVerifierHandler,
    submitVerificationHandler,
} from "./nautilus/verifiers/membership/runner/src/lambda.js";
`;

const UNIFIED_RUNNER_WORKFLOW_ENTRYPOINT = `
import {
    DeleteItemCommand,
    DynamoDBClient,
    UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
    acquireSharedRunnerLease,
    buildSharedRunnerLeaseOwner,
    releaseSharedRunnerLease,
    type SharedRunnerLeaseStore,
} from "@sonari/verifier-contracts";
import {
    handler as earthquakeRunnerControlHandler,
    type RunnerControlEvent as EarthquakeRunnerControlEvent,
} from "./nautilus/verifiers/earthquake/watcher/src/runner_workflow.js";
import {
    handler as membershipRunnerControlHandler,
    type RunnerControlEvent as MembershipRunnerControlEvent,
} from "./nautilus/verifiers/membership/runner/src/runner_workflow.js";

const EARTHQUAKE_VERIFIER_KIND = "earthquake";
const MEMBERSHIP_IDENTITY_VERIFIER_KIND = "membership_identity";

type VerifierKind = typeof EARTHQUAKE_VERIFIER_KIND | typeof MEMBERSHIP_IDENTITY_VERIFIER_KIND;
export type RunnerControlEvent = EarthquakeRunnerControlEvent | MembershipRunnerControlEvent;

let leaseStore: SharedRunnerLeaseStore | undefined;

export async function handler(event: RunnerControlEvent): Promise<unknown> {
    const verifierKind = parseVerifierKind((event as { verifier_kind?: unknown }).verifier_kind);
    const action = readAction(event);
    const leaseOwner = buildLeaseOwner(verifierKind, event);
    if (action === "start_instance") {
        const acquired = await acquireRunnerLease(leaseOwner);
        if (!acquired) {
            return buildCapacityBusyResult(verifierKind, event);
        }
        try {
            return await dispatchDomainHandler(verifierKind, event);
        } catch (error) {
            await releaseRunnerLease(leaseOwner);
            throw error;
        }
    }
    if (action === "stop_instance") {
        const ownsLease = await acquireRunnerLease(leaseOwner);
        if (!ownsLease) {
            return buildStopNoopResult(event);
        }
        const stopResult = await dispatchDomainHandler(verifierKind, event);
        await releaseRunnerLease(leaseOwner);
        return stopResult;
    }
    return dispatchDomainHandler(verifierKind, event);
}

async function dispatchDomainHandler(
    verifierKind: VerifierKind,
    event: RunnerControlEvent,
): Promise<unknown> {
    return withDomainNitroCommand(verifierKind, async () => {
        if (verifierKind === EARTHQUAKE_VERIFIER_KIND) {
            return earthquakeRunnerControlHandler(event as EarthquakeRunnerControlEvent);
        }
        return membershipRunnerControlHandler(event as MembershipRunnerControlEvent);
    });
}

function readAction(event: RunnerControlEvent): string {
    const action = (event as { action?: unknown }).action;
    if (typeof action !== "string" || action.length === 0) {
        throw new Error("runner action is required");
    }
    return action;
}

function parseVerifierKind(input: unknown): VerifierKind {
    if (input === EARTHQUAKE_VERIFIER_KIND || input === MEMBERSHIP_IDENTITY_VERIFIER_KIND) {
        return input;
    }
    throw new Error("verifier_kind must be earthquake or membership_identity");
}

function buildLeaseOwner(verifierKind: VerifierKind, event: RunnerControlEvent): string {
    if (verifierKind === EARTHQUAKE_VERIFIER_KIND) {
        const sourceEventId = (event as { source_event_id?: unknown }).source_event_id;
        if (typeof sourceEventId !== "string" || sourceEventId.length === 0) {
            throw new Error("source_event_id is required for earthquake runner lease");
        }
        return buildSharedRunnerLeaseOwner({
            verifierKind,
            workflowId: sourceEventId,
            attempt: readAttempt(event),
        });
    }
    const jobId = (event as { job_id?: unknown }).job_id;
    if (typeof jobId !== "string" || jobId.length === 0) {
        throw new Error("job_id is required for membership runner lease");
    }
    return buildSharedRunnerLeaseOwner({
        verifierKind,
        workflowId: jobId,
        attempt: readAttempt(event),
    });
}

function readAttempt(event: RunnerControlEvent): number {
    const attempt = (event as { attempt?: unknown }).attempt;
    if (attempt === undefined) {
        return 1;
    }
    if (!Number.isInteger(attempt) || attempt < 1) {
        throw new Error("attempt must be a positive integer");
    }
    return attempt;
}

function buildStopNoopResult(event: RunnerControlEvent): Record<string, unknown> {
    const result: Record<string, unknown> = { capacity: 0 };
    copyWorkflowIdentifiers(event, result);
    return result;
}

function buildCapacityBusyResult(
    verifierKind: VerifierKind,
    event: RunnerControlEvent,
): Record<string, unknown> {
    const result: Record<string, unknown> = {
        capacity_busy: true,
        verifier_kind: verifierKind,
    };
    copyWorkflowIdentifiers(event, result);
    return result;
}

function copyWorkflowIdentifiers(
    event: RunnerControlEvent,
    result: Record<string, unknown>,
): void {
    const attempt = (event as { attempt?: unknown }).attempt;
    if (typeof attempt === "number") {
        result.attempt = attempt;
    }
    const sourceEventId = (event as { source_event_id?: unknown }).source_event_id;
    if (typeof sourceEventId === "string") {
        result.source_event_id = sourceEventId;
    }
    const jobId = (event as { job_id?: unknown }).job_id;
    if (typeof jobId === "string") {
        result.job_id = jobId;
    }
}

async function acquireRunnerLease(owner: string): Promise<boolean> {
    try {
        await acquireSharedRunnerLease(runnerLeaseStore(), { owner });
        return true;
    } catch (error) {
        if (isConditionalCheckFailed(error)) {
            return false;
        }
        throw error;
    }
}

async function releaseRunnerLease(owner: string): Promise<boolean> {
    return releaseSharedRunnerLease(runnerLeaseStore(), owner);
}

function runnerLeaseStore(): SharedRunnerLeaseStore {
    leaseStore ??= new DynamoDbSharedRunnerLeaseStore(new DynamoDBClient({}));
    return leaseStore;
}

class DynamoDbSharedRunnerLeaseStore implements SharedRunnerLeaseStore {
    constructor(private readonly dynamo: DynamoDBClient) {}

    async acquire(input: {
        leaseId: string;
        owner: string;
        nowSeconds: number;
        expiresAtSeconds: number;
    }): Promise<void> {
        await this.dynamo.send(
            new UpdateItemCommand({
                TableName: readLeaseTableName(),
                Key: { lease_id: { S: input.leaseId } },
                UpdateExpression: "SET lease_owner = :owner, lease_expires_at = :expires_at",
                ConditionExpression:
                    "attribute_not_exists(lease_id) OR lease_owner = :owner OR lease_expires_at < :now",
                ExpressionAttributeValues: {
                    ":owner": { S: input.owner },
                    ":expires_at": { N: String(input.expiresAtSeconds) },
                    ":now": { N: String(input.nowSeconds) },
                },
            }),
        );
    }

    async release(input: { leaseId: string; owner: string }): Promise<boolean> {
    try {
        await this.dynamo.send(
            new DeleteItemCommand({
                TableName: readLeaseTableName(),
                Key: { lease_id: { S: input.leaseId } },
                ConditionExpression: "lease_owner = :owner",
                ExpressionAttributeValues: {
                    ":owner": { S: input.owner },
                },
            }),
        );
        return true;
    } catch (error) {
        if (isConditionalCheckFailed(error)) {
            return false;
        }
        throw error;
    }
}
}

function readLeaseTableName(): string {
    const value = process.env.RUNNER_LEASE_TABLE_NAME;
    if (value === undefined || value.length === 0) {
        throw new Error("RUNNER_LEASE_TABLE_NAME is required");
    }
    return value;
}

function isConditionalCheckFailed(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "ConditionalCheckFailedException"
    );
}

async function withDomainNitroCommand<T>(
    verifierKind: VerifierKind,
    callback: () => Promise<T>,
): Promise<T> {
    const command = readDomainNitroCommand(verifierKind);
    const previous = process.env.NITRO_ENCLAVE_PROCESS_COMMAND;
    process.env.NITRO_ENCLAVE_PROCESS_COMMAND = command;
    try {
        return await callback();
    } finally {
        if (previous === undefined) {
            delete process.env.NITRO_ENCLAVE_PROCESS_COMMAND;
            return;
        }
        process.env.NITRO_ENCLAVE_PROCESS_COMMAND = previous;
    }
}

function readDomainNitroCommand(verifierKind: VerifierKind): string {
    const envName =
        verifierKind === EARTHQUAKE_VERIFIER_KIND
            ? "EARTHQUAKE_NITRO_ENCLAVE_PROCESS_COMMAND"
            : "MEMBERSHIP_NITRO_ENCLAVE_PROCESS_COMMAND";
    const value = process.env[envName] ?? process.env.NITRO_ENCLAVE_PROCESS_COMMAND;
    if (value === undefined || value.length === 0) {
        throw new Error(\`\${envName} or NITRO_ENCLAVE_PROCESS_COMMAND is required\`);
    }
    return value;
}
`;

const SOURCE_ARCHIVER_ENTRYPOINT = `
export {
    sourceArchiverHandler,
} from "./nautilus/verifiers/earthquake/watcher/src/source_archiver.js";
`;

export interface BuildAwsSonariVerifierRunnerLambdaOptions {
    outPath?: string;
    keepWorkDir?: boolean;
}

interface ParsedArgs extends Required<BuildAwsSonariVerifierRunnerLambdaOptions> {}

interface ZipEntry {
    sourcePath: string;
    zipPath: string;
}

export async function buildAwsSonariVerifierRunnerLambdaArtifact(
    options: BuildAwsSonariVerifierRunnerLambdaOptions = {},
): Promise<string> {
    const outPath = path.resolve(options.outPath ?? DEFAULT_OUTPUT_PATH);
    const workDir = path.resolve(DEFAULT_WORK_DIR);
    const zipEntries: ZipEntry[] = [
        {
            sourcePath: path.join(workDir, "dist/src/lambda.js"),
            zipPath: "dist/src/lambda.js",
        },
        {
            sourcePath: path.join(workDir, "dist/src/runner_workflow.js"),
            zipPath: "dist/src/runner_workflow.js",
        },
        {
            sourcePath: path.join(workDir, "dist/src/source_archiver.js"),
            zipPath: "dist/src/source_archiver.js",
        },
    ];

    await rm(workDir, { recursive: true, force: true });
    await mkdir(path.join(workDir, "dist/src"), { recursive: true });
    await mkdir(path.dirname(outPath), { recursive: true });

    await Promise.all([
        bundleEntrypoint(
            UNIFIED_LAMBDA_ENTRYPOINT,
            "sonari_verifier_runner_lambda.ts",
            path.join(workDir, "dist/src/lambda.js"),
        ),
        bundleEntrypoint(
            UNIFIED_RUNNER_WORKFLOW_ENTRYPOINT,
            "sonari_verifier_runner_workflow.ts",
            path.join(workDir, "dist/src/runner_workflow.js"),
        ),
        bundleEntrypoint(
            SOURCE_ARCHIVER_ENTRYPOINT,
            "sonari_source_archiver.ts",
            path.join(workDir, "dist/src/source_archiver.js"),
        ),
    ]);
    await writeFile(
        path.join(workDir, "package.json"),
        `${JSON.stringify({ type: "module" }, null, 2)}\n`,
        "utf8",
    );
    await createZip(outPath, [
        ...zipEntries,
        {
            sourcePath: path.join(workDir, "package.json"),
            zipPath: "package.json",
        },
    ]);

    if (options.keepWorkDir !== true) {
        await rm(workDir, { recursive: true, force: true });
    }

    return outPath;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
    const options: ParsedArgs = {
        outPath: DEFAULT_OUTPUT_PATH,
        keepWorkDir: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--") {
            continue;
        }
        if (arg === "--keep-work-dir") {
            options.keepWorkDir = true;
            continue;
        }
        if (arg === "--out") {
            const value = argv[index + 1];
            if (value === undefined || value.length === 0) {
                throw new Error("--out requires a path");
            }
            options.outPath = value;
            index += 1;
            continue;
        }
        if (arg?.startsWith("--out=") === true) {
            const value = arg.slice("--out=".length);
            if (value.length === 0) {
                throw new Error("--out requires a path");
            }
            options.outPath = value;
            continue;
        }
        throw new Error(`Unknown argument: ${arg ?? ""}`);
    }

    return options;
}

async function bundleEntrypoint(contents: string, sourcefile: string, outfile: string) {
    await build({
        stdin: {
            contents,
            loader: "ts",
            resolveDir: process.cwd(),
            sourcefile,
        },
        outfile,
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        banner: {
            js: REQUIRE_BANNER,
        },
        packages: "bundle",
        legalComments: "none",
        logLevel: "silent",
    });
}

async function createZip(outPath: string, entries: readonly ZipEntry[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const zipFile = new ZipFile();
        const output = createWriteStream(outPath);

        output.on("close", resolve);
        output.on("error", reject);
        zipFile.outputStream.on("error", reject);
        zipFile.outputStream.pipe(output);

        for (const entry of entries) {
            zipFile.addFile(entry.sourcePath, entry.zipPath, {
                mtime: ZIP_ENTRY_MTIME,
                mode: 0o100644,
            });
        }

        zipFile.end();
    });
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;

if (import.meta.url === mainPath) {
    buildAwsSonariVerifierRunnerLambdaArtifact(parseArgs(process.argv.slice(2)))
        .then(async (outPath) => {
            const stats = await readFile(outPath);
            process.stdout.write(
                `Created ${path.relative(process.cwd(), outPath)} (${stats.byteLength} bytes)\n`,
            );
        })
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`${message}\n`);
            process.exitCode = 1;
        });
}
