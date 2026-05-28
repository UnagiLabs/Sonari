import { writeFile } from "node:fs/promises";
import process from "node:process";

const DEFAULT_PREFIX = "earthquake-runner";
const LAMBDA_ARTIFACT_FILE_NAME = "earthquake-runner-lambda.zip";
const TEE_ARTIFACT_FILE_NAME = "earthquake-tee-artifact.tar.gz";
const DEPLOY_PARAMETER_KEYS = [
    "LambdaCodeS3Bucket",
    "LambdaCodeS3Key",
    "TeeArtifactS3Bucket",
    "TeeArtifactS3Key",
    "TeeArtifactSha256",
    "GitCommitSha",
    "ScheduleState",
] as const;

type DeployParameterKey = (typeof DEPLOY_PARAMETER_KEYS)[number];

export type BuildAwsEarthquakeRunnerDeployPlanInput = {
    commitSha: string;
    lambdaBucket: string;
    teeBucket: string;
    teeArtifactSha256: string;
    prefix?: string;
};

export type AwsEarthquakeRunnerDeployPlan = {
    parameterOverrides: Record<DeployParameterKey, string>;
    parameterOverrideArgs: string[];
};

export function buildAwsEarthquakeRunnerDeployPlan(
    input: BuildAwsEarthquakeRunnerDeployPlanInput,
): AwsEarthquakeRunnerDeployPlan {
    const commitSha = validateCommitSha(input.commitSha);
    const prefix = validateS3KeyPrefix(input.prefix ?? DEFAULT_PREFIX);
    const teeArtifactSha256 = validateSha256(input.teeArtifactSha256);
    const parameterOverrides: Record<DeployParameterKey, string> = {
        LambdaCodeS3Bucket: validateS3Bucket(input.lambdaBucket, "lambda bucket"),
        LambdaCodeS3Key: `${prefix}/${commitSha}/${LAMBDA_ARTIFACT_FILE_NAME}`,
        TeeArtifactS3Bucket: validateS3Bucket(input.teeBucket, "TEE bucket"),
        TeeArtifactS3Key: `${prefix}/${commitSha}/${TEE_ARTIFACT_FILE_NAME}`,
        TeeArtifactSha256: teeArtifactSha256,
        GitCommitSha: commitSha,
        ScheduleState: "DISABLED",
    };

    return {
        parameterOverrides,
        parameterOverrideArgs: DEPLOY_PARAMETER_KEYS.map(
            (key) => `${key}=${parameterOverrides[key]}`,
        ),
    };
}

function validateCommitSha(value: string): string {
    if (!/^[0-9a-f]{40}$/i.test(value)) {
        throw new Error("Invalid commit SHA: expected a 40-character hexadecimal Git commit SHA");
    }
    return value.toLowerCase();
}

function validateSha256(value: string): string {
    if (!/^[0-9a-f]{64}$/i.test(value)) {
        throw new Error("Invalid TEE artifact SHA-256: expected a 64-character hexadecimal digest");
    }
    return value.toLowerCase();
}

function validateS3Bucket(value: string, label: string): string {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) || value.includes("..")) {
        throw new Error(`Invalid ${label}: expected an S3 bucket name`);
    }
    return value;
}

function validateS3KeyPrefix(value: string): string {
    const prefix = value.replace(/^\/+|\/+$/g, "");
    if (
        prefix.length === 0 ||
        prefix.length > 512 ||
        prefix.split("/").some((segment) => segment === "." || segment === "..") ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(prefix)
    ) {
        throw new Error("Invalid artifact prefix: expected a safe relative S3 key prefix");
    }
    return prefix;
}

type CliOptions = {
    commitSha?: string;
    lambdaBucket?: string;
    teeBucket?: string;
    teeArtifactSha256?: string;
    prefix?: string;
    out?: string;
};

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (
        options.commitSha === undefined ||
        options.lambdaBucket === undefined ||
        options.teeBucket === undefined ||
        options.teeArtifactSha256 === undefined
    ) {
        throw new Error(
            "Usage: tsx scripts/aws_earthquake_runner_deploy_plan.ts --commit-sha <sha> --lambda-bucket <bucket> --tee-bucket <bucket> --tee-sha256 <sha256> [--prefix <prefix>] [--out <path>]",
        );
    }

    const plan = buildAwsEarthquakeRunnerDeployPlan({
        commitSha: options.commitSha,
        lambdaBucket: options.lambdaBucket,
        teeBucket: options.teeBucket,
        teeArtifactSha256: options.teeArtifactSha256,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    });
    const serialized = `${JSON.stringify(plan, null, 2)}\n`;

    if (options.out === undefined) {
        process.stdout.write(serialized);
        return;
    }
    await writeFile(options.out, serialized);
}

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {};

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--") {
            continue;
        }
        const next = args[index + 1];
        if (next === undefined) {
            throw new Error(`Missing value for ${arg}`);
        }

        switch (arg) {
            case "--commit-sha":
                options.commitSha = next;
                break;
            case "--lambda-bucket":
                options.lambdaBucket = next;
                break;
            case "--tee-bucket":
                options.teeBucket = next;
                break;
            case "--tee-sha256":
                options.teeArtifactSha256 = next;
                break;
            case "--prefix":
                options.prefix = next;
                break;
            case "--out":
                options.out = next;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
        index += 1;
    }

    return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    });
}
