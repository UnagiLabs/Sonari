import { writeFile } from "node:fs/promises";
import process from "node:process";

const DEFAULT_PREFIX = "sonari-verifier-runner";
const LAMBDA_ARTIFACT_FILE_NAME = "sonari-verifier-runner-lambda.zip";
const EARTHQUAKE_TEE_ARTIFACT_FILE_NAME = "earthquake-tee-artifact.tar.gz";
const EARTHQUAKE_EIF_FILE_NAME = "earthquake-tee.eif";
const MEMBERSHIP_TEE_ARTIFACT_FILE_NAME = "membership-identity-tee-artifact.tar.gz";
const MEMBERSHIP_EIF_FILE_NAME = "membership-identity-tee.eif";
const CENSUS_TEE_ARTIFACT_FILE_NAME = "census-tee-artifact.tar.gz";
const CENSUS_EIF_FILE_NAME = "census-tee.eif";
const DEFAULT_SOURCE_ARCHIVER_SUI_NETWORK = "testnet";
const DEFAULT_SOURCE_ARCHIVER_SUI_RPC_URL = "https://fullnode.testnet.sui.io:443";
const DEFAULT_SOURCE_ARCHIVER_WALRUS_UPLOAD_RELAY_URL = "https://upload-relay.testnet.walrus.space";
const DEFAULT_SOURCE_ARCHIVER_WALRUS_UPLOAD_RELAY_TIP_MAX_MIST = "1000";
const DEFAULT_SOURCE_ARCHIVER_WALRUS_EPOCHS = "1";
const DEFAULT_SOURCE_ARCHIVER_WALRUS_DELETABLE = false;
const DEFAULT_WORLD_ID_PROOF_MODE = "real";
const DEFAULT_WORLD_ID_ACTION = "sonari_membership_register_v2";
const DEFAULT_NITRO_ENCLAVE_MEMORY_MIB = 4096;
const DEFAULT_SCHEDULE_EXPRESSION = "cron(0 0,12 * * ? *)";
const RELATIVE_R2_OBJECT_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const DEPLOY_PARAMETER_KEYS = [
    "LambdaCodeS3Bucket",
    "LambdaCodeS3Key",
    "TeeArtifactS3Bucket",
    "TeeArtifactS3Key",
    "TeeArtifactSha256",
    "EarthquakeTeeEifS3Bucket",
    "EarthquakeTeeEifS3Key",
    "EarthquakeTeeEifSha256",
    "ResidenceR2BaseUrl",
    "ResidenceTileManifestKey",
    "ResidenceTileManifestSha256",
    "ResidenceR2ObjectPrefix",
    "ResidenceR2Bucket",
    "ResidenceAllowlistVersion",
    "ResidenceRoot",
    "ResidenceSourceHash",
    "GeoResolution",
    "MembershipTeeArtifactS3Bucket",
    "MembershipTeeArtifactS3Key",
    "MembershipTeeArtifactSha256",
    "TeeEifS3Bucket",
    "TeeEifS3Key",
    "TeeEifSha256",
    "CensusTeeArtifactS3Bucket",
    "CensusTeeArtifactS3Key",
    "CensusTeeArtifactSha256",
    "CensusTeeEifS3Bucket",
    "CensusTeeEifS3Key",
    "CensusTeeEifSha256",
    "GitCommitSha",
    "ScheduleState",
    "ScheduleExpression",
    "WorldIdProofMode",
    "WorldIdAction",
    "SourceArchiverTokenSecretArn",
    "SourceArchiverPrivateKeySecretArn",
    "SourceArchiverSuiNetwork",
    "SourceArchiverSuiRpcUrl",
    "SourceArchiverWalrusUploadRelayUrl",
    "SourceArchiverWalrusUploadRelayTipMaxMist",
    "SourceArchiverWalrusEpochs",
    "SourceArchiverWalrusDeletable",
    "NitroEnclaveMemoryMiB",
] as const;

type DeployParameterKey = (typeof DEPLOY_PARAMETER_KEYS)[number];
type SuiNetwork = "mainnet" | "testnet" | "devnet";
type SourceArchiverSuiNetwork = "mainnet" | "testnet";
type WorldIdProofMode = "real" | "dummy";

export type BuildAwsSonariVerifierRunnerDeployPlanInput = {
    commitSha: string;
    lambdaBucket: string;
    earthquakeTeeBucket: string;
    earthquakeTeeArtifactSha256: string;
    earthquakeEifBucket: string;
    earthquakeEifSha256: string;
    residenceR2BaseUrl: string;
    residenceTileManifestKey: string;
    residenceTileManifestSha256: string;
    residenceR2ObjectPrefix: string;
    residenceR2Bucket: string;
    residenceAllowlistVersion: number;
    residenceRoot: string;
    residenceSourceHash?: string;
    geoResolution: number;
    membershipTeeBucket: string;
    membershipTeeArtifactSha256: string;
    membershipEifBucket: string;
    membershipEifSha256: string;
    censusTeeBucket: string;
    censusTeeArtifactSha256: string;
    censusEifBucket: string;
    censusEifSha256: string;
    sourceArchiverTokenSecretArn: string;
    sourceArchiverPrivateKeySecretArn: string;
    sourceArchiverSuiNetwork?: SourceArchiverSuiNetwork;
    sourceArchiverSuiRpcUrl?: string;
    sourceArchiverWalrusUploadRelayUrl?: string;
    sourceArchiverWalrusUploadRelayTipMaxMist?: number;
    sourceArchiverWalrusEpochs?: number;
    sourceArchiverWalrusDeletable?: boolean;
    relayerNetwork?: SuiNetwork;
    worldIdProofMode?: WorldIdProofMode;
    worldIdAction?: string;
    nitroEnclaveMemoryMiB?: number;
    scheduleExpression?: string;
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
    const residenceTileManifestKey = validateRelativeObjectKey(
        input.residenceTileManifestKey,
        "residence tile manifest key",
    );
    const residenceR2ObjectPrefix = validateRelativeObjectPrefix(
        input.residenceR2ObjectPrefix,
        "residence R2 object prefix",
    );
    validateManifestKeyPrefix(residenceTileManifestKey, residenceR2ObjectPrefix);
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
        EarthquakeTeeEifS3Bucket: validateS3Bucket(
            input.earthquakeEifBucket,
            "earthquake EIF bucket",
        ),
        EarthquakeTeeEifS3Key: `${prefix}/${commitSha}/${EARTHQUAKE_EIF_FILE_NAME}`,
        EarthquakeTeeEifSha256: validateSha256(input.earthquakeEifSha256, "earthquake EIF SHA-256"),
        ResidenceR2BaseUrl: validateHttpsUrl(input.residenceR2BaseUrl, "residence R2 base URL"),
        ResidenceTileManifestKey: residenceTileManifestKey,
        ResidenceTileManifestSha256: validateSha256(
            input.residenceTileManifestSha256,
            "residence tile manifest SHA-256",
        ),
        ResidenceR2ObjectPrefix: residenceR2ObjectPrefix,
        ResidenceR2Bucket: validateR2Bucket(input.residenceR2Bucket, "residence R2 bucket"),
        ResidenceAllowlistVersion: String(
            validatePositiveInteger(input.residenceAllowlistVersion, "residence allowlist version"),
        ),
        ResidenceRoot: validateHex32(input.residenceRoot, "residence root"),
        ResidenceSourceHash:
            input.residenceSourceHash === undefined
                ? ""
                : validateHex32(input.residenceSourceHash, "residence source hash"),
        GeoResolution: String(validatePositiveInteger(input.geoResolution, "geo resolution")),
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
        CensusTeeArtifactS3Bucket: validateS3Bucket(input.censusTeeBucket, "census TEE bucket"),
        CensusTeeArtifactS3Key: `${prefix}/${commitSha}/${CENSUS_TEE_ARTIFACT_FILE_NAME}`,
        CensusTeeArtifactSha256: validateSha256(
            input.censusTeeArtifactSha256,
            "census TEE artifact SHA-256",
        ),
        CensusTeeEifS3Bucket: validateS3Bucket(input.censusEifBucket, "census EIF bucket"),
        CensusTeeEifS3Key: `${prefix}/${commitSha}/${CENSUS_EIF_FILE_NAME}`,
        CensusTeeEifSha256: validateSha256(input.censusEifSha256, "census EIF SHA-256"),
        GitCommitSha: commitSha,
        ScheduleState: "DISABLED",
        ScheduleExpression: input.scheduleExpression ?? DEFAULT_SCHEDULE_EXPRESSION,
        SourceArchiverTokenSecretArn: validateArn(
            input.sourceArchiverTokenSecretArn,
            "source archiver token secret ARN",
        ),
        SourceArchiverPrivateKeySecretArn: validateArn(
            input.sourceArchiverPrivateKeySecretArn,
            "source archiver private key secret ARN",
        ),
        SourceArchiverSuiNetwork:
            input.sourceArchiverSuiNetwork ?? DEFAULT_SOURCE_ARCHIVER_SUI_NETWORK,
        SourceArchiverSuiRpcUrl: validateHttpsUrl(
            input.sourceArchiverSuiRpcUrl ?? DEFAULT_SOURCE_ARCHIVER_SUI_RPC_URL,
            "source archiver Sui RPC URL",
        ),
        SourceArchiverWalrusUploadRelayUrl: validateHttpsUrl(
            input.sourceArchiverWalrusUploadRelayUrl ??
                DEFAULT_SOURCE_ARCHIVER_WALRUS_UPLOAD_RELAY_URL,
            "source archiver Walrus upload relay URL",
        ),
        SourceArchiverWalrusUploadRelayTipMaxMist: String(
            validateNonNegativeInteger(
                input.sourceArchiverWalrusUploadRelayTipMaxMist ??
                    Number(DEFAULT_SOURCE_ARCHIVER_WALRUS_UPLOAD_RELAY_TIP_MAX_MIST),
                "source archiver Walrus upload relay tip max MIST",
            ),
        ),
        SourceArchiverWalrusEpochs: String(
            validatePositiveInteger(
                input.sourceArchiverWalrusEpochs ?? Number(DEFAULT_SOURCE_ARCHIVER_WALRUS_EPOCHS),
                "source archiver Walrus epochs",
            ),
        ),
        SourceArchiverWalrusDeletable: String(
            input.sourceArchiverWalrusDeletable ?? DEFAULT_SOURCE_ARCHIVER_WALRUS_DELETABLE,
        ),
        WorldIdProofMode: input.worldIdProofMode ?? DEFAULT_WORLD_ID_PROOF_MODE,
        WorldIdAction: validateWorldIdAction(input.worldIdAction ?? DEFAULT_WORLD_ID_ACTION),
        NitroEnclaveMemoryMiB: String(
            validatePositiveInteger(
                input.nitroEnclaveMemoryMiB ?? DEFAULT_NITRO_ENCLAVE_MEMORY_MIB,
                "nitro enclave memory MiB",
            ),
        ),
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

function validateR2Bucket(value: string, label: string): string {
    const trimmed = value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/.test(trimmed)) {
        throw new Error(`Invalid ${label}: expected an R2 bucket name`);
    }
    return trimmed;
}

function validateRelativeObjectKey(value: string, label: string): string {
    const trimmed = value.trim();
    if (
        trimmed.length === 0 ||
        trimmed.length > 1024 ||
        !RELATIVE_R2_OBJECT_PATH_PATTERN.test(trimmed) ||
        trimmed
            .split("/")
            .some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
        throw new Error(`Invalid ${label}: expected a relative object key`);
    }
    return trimmed;
}

function validateRelativeObjectPrefix(value: string, label: string): string {
    const trimmed = value.trim();
    if (
        trimmed.length === 0 ||
        trimmed.length > 1024 ||
        !RELATIVE_R2_OBJECT_PATH_PATTERN.test(trimmed) ||
        trimmed
            .split("/")
            .some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
        throw new Error(`Invalid ${label}: expected a relative object prefix`);
    }
    return trimmed;
}

function validateManifestKeyPrefix(manifestKey: string, objectPrefix: string): void {
    if (manifestKey !== objectPrefix && !manifestKey.startsWith(`${objectPrefix}/`)) {
        throw new Error(
            "residence tile manifest key must start with the residence R2 object prefix",
        );
    }
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

function validateArn(value: string, label: string): string {
    if (!/^arn:[A-Za-z0-9-]+:[A-Za-z0-9-]+:[A-Za-z0-9-]*:[0-9]{12}:.+/.test(value)) {
        throw new Error(`Invalid ${label}: expected an AWS ARN`);
    }
    return value;
}

function validateHttpsUrl(value: string, label: string): string {
    const trimmed = value.trim();
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "https:") {
            throw new Error("expected https");
        }
        return trimmed.replace(/\/$/u, "");
    } catch {
        throw new Error(`Invalid ${label}: expected an https URL`);
    }
}

function validateHex32(value: string, label: string): string {
    const trimmed = value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
        throw new Error(`Invalid ${label}: expected a 32-byte 0x-prefixed hex value`);
    }
    return trimmed.toLowerCase();
}

function validatePositiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid ${label}: expected a positive integer`);
    }
    return value;
}

function validateNonNegativeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Invalid ${label}: expected a non-negative integer`);
    }
    return value;
}

function validateWorldIdProofMode(
    relayerNetwork: SuiNetwork | undefined,
    worldIdProofMode: WorldIdProofMode | undefined,
): void {
    if (relayerNetwork === "mainnet" && worldIdProofMode === "dummy") {
        throw new Error("dummy World ID proof mode is not allowed on mainnet");
    }
}

function validateWorldIdAction(value: string): string {
    const trimmed = value.trim();
    if (!/^sonari_membership_register_v[0-9]+$/.test(trimmed)) {
        throw new Error("Invalid World ID action: expected sonari_membership_register_v<N>");
    }
    return trimmed;
}

type CliOptions = {
    commitSha?: string;
    lambdaBucket?: string;
    earthquakeTeeBucket?: string;
    earthquakeTeeArtifactSha256?: string;
    earthquakeEifBucket?: string;
    earthquakeEifSha256?: string;
    residenceR2BaseUrl?: string;
    residenceTileManifestKey?: string;
    residenceTileManifestSha256?: string;
    residenceR2ObjectPrefix?: string;
    residenceR2Bucket?: string;
    residenceAllowlistVersion?: number;
    residenceRoot?: string;
    residenceSourceHash?: string;
    geoResolution?: number;
    membershipTeeBucket?: string;
    membershipTeeArtifactSha256?: string;
    membershipEifBucket?: string;
    membershipEifSha256?: string;
    censusTeeBucket?: string;
    censusTeeArtifactSha256?: string;
    censusEifBucket?: string;
    censusEifSha256?: string;
    sourceArchiverTokenSecretArn?: string;
    sourceArchiverPrivateKeySecretArn?: string;
    sourceArchiverSuiNetwork?: SourceArchiverSuiNetwork;
    sourceArchiverSuiRpcUrl?: string;
    sourceArchiverWalrusUploadRelayUrl?: string;
    sourceArchiverWalrusUploadRelayTipMaxMist?: number;
    sourceArchiverWalrusEpochs?: number;
    sourceArchiverWalrusDeletable?: boolean;
    relayerNetwork?: SuiNetwork;
    worldIdProofMode?: WorldIdProofMode;
    worldIdAction?: string;
    nitroEnclaveMemoryMiB?: number;
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
        options.earthquakeEifBucket === undefined ||
        options.earthquakeEifSha256 === undefined ||
        options.residenceR2BaseUrl === undefined ||
        options.residenceTileManifestKey === undefined ||
        options.residenceTileManifestSha256 === undefined ||
        options.residenceR2ObjectPrefix === undefined ||
        options.residenceR2Bucket === undefined ||
        options.residenceAllowlistVersion === undefined ||
        options.residenceRoot === undefined ||
        options.geoResolution === undefined ||
        options.membershipTeeBucket === undefined ||
        options.membershipTeeArtifactSha256 === undefined ||
        options.membershipEifBucket === undefined ||
        options.membershipEifSha256 === undefined ||
        options.censusTeeBucket === undefined ||
        options.censusTeeArtifactSha256 === undefined ||
        options.censusEifBucket === undefined ||
        options.censusEifSha256 === undefined ||
        options.sourceArchiverTokenSecretArn === undefined ||
        options.sourceArchiverPrivateKeySecretArn === undefined
    ) {
        throw new Error(
            [
                "Usage: tsx scripts/aws_sonari_verifier_runner_deploy_plan.ts",
                "--commit-sha <sha>",
                "--lambda-bucket <bucket>",
                "--earthquake-tee-bucket <bucket>",
                "--earthquake-tee-sha256 <sha256>",
                "--earthquake-eif-bucket <bucket>",
                "--earthquake-eif-sha256 <sha256>",
                "--residence-r2-base-url <https-url>",
                "--residence-tile-manifest-key <key>",
                "--residence-tile-manifest-sha256 <sha256>",
                "--residence-r2-object-prefix <prefix>",
                "--residence-r2-bucket <bucket>",
                "--residence-allowlist-version <version>",
                "--residence-root <0xhex32>",
                "[--residence-source-hash <0xhex32>]",
                "--geo-resolution <resolution>",
                "--membership-tee-bucket <bucket>",
                "--membership-tee-sha256 <sha256>",
                "--membership-eif-bucket <bucket>",
                "--membership-eif-sha256 <sha256>",
                "--census-tee-bucket <bucket>",
                "--census-tee-sha256 <sha256>",
                "--census-eif-bucket <bucket>",
                "--census-eif-sha256 <sha256>",
                "--source-archiver-token-secret-arn <arn>",
                "--source-archiver-private-key-secret-arn <arn>",
                "[--source-archiver-sui-network <mainnet|testnet>]",
                "[--source-archiver-sui-rpc-url <url>]",
                "[--source-archiver-walrus-upload-relay-url <url>]",
                "[--source-archiver-walrus-upload-relay-tip-max-mist <mist>]",
                "[--source-archiver-walrus-epochs <epochs>]",
                "[--source-archiver-walrus-deletable <true|false>]",
                "[--relayer-network <mainnet|testnet|devnet>]",
                "[--world-id-proof-mode <real|dummy>]",
                "[--world-id-action <sonari_membership_register_vN>]",
                "[--nitro-enclave-memory-mib <mib>]",
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
        earthquakeEifBucket: options.earthquakeEifBucket,
        earthquakeEifSha256: options.earthquakeEifSha256,
        residenceR2BaseUrl: options.residenceR2BaseUrl,
        residenceTileManifestKey: options.residenceTileManifestKey,
        residenceTileManifestSha256: options.residenceTileManifestSha256,
        residenceR2ObjectPrefix: options.residenceR2ObjectPrefix,
        residenceR2Bucket: options.residenceR2Bucket,
        residenceAllowlistVersion: options.residenceAllowlistVersion,
        residenceRoot: options.residenceRoot,
        ...(options.residenceSourceHash === undefined
            ? {}
            : { residenceSourceHash: options.residenceSourceHash }),
        geoResolution: options.geoResolution,
        membershipTeeBucket: options.membershipTeeBucket,
        membershipTeeArtifactSha256: options.membershipTeeArtifactSha256,
        membershipEifBucket: options.membershipEifBucket,
        membershipEifSha256: options.membershipEifSha256,
        censusTeeBucket: options.censusTeeBucket,
        censusTeeArtifactSha256: options.censusTeeArtifactSha256,
        censusEifBucket: options.censusEifBucket,
        censusEifSha256: options.censusEifSha256,
        sourceArchiverTokenSecretArn: options.sourceArchiverTokenSecretArn,
        sourceArchiverPrivateKeySecretArn: options.sourceArchiverPrivateKeySecretArn,
        ...(options.sourceArchiverSuiNetwork === undefined
            ? {}
            : { sourceArchiverSuiNetwork: options.sourceArchiverSuiNetwork }),
        ...(options.sourceArchiverSuiRpcUrl === undefined
            ? {}
            : { sourceArchiverSuiRpcUrl: options.sourceArchiverSuiRpcUrl }),
        ...(options.sourceArchiverWalrusUploadRelayUrl === undefined
            ? {}
            : { sourceArchiverWalrusUploadRelayUrl: options.sourceArchiverWalrusUploadRelayUrl }),
        ...(options.sourceArchiverWalrusUploadRelayTipMaxMist === undefined
            ? {}
            : {
                  sourceArchiverWalrusUploadRelayTipMaxMist:
                      options.sourceArchiverWalrusUploadRelayTipMaxMist,
              }),
        ...(options.sourceArchiverWalrusEpochs === undefined
            ? {}
            : { sourceArchiverWalrusEpochs: options.sourceArchiverWalrusEpochs }),
        ...(options.sourceArchiverWalrusDeletable === undefined
            ? {}
            : { sourceArchiverWalrusDeletable: options.sourceArchiverWalrusDeletable }),
        ...(options.relayerNetwork === undefined ? {} : { relayerNetwork: options.relayerNetwork }),
        ...(options.worldIdProofMode === undefined
            ? {}
            : { worldIdProofMode: options.worldIdProofMode }),
        ...(options.worldIdAction === undefined ? {} : { worldIdAction: options.worldIdAction }),
        ...(options.nitroEnclaveMemoryMiB === undefined
            ? {}
            : { nitroEnclaveMemoryMiB: options.nitroEnclaveMemoryMiB }),
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
            case "--earthquake-eif-bucket":
                options.earthquakeEifBucket = next;
                break;
            case "--earthquake-eif-sha256":
                options.earthquakeEifSha256 = next;
                break;
            case "--residence-r2-base-url":
                options.residenceR2BaseUrl = next;
                break;
            case "--residence-tile-manifest-key":
                options.residenceTileManifestKey = next;
                break;
            case "--residence-tile-manifest-sha256":
                options.residenceTileManifestSha256 = next;
                break;
            case "--residence-r2-object-prefix":
                options.residenceR2ObjectPrefix = next;
                break;
            case "--residence-r2-bucket":
                options.residenceR2Bucket = next;
                break;
            case "--residence-allowlist-version":
                options.residenceAllowlistVersion = parseIntegerOption(arg, next);
                break;
            case "--residence-root":
                options.residenceRoot = next;
                break;
            case "--residence-source-hash":
                options.residenceSourceHash = next;
                break;
            case "--geo-resolution":
                options.geoResolution = parseIntegerOption(arg, next);
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
            case "--census-tee-bucket":
                options.censusTeeBucket = next;
                break;
            case "--census-tee-sha256":
                options.censusTeeArtifactSha256 = next;
                break;
            case "--census-eif-bucket":
                options.censusEifBucket = next;
                break;
            case "--census-eif-sha256":
                options.censusEifSha256 = next;
                break;
            case "--source-archiver-token-secret-arn":
                options.sourceArchiverTokenSecretArn = next;
                break;
            case "--source-archiver-private-key-secret-arn":
                options.sourceArchiverPrivateKeySecretArn = next;
                break;
            case "--source-archiver-sui-network":
                options.sourceArchiverSuiNetwork = parseSourceArchiverSuiNetwork(next);
                break;
            case "--source-archiver-sui-rpc-url":
                options.sourceArchiverSuiRpcUrl = next;
                break;
            case "--source-archiver-walrus-upload-relay-url":
                options.sourceArchiverWalrusUploadRelayUrl = next;
                break;
            case "--source-archiver-walrus-upload-relay-tip-max-mist":
                options.sourceArchiverWalrusUploadRelayTipMaxMist = parseIntegerOption(arg, next);
                break;
            case "--source-archiver-walrus-epochs":
                options.sourceArchiverWalrusEpochs = parseIntegerOption(arg, next);
                break;
            case "--source-archiver-walrus-deletable":
                options.sourceArchiverWalrusDeletable = parseBooleanOption(arg, next);
                break;
            case "--relayer-network":
                options.relayerNetwork = parseSuiNetwork(next);
                break;
            case "--world-id-proof-mode":
                options.worldIdProofMode = parseWorldIdProofMode(next);
                break;
            case "--world-id-action":
                options.worldIdAction = validateWorldIdAction(next);
                break;
            case "--nitro-enclave-memory-mib":
                options.nitroEnclaveMemoryMiB = parseIntegerOption(arg, next);
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

function parseSourceArchiverSuiNetwork(value: string): SourceArchiverSuiNetwork {
    if (value === "mainnet" || value === "testnet") {
        return value;
    }
    throw new Error("--source-archiver-sui-network must be mainnet or testnet");
}

function parseIntegerOption(name: string, value: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${name} must be an integer`);
    }
    return parsed;
}

function parseBooleanOption(name: string, value: string): boolean {
    if (value === "true") {
        return true;
    }
    if (value === "false") {
        return false;
    }
    throw new Error(`${name} must be true or false`);
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
