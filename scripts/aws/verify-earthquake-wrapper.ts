import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import {
    type AwsCli,
    assertAsgIdle,
    assertDirectEarthquakeWrapperResult,
    assertExpectedAccount,
    assertSchedulesDisabled,
    buildEarthquakeWrapperInput,
    DEFAULT_EXPECTED_ACCOUNT,
    DEFAULT_REGION,
    DEFAULT_STACK,
    describeStack,
    ExecFileAwsCli,
    findInServiceInstanceId,
    type PollOptions,
    parseArgs,
    parseJsonText,
    parseStackOutputs,
    readAttestationPublicKey,
    readStringOption,
    requireOutput,
    runSsmShellCommand,
    shellPipeJsonToEarthquakeWrapper,
    updateAsgDesiredCapacity,
    waitFor,
    waitForSsmOnline,
} from "./shared.js";

const DEFAULT_SOURCE_EVENT_ID = "us6000m0xl";
const DEFAULT_HAZARD_TYPE = 1;
const DEFAULT_PRIMARY_SOURCE = 1;
const DEFAULT_GEO_RESOLUTION = 7;
const DEFAULT_VERIFIER_CONFIG_KEY = 1;
const DEFAULT_VERIFIER_CONFIG_VERSION = 7;
const EARTHQUAKE_WRAPPER_RESULT_PREFIX = "results/earthquake-wrapper-results/";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type VerifyEarthquakeWrapperOptions = {
    aws?: AwsCli;
    stack?: string;
    expectedAccount?: string;
    region?: string;
    expectedCommit?: string;
    sourceEventId?: string;
    hazardType?: number;
    primarySource?: number;
    geoResolution?: number;
    verifierConfigKey?: number;
    verifierConfigVersion?: number;
    poll?: PollOptions;
};

export type VerifyEarthquakeWrapperResult = {
    instanceId: string;
    deployedCommit: string | null;
    socatTimeoutSeconds: number;
    attestationPublicKey: string;
    finalizedResult: unknown;
};

export async function readEarthquakeWrapperS3Result(input: {
    aws: AwsCli;
    expectedBucket: string;
    reference: unknown;
}): Promise<unknown> {
    const reference = readProcessDataS3Reference(input.reference);
    const { bucket, key } = parseExpectedResultS3Uri(reference.resultS3Uri);
    if (bucket !== input.expectedBucket) {
        throw new Error(
            `process_data result bucket mismatch: expected ${input.expectedBucket}, got ${bucket}`,
        );
    }
    if (!key.startsWith(EARTHQUAKE_WRAPPER_RESULT_PREFIX)) {
        throw new Error(
            `process_data result key must be under ${EARTHQUAKE_WRAPPER_RESULT_PREFIX}`,
        );
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "sonari-earthquake-wrapper-result-"));
    try {
        const outputPath = path.join(tempDir, "process-data-result.json");
        await input.aws.json([
            "s3api",
            "get-object",
            "--bucket",
            bucket,
            "--key",
            key,
            outputPath,
        ]);
        const bytes = await readFile(outputPath);
        const actualSha256 = createHash("sha256").update(bytes).digest("hex");
        if (actualSha256 !== reference.sha256) {
            throw new Error("process_data result sha256 mismatch");
        }
        if (bytes.byteLength !== reference.bytes) {
            throw new Error("process_data result byte length mismatch");
        }
        const text = UTF8_DECODER.decode(bytes);
        if (Buffer.byteLength(text, "utf8") !== reference.bytes) {
            throw new Error("process_data result UTF-8 byte length mismatch");
        }
        return parseJsonText(text, "process_data S3 result");
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

export async function runVerifyEarthquakeWrapper(
    options: VerifyEarthquakeWrapperOptions = {},
): Promise<VerifyEarthquakeWrapperResult> {
    const aws = options.aws ?? new ExecFileAwsCli(options.region ?? DEFAULT_REGION);
    const stack = options.stack ?? DEFAULT_STACK;
    const expectedAccount = options.expectedAccount ?? DEFAULT_EXPECTED_ACCOUNT;
    const poll = options.poll ?? { intervalMs: 15_000, timeoutMs: 20 * 60_000 };
    const sourceEventId = options.sourceEventId ?? DEFAULT_SOURCE_EVENT_ID;

    await assertExpectedAccount(aws, expectedAccount);
    const stackResponse = await describeStack(aws, stack);
    const outputs = parseStackOutputs(stackResponse);
    const deployedCommit = outputs.DeployedGitCommitSha ?? null;
    if (options.expectedCommit !== undefined && deployedCommit !== options.expectedCommit) {
        throw new Error(
            `DeployedGitCommitSha mismatch: expected ${options.expectedCommit}, got ${deployedCommit ?? "<missing>"}`,
        );
    }
    await assertSchedulesDisabled(aws, outputs);

    const asgName = requireOutput(outputs, "RunnerAutoScalingGroupName");
    let cleanupNeeded = false;

    try {
        await updateAsgDesiredCapacity(aws, asgName, 1);
        cleanupNeeded = true;
        const instanceId = await waitFor("ASG InService instance", poll, () =>
            findInServiceInstanceId(aws, asgName),
        );
        await waitForSsmOnline(aws, instanceId, poll);
        await waitFor("bootstrap marker", poll, async () => {
            try {
                await runSsmShellCommand(aws, {
                    instanceId,
                    comment: "bootstrap-marker",
                    commands: ["test -f /opt/sonari/bootstrap-complete"],
                    poll,
                });
                return true;
            } catch {
                return null;
            }
        });
        const socatTimeoutSeconds = readSocatTimeoutSeconds(
            await runSsmShellCommand(aws, {
                instanceId,
                comment: "earthquake-wrapper-socat-timeout",
                commands: [buildSocatTimeoutVerificationCommand()],
                poll,
            }),
        );

        await runSsmShellCommand(aws, {
            instanceId,
            comment: "health_check",
            commands: [shellPipeJsonToEarthquakeWrapper({ action: "health_check" })],
            poll,
        });
        const attestation = parseJsonText(
            await runSsmShellCommand(aws, {
                instanceId,
                comment: "get_attestation",
                commands: [shellPipeJsonToEarthquakeWrapper({ action: "get_attestation" })],
                poll,
            }),
            "get_attestation",
        );
        const attestationPublicKey = readAttestationPublicKey(attestation);
        const processDataInput = buildEarthquakeWrapperInput({
            sourceEventId,
            hazardType: options.hazardType ?? DEFAULT_HAZARD_TYPE,
            primarySource: options.primarySource ?? DEFAULT_PRIMARY_SOURCE,
            geoResolution: options.geoResolution ?? DEFAULT_GEO_RESOLUTION,
            verifierConfigKey: options.verifierConfigKey ?? DEFAULT_VERIFIER_CONFIG_KEY,
            verifierConfigVersion: options.verifierConfigVersion ?? DEFAULT_VERIFIER_CONFIG_VERSION,
            enclaveInstancePublicKey: attestationPublicKey,
        });
        const finalizedResult = assertDirectEarthquakeWrapperResult(
            parseJsonText(
                await runSsmShellCommand(aws, {
                    instanceId,
                    comment: "process_data",
                    commands: [shellPipeJsonToEarthquakeWrapper(processDataInput)],
                    poll,
                }),
                "process_data",
            ),
            attestationPublicKey,
        );

        return {
            instanceId,
            deployedCommit,
            socatTimeoutSeconds,
            attestationPublicKey,
            finalizedResult,
        };
    } finally {
        if (cleanupNeeded) {
            await updateAsgDesiredCapacity(aws, asgName, 0);
            await waitFor("ASG idle", poll, async () => {
                try {
                    await assertAsgIdle(aws, asgName);
                    return true;
                } catch {
                    return null;
                }
            });
            await assertSchedulesDisabled(aws, outputs);
        }
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help === true) {
        process.stdout.write(
            "Usage: pnpm aws:verify:earthquake-wrapper -- [--stack <name>] [--expected-account <id>] [--commit <sha>] [--source-event-id <id>]\n",
        );
        return;
    }
    const expectedCommit =
        typeof options.commit === "string" && options.commit.length > 0
            ? options.commit
            : undefined;
    const result = await runVerifyEarthquakeWrapper({
        stack: readStringOption(options, "stack", DEFAULT_STACK),
        expectedAccount: readStringOption(options, "expected-account", DEFAULT_EXPECTED_ACCOUNT),
        region: readStringOption(options, "region", DEFAULT_REGION),
        ...(expectedCommit === undefined ? {} : { expectedCommit }),
        sourceEventId: readStringOption(options, "source-event-id", DEFAULT_SOURCE_EVENT_ID),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function buildSocatTimeoutVerificationCommand(): string {
    return [
        "set -euo pipefail",
        "awk '",
        '/^SONARI_EARTHQUAKE_VSOCK_SOCAT_TIMEOUT_SECONDS=/ { split($0, value, "="); timeout = value[2] }',
        "/socat[[:space:]].*-t[[:space:]]/ { uses_timeout = 1 }",
        "END {",
        '  if (timeout + 0 < 180) { print "socat timeout below 180" > "/dev/stderr"; exit 1 }',
        '  if (uses_timeout != 1) { print "socat -t usage missing" > "/dev/stderr"; exit 1 }',
        "  print timeout",
        "}' /opt/sonari/bin/run-earthquake-enclave",
    ].join("\n");
}

export function buildProcessDataS3UploadCommand(input: {
    input: unknown;
    bucket: string;
    runId: string;
}): string {
    const resultKey = `${EARTHQUAKE_WRAPPER_RESULT_PREFIX}${input.runId}.json`;
    return [
        "set -euo pipefail",
        'result_file="$(mktemp /tmp/sonari-earthquake-wrapper-result.XXXXXX.json)"',
        'trap \'rm -f "$result_file"\' EXIT',
        `result_key="${resultKey}"`,
        `printf '%s' ${shellSingleQuote(JSON.stringify(input.input))} | /opt/sonari/bin/run-earthquake-enclave > "$result_file"`,
        `aws s3 cp --only-show-errors "$result_file" "s3://${input.bucket}/$result_key"`,
        'sha256="$(sha256sum "$result_file" | awk \'{ print $1 }\')"',
        'bytes="$(wc -c < "$result_file" | tr -d \'[:space:]\')"',
        `RESULT_S3_URI="s3://${input.bucket}/$result_key" RESULT_SHA256="$sha256" RESULT_BYTES="$bytes" node -e ${shellSingleQuote('process.stdout.write(JSON.stringify({ status: "ok", result_s3_uri: process.env.RESULT_S3_URI, sha256: process.env.RESULT_SHA256, bytes: Number(process.env.RESULT_BYTES) }))')}`,
    ].join("\n");
}

function shellSingleQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function readSocatTimeoutSeconds(output: string): number {
    const value = Number(output.trim());
    if (!Number.isSafeInteger(value) || value < 180) {
        throw new Error(`Invalid socat timeout verification output: ${output}`);
    }
    return value;
}

function readProcessDataS3Reference(value: unknown): {
    resultS3Uri: string;
    sha256: string;
    bytes: number;
} {
    if (!isRecord(value)) {
        throw new Error("process_data S3 reference must be an object");
    }
    if (value.status !== "ok") {
        throw new Error('Expected process_data S3 reference status "ok"');
    }
    if (typeof value.result_s3_uri !== "string" || value.result_s3_uri.length === 0) {
        throw new Error("process_data S3 reference result_s3_uri is required");
    }
    if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)) {
        throw new Error("process_data S3 reference sha256 must be 64 lowercase hex characters");
    }
    if (
        typeof value.bytes !== "number" ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 0
    ) {
        throw new Error("process_data S3 reference bytes must be a non-negative safe integer");
    }
    return {
        resultS3Uri: value.result_s3_uri,
        sha256: value.sha256,
        bytes: value.bytes,
    };
}

function parseExpectedResultS3Uri(uri: string): { bucket: string; key: string } {
    let parsed: URL;
    try {
        parsed = new URL(uri);
    } catch {
        throw new Error("process_data result_s3_uri must be an s3 URI");
    }
    if (parsed.protocol !== "s3:" || parsed.hostname.length === 0) {
        throw new Error("process_data result_s3_uri must be an s3 URI");
    }
    const key = parsed.pathname.replace(/^\/+/u, "");
    if (key.length === 0) {
        throw new Error("process_data result_s3_uri must include an object key");
    }
    return { bucket: parsed.hostname, key };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith("verify-earthquake-wrapper.ts")) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
