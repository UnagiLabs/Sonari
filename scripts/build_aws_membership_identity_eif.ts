import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ARTIFACT_PATH = "dist/aws/membership-identity-tee-artifact.tar.gz";
const DEFAULT_EIF_PATH = "dist/aws/membership-identity-tee.eif";
const DEFAULT_WORK_DIR = ".build/aws-membership-identity-eif";
const DEFAULT_DOCKER_URI = "sonari/membership-identity-tee:local";
const DEFAULT_CPU_COUNT = 2;
const DEFAULT_MEMORY_MIB = 1024;
const DEFAULT_ENCLAVE_CID = 16;
const MEMBERSHIP_TEE_BIN = "/opt/sonari/tee-artifact/bin/membership-tee";
const MEMBERSHIP_TEE_COMMAND = [MEMBERSHIP_TEE_BIN, "server"] as const;

export interface BuildAwsMembershipIdentityEifOptions {
    artifactPath?: string;
    eifPath?: string;
    workDir?: string;
    cpuCount?: number;
    memoryMiB?: number;
    enclaveCid?: number;
    keepWorkDir?: boolean;
}

export interface AwsMembershipIdentityEifBuildPlan {
    artifactPath: string;
    eifPath: string;
    dockerContextDir: string;
    dockerUri: string;
    teeCommand: readonly string[];
    buildEnclaveCommand: readonly string[];
    runEnclaveCommand: readonly string[];
}

interface ParsedArgs extends Required<BuildAwsMembershipIdentityEifOptions> {}

export function createAwsMembershipIdentityEifBuildPlan(
    options: BuildAwsMembershipIdentityEifOptions = {},
): AwsMembershipIdentityEifBuildPlan {
    const artifactPath = path.resolve(options.artifactPath ?? DEFAULT_ARTIFACT_PATH);
    const eifPath = path.resolve(options.eifPath ?? DEFAULT_EIF_PATH);
    const dockerContextDir = path.resolve(options.workDir ?? DEFAULT_WORK_DIR);
    const cpuCount = options.cpuCount ?? DEFAULT_CPU_COUNT;
    const memoryMiB = options.memoryMiB ?? DEFAULT_MEMORY_MIB;
    const enclaveCid = options.enclaveCid ?? DEFAULT_ENCLAVE_CID;

    return {
        artifactPath,
        eifPath,
        dockerContextDir,
        dockerUri: DEFAULT_DOCKER_URI,
        teeCommand: MEMBERSHIP_TEE_COMMAND,
        buildEnclaveCommand: [
            "nitro-cli",
            "build-enclave",
            "--docker-uri",
            DEFAULT_DOCKER_URI,
            "--docker-dir",
            dockerContextDir,
            "--output-file",
            eifPath,
        ],
        runEnclaveCommand: [
            "nitro-cli",
            "run-enclave",
            "--cpu-count",
            String(cpuCount),
            "--memory",
            String(memoryMiB),
            "--enclave-cid",
            String(enclaveCid),
            "--eif-path",
            eifPath,
        ],
    };
}

export async function buildAwsMembershipIdentityEif(
    options: BuildAwsMembershipIdentityEifOptions = {},
): Promise<AwsMembershipIdentityEifBuildPlan> {
    const plan = createAwsMembershipIdentityEifBuildPlan(options);
    const artifactExtractDir = path.join(plan.dockerContextDir, "tee-artifact");

    await rm(plan.dockerContextDir, { recursive: true, force: true });
    await mkdir(artifactExtractDir, { recursive: true });
    await mkdir(path.dirname(plan.eifPath), { recursive: true });
    await run("tar", ["-xzf", plan.artifactPath, "-C", artifactExtractDir]);
    await writeFile(
        path.join(plan.dockerContextDir, "Dockerfile"),
        dockerfileFor(plan.teeCommand),
        "utf8",
    );
    await run(plan.buildEnclaveCommand[0] ?? "nitro-cli", plan.buildEnclaveCommand.slice(1));

    if (options.keepWorkDir !== true) {
        await rm(plan.dockerContextDir, { recursive: true, force: true });
    }

    return plan;
}

function dockerfileFor(teeCommand: readonly string[]): string {
    return [
        "FROM public.ecr.aws/amazonlinux/amazonlinux:2023",
        "COPY tee-artifact/ /opt/sonari/tee-artifact/",
        `ENTRYPOINT ${JSON.stringify(teeCommand)}`,
        "",
    ].join("\n");
}

function parseArgs(argv: readonly string[]): ParsedArgs {
    const options: ParsedArgs = {
        artifactPath: DEFAULT_ARTIFACT_PATH,
        eifPath: DEFAULT_EIF_PATH,
        workDir: DEFAULT_WORK_DIR,
        cpuCount: DEFAULT_CPU_COUNT,
        memoryMiB: DEFAULT_MEMORY_MIB,
        enclaveCid: DEFAULT_ENCLAVE_CID,
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
        if (arg === "--artifact") {
            options.artifactPath = parseValue(argv, index, "--artifact");
            index += 1;
            continue;
        }
        if (arg === "--out") {
            options.eifPath = parseValue(argv, index, "--out");
            index += 1;
            continue;
        }
        if (arg === "--work-dir") {
            options.workDir = parseValue(argv, index, "--work-dir");
            index += 1;
            continue;
        }
        if (arg === "--cpu-count") {
            options.cpuCount = parsePositiveInteger(
                parseValue(argv, index, "--cpu-count"),
                "--cpu-count",
            );
            index += 1;
            continue;
        }
        if (arg === "--memory") {
            options.memoryMiB = parsePositiveInteger(
                parseValue(argv, index, "--memory"),
                "--memory",
            );
            index += 1;
            continue;
        }
        if (arg === "--enclave-cid") {
            options.enclaveCid = parsePositiveInteger(
                parseValue(argv, index, "--enclave-cid"),
                "--enclave-cid",
            );
            index += 1;
            continue;
        }
        if (arg?.startsWith("--artifact=") === true) {
            options.artifactPath = parseInlineValue(arg, "--artifact");
            continue;
        }
        if (arg?.startsWith("--out=") === true) {
            options.eifPath = parseInlineValue(arg, "--out");
            continue;
        }
        if (arg?.startsWith("--work-dir=") === true) {
            options.workDir = parseInlineValue(arg, "--work-dir");
            continue;
        }
        if (arg?.startsWith("--cpu-count=") === true) {
            options.cpuCount = parsePositiveInteger(
                parseInlineValue(arg, "--cpu-count"),
                "--cpu-count",
            );
            continue;
        }
        if (arg?.startsWith("--memory=") === true) {
            options.memoryMiB = parsePositiveInteger(parseInlineValue(arg, "--memory"), "--memory");
            continue;
        }
        if (arg?.startsWith("--enclave-cid=") === true) {
            options.enclaveCid = parsePositiveInteger(
                parseInlineValue(arg, "--enclave-cid"),
                "--enclave-cid",
            );
            continue;
        }
        throw new Error(`Unknown argument: ${arg ?? ""}`);
    }

    return options;
}

function parseValue(argv: readonly string[], index: number, flag: string): string {
    const value = argv[index + 1];
    if (value === undefined || value.length === 0) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function parseInlineValue(arg: string, flag: string): string {
    const value = arg.slice(`${flag}=`.length);
    if (value.length === 0) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function parsePositiveInteger(value: string, flag: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} requires a positive integer`);
    }
    return parsed;
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

function shellJoin(command: readonly string[]): string {
    return command.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
    if (/^[A-Za-z0-9_./:=-]+$/.test(value)) {
        return value;
    }
    return `'${value.replaceAll("'", "'\\''")}'`;
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;

if (import.meta.url === mainPath) {
    buildAwsMembershipIdentityEif(parseArgs(process.argv.slice(2)))
        .then((plan) => {
            process.stdout.write(`Created ${path.relative(process.cwd(), plan.eifPath)}\n`);
            process.stdout.write(`Build command: ${shellJoin(plan.buildEnclaveCommand)}\n`);
            process.stdout.write(`Run command: ${shellJoin(plan.runEnclaveCommand)}\n`);
        })
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`${message}\n`);
            process.exitCode = 1;
        });
}
