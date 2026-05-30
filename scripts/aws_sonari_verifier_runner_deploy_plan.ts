import { writeFile } from "node:fs/promises";
import process from "node:process";

const DEFAULT_PREFIX = "sonari-verifier-runner";
const LAMBDA_ARTIFACT_FILE_NAME = "sonari-verifier-runner-lambda.zip";
const EARTHQUAKE_TEE_ARTIFACT_FILE_NAME = "earthquake-tee-artifact.tar.gz";
const MEMBERSHIP_TEE_ARTIFACT_FILE_NAME = "membership-identity-tee-artifact.tar.gz";
const MEMBERSHIP_EIF_FILE_NAME = "membership-identity-tee.eif";
const DEPLOY_PARAMETER_KEYS = [
    "LambdaCodeS3Bucket",
    "LambdaCodeS3Key",
    "TeeArtifactS3Bucket",
    "TeeArtifactS3Key",
    "TeeArtifactSha256",
    "MembershipTeeArtifactS3Bucket",
    "MembershipTeeArtifactS3Key",
    "MembershipTeeArtifactSha256",
    "TeeEifS3Bucket",
    "TeeEifS3Key",
    "TeeEifSha256",
    "GitCommitSha",
    "ScheduleState",
] as const;

type DeployParameterKey = (typeof DEPLOY_PARAMETER_KEYS)[number];
type SuiNetwork = "mainnet" | "testnet" | "devnet";
type WorldIdProofMode = "real" | "dummy";

export type BuildAwsSonariVerifierRunnerDeployPlanInput = {
    commitSha: string;
    lambdaBucket: string;
    earthquakeTeeBucket: string;
    earthquakeTeeArtifactSha256: string;
    membershipTeeBucket: string;
    membershipTeeArtifactSha256: string;
    membershipEifBucket: string;
    membershipEifSha256: string;
    relayerNetwork?: SuiNetwork;
    worldIdProofMode?: WorldIdProofMode;
    prefix?: string;
};

export type AwsSonariVerifierRunnerDeployPlan = {
    parameterOverrides: Record<DeployParameterKey, string>;
    parameterOverrideArgs: string[];
};

export function buildAwsSonariVerifierRunnerDeployPlan(
    input: BuildAwsSonariVerifierRunnerDeployPlanInput,
): AwsSonariVerifierRunnerDeployPlan {
    const commitSha = validateCommitSha(input.commitSha);
    const prefix = validateS3KeyPrefix(input.prefix ?? DEFAULT_PREFIX);
    validateWorldIdProofMode(input.relayerNetwork, input.worldIdProofMode);

    const parameterOverrides: Record<DeployParameterKey, string> = {
        LambdaCodeS3Bucket: validateS3Bucket(input.lambdaBucket, "lambda bucket"),
        LambdaCodeS3Key: `${prefix}/${commitSha}/${LAMBDA_ARTIFACT_FILE_NAME}`,
        TeeArtifactS3Bucket: validateS3Bucket(input.earthquakeTeeBucket, "earthquake TEE bucket"),
        TeeArtifactS3Key: `${prefix}/${commitSha}/${EARTHQUAKE_TEE_ARTIFACT_FILE_NAME}`,
        TeeArtifactSha256: validateSha256(
            input.earthquakeTeeArtifactSha256,
            "earthquake TEE artifact SHA-256",
        ),
        MembershipTeeArtifactS3Bucket: validateS3Bucket(
            input.membershipTeeBucket,
            "membership TEE bucket",
        ),
        MembershipTeeArtifactS3Key: `${prefix}/${commitSha}/${MEMBERSHIP_TEE_ARTIFACT_FILE_NAME}`,
        MembershipTeeArtifactSha256: validateSha256(
            input.membershipTeeArtifactSha256,
            "membership TEE artifact SHA-256",
        ),
        TeeEifS3Bucket: validateS3Bucket(input.membershipEifBucket, "membership EIF bucket"),
        TeeEifS3Key: `${prefix}/${commitSha}/${MEMBERSHIP_EIF_FILE_NAME}`,
        TeeEifSha256: validateSha256(input.membershipEifSha256, "membership EIF SHA-256"),
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

function validateSha256(value: string, label: string): string {
    if (!/^[0-9a-f]{64}$/i.test(value)) {
        throw new Error(`Invalid ${label}: expected a 64-character hexadecimal digest`);
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

function validateWorldIdProofMode(
    relayerNetwork: SuiNetwork | undefined,
    worldIdProofMode: WorldIdProofMode | undefined,
): void {
    if (relayerNetwork === "mainnet" && worldIdProofMode === "dummy") {
        throw new Error("dummy World ID proof mode is not allowed on mainnet");
    }
}

type CliOptions = {
    commitSha?: string;
    lambdaBucket?: string;
    earthquakeTeeBucket?: string;
    earthquakeTeeArtifactSha256?: string;
    membershipTeeBucket?: string;
    membershipTeeArtifactSha256?: string;
    membershipEifBucket?: string;
    membershipEifSha256?: string;
    relayerNetwork?: SuiNetwork;
    worldIdProofMode?: WorldIdProofMode;
    prefix?: string;
    out?: string;
};

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (
        options.commitSha === undefined ||
        options.lambdaBucket === undefined ||
        options.earthquakeTeeBucket === undefined ||
        options.earthquakeTeeArtifactSha256 === undefined ||
        options.membershipTeeBucket === undefined ||
        options.membershipTeeArtifactSha256 === undefined ||
        options.membershipEifBucket === undefined ||
        options.membershipEifSha256 === undefined
    ) {
        throw new Error(
            [
                "Usage: tsx scripts/aws_sonari_verifier_runner_deploy_plan.ts",
                "--commit-sha <sha>",
                "--lambda-bucket <bucket>",
                "--earthquake-tee-bucket <bucket>",
                "--earthquake-tee-sha256 <sha256>",
                "--membership-tee-bucket <bucket>",
                "--membership-tee-sha256 <sha256>",
                "--membership-eif-bucket <bucket>",
                "--membership-eif-sha256 <sha256>",
                "[--relayer-network <mainnet|testnet|devnet>]",
                "[--world-id-proof-mode <real|dummy>]",
                "[--prefix <prefix>]",
                "[--out <path>]",
            ].join(" "),
        );
    }

    const plan = buildAwsSonariVerifierRunnerDeployPlan({
        commitSha: options.commitSha,
        lambdaBucket: options.lambdaBucket,
        earthquakeTeeBucket: options.earthquakeTeeBucket,
        earthquakeTeeArtifactSha256: options.earthquakeTeeArtifactSha256,
        membershipTeeBucket: options.membershipTeeBucket,
        membershipTeeArtifactSha256: options.membershipTeeArtifactSha256,
        membershipEifBucket: options.membershipEifBucket,
        membershipEifSha256: options.membershipEifSha256,
        ...(options.relayerNetwork === undefined ? {} : { relayerNetwork: options.relayerNetwork }),
        ...(options.worldIdProofMode === undefined
            ? {}
            : { worldIdProofMode: options.worldIdProofMode }),
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
            case "--earthquake-tee-bucket":
                options.earthquakeTeeBucket = next;
                break;
            case "--earthquake-tee-sha256":
                options.earthquakeTeeArtifactSha256 = next;
                break;
            case "--membership-tee-bucket":
                options.membershipTeeBucket = next;
                break;
            case "--membership-tee-sha256":
                options.membershipTeeArtifactSha256 = next;
                break;
            case "--membership-eif-bucket":
                options.membershipEifBucket = next;
                break;
            case "--membership-eif-sha256":
                options.membershipEifSha256 = next;
                break;
            case "--relayer-network":
                options.relayerNetwork = parseSuiNetwork(next);
                break;
            case "--world-id-proof-mode":
                options.worldIdProofMode = parseWorldIdProofMode(next);
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

function parseSuiNetwork(value: string): SuiNetwork {
    if (value === "mainnet" || value === "testnet" || value === "devnet") {
        return value;
    }
    throw new Error("--relayer-network must be mainnet, testnet, or devnet");
}

function parseWorldIdProofMode(value: string): WorldIdProofMode {
    if (value === "real" || value === "dummy") {
        return value;
    }
    throw new Error("--world-id-proof-mode must be real or dummy");
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    });
}
