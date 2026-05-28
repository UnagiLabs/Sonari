import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OUTPUT_PATH = "dist/aws/earthquake-tee-artifact.tar.gz";
const DEFAULT_WORK_DIR = ".build/aws-earthquake-tee-artifact";
const CARGO_MANIFEST_PATH = "nautilus/verifiers/earthquake/tee/Cargo.toml";
const CARGO_TARGET_DIR = "target";
const DEFAULT_CARGO_TARGET = "x86_64-unknown-linux-musl";

export interface BuildAwsEarthquakeTeeArtifactOptions {
    outPath?: string;
    keepWorkDir?: boolean;
}

interface ParsedArgs extends Required<BuildAwsEarthquakeTeeArtifactOptions> {}

export async function buildAwsEarthquakeTeeArtifact(
    options: BuildAwsEarthquakeTeeArtifactOptions = {},
): Promise<{ artifactPath: string; checksumPath: string }> {
    const outPath = path.resolve(options.outPath ?? DEFAULT_OUTPUT_PATH);
    const checksumPath = `${outPath}.sha256`;
    const workDir = path.resolve(DEFAULT_WORK_DIR);
    const cargoTarget = process.env.SONARI_TEE_CARGO_TARGET ?? DEFAULT_CARGO_TARGET;
    const targetBinary = path.resolve(
        process.env.SONARI_TEE_BINARY ?? path.join(CARGO_TARGET_DIR, cargoTarget, "release/tee"),
    );
    const artifactBinary = path.join(workDir, "bin/tee");
    const artifactWalrusBinary = path.join(workDir, "bin/walrus");
    const walrusSourceBinary = await resolveExecutable(process.env.SONARI_WALRUS_CLI ?? "walrus");

    await rm(workDir, { recursive: true, force: true });
    await mkdir(path.dirname(outPath), { recursive: true });
    await mkdir(path.dirname(artifactBinary), { recursive: true });

    if (process.env.SONARI_TEE_BINARY === undefined) {
        await run("cargo", [
            "build",
            "--release",
            "--target",
            cargoTarget,
            "--manifest-path",
            CARGO_MANIFEST_PATH,
            "--target-dir",
            CARGO_TARGET_DIR,
        ]);
    }
    await copyFile(targetBinary, artifactBinary);
    await chmod(artifactBinary, 0o500);
    await copyFile(walrusSourceBinary, artifactWalrusBinary);
    await chmod(artifactWalrusBinary, 0o500);
    await run("tar", [
        "-C",
        workDir,
        "--sort=name",
        "--mtime=UTC 1980-01-01",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        outPath,
        "bin/tee",
        "bin/walrus",
    ]);

    const digest = createHash("sha256")
        .update(await readFile(outPath))
        .digest("hex");
    await writeFile(checksumPath, `${digest}  ${checksumSubject(outPath)}\n`, "utf8");

    if (options.keepWorkDir !== true) {
        await rm(workDir, { recursive: true, force: true });
    }

    return { artifactPath: outPath, checksumPath };
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

function checksumSubject(outPath: string): string {
    const relative = path.relative(process.cwd(), outPath);
    if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative;
    }
    return outPath;
}

async function run(command: string, args: readonly string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: process.cwd(),
            stdio: "inherit",
        });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    signal === null
                        ? `${command} exited with code ${code ?? "unknown"}`
                        : `${command} exited with signal ${signal}`,
                ),
            );
        });
    });
}

async function resolveExecutable(command: string): Promise<string> {
    if (command.includes("/")) {
        return path.resolve(command);
    }

    return new Promise<string>((resolve, reject) => {
        const child = spawn("sh", ["-c", `command -v "$1"`, "sh", command], {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "inherit"],
        });
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
            if (code === 0) {
                const resolved = stdout.trim();
                if (resolved.length === 0) {
                    reject(new Error(`Unable to resolve executable: ${command}`));
                    return;
                }
                resolve(resolved);
                return;
            }
            reject(
                new Error(
                    signal === null
                        ? `Unable to resolve executable ${command}: command -v exited with code ${code ?? "unknown"}`
                        : `Unable to resolve executable ${command}: command -v exited with signal ${signal}`,
                ),
            );
        });
    });
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;

if (import.meta.url === mainPath) {
    buildAwsEarthquakeTeeArtifact(parseArgs(process.argv.slice(2)))
        .then(({ artifactPath, checksumPath }) => {
            process.stdout.write(`Created ${path.relative(process.cwd(), artifactPath)}\n`);
            process.stdout.write(`Created ${path.relative(process.cwd(), checksumPath)}\n`);
        })
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`${message}\n`);
            process.exitCode = 1;
        });
}
