import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ZipFile } from "yazl";

const DEFAULT_OUTPUT_PATH = "dist/aws/earthquake-runner-lambda.zip";
const DEFAULT_WORK_DIR = ".build/aws-earthquake-lambda";
const WATCHER_SRC_DIR = "nautilus/verifiers/earthquake/watcher/src";
const ZIP_ENTRY_MTIME = new Date("1980-01-01T00:00:00.000Z");

export interface BuildAwsEarthquakeLambdaOptions {
    outPath?: string;
    keepWorkDir?: boolean;
}

interface ParsedArgs extends Required<BuildAwsEarthquakeLambdaOptions> {}

interface ZipEntry {
    sourcePath: string;
    zipPath: string;
}

export async function buildAwsEarthquakeLambdaArtifact(
    options: BuildAwsEarthquakeLambdaOptions = {},
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
        bundleEntrypoint("lambda.ts", path.join(workDir, "dist/src/lambda.js")),
        bundleEntrypoint("runner_workflow.ts", path.join(workDir, "dist/src/runner_workflow.js")),
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

async function bundleEntrypoint(entrypoint: "lambda.ts" | "runner_workflow.ts", outfile: string) {
    await build({
        entryPoints: [path.resolve(WATCHER_SRC_DIR, entrypoint)],
        outfile,
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
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
    buildAwsEarthquakeLambdaArtifact(parseArgs(process.argv.slice(2)))
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
