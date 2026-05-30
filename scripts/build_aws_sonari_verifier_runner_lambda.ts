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

export async function handler(event: RunnerControlEvent): Promise<unknown> {
    const verifierKind = parseVerifierKind((event as { verifier_kind?: unknown }).verifier_kind);
    return withDomainNitroCommand(verifierKind, async () => {
        if (verifierKind === EARTHQUAKE_VERIFIER_KIND) {
            return earthquakeRunnerControlHandler(event as EarthquakeRunnerControlEvent);
        }
        return membershipRunnerControlHandler(event as MembershipRunnerControlEvent);
    });
}

function parseVerifierKind(input: unknown): VerifierKind {
    if (input === EARTHQUAKE_VERIFIER_KIND || input === MEMBERSHIP_IDENTITY_VERIFIER_KIND) {
        return input;
    }
    throw new Error("verifier_kind must be earthquake or membership_identity");
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
