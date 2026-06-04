import process from "node:process";
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

function readSocatTimeoutSeconds(output: string): number {
    const value = Number(output.trim());
    if (!Number.isSafeInteger(value) || value < 180) {
        throw new Error(`Invalid socat timeout verification output: ${output}`);
    }
    return value;
}

if (process.argv[1]?.endsWith("verify-earthquake-wrapper.ts")) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
