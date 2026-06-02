import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_STACK = "sonari-verifier-runner-dev";
export const DEFAULT_EXPECTED_ACCOUNT = "595103996064";
export const DEFAULT_REGION = "us-west-2";

const STACK_OUTPUT_KEYS = [
    "EventsTableName",
    "VerificationJobsTableName",
    "RunnerLeaseTableName",
    "RunnerResultBucketName",
    "RunnerLogGroupName",
    "DeployedGitCommitSha",
    "LambdaCodeS3KeyOutput",
    "TeeArtifactS3KeyOutput",
    "TeeArtifactSha256Output",
    "EarthquakeTeeEifS3KeyOutput",
    "EarthquakeTeeEifSha256Output",
    "MembershipTeeArtifactS3KeyOutput",
    "MembershipTeeArtifactSha256Output",
    "TeeEifS3KeyOutput",
    "TeeEifSha256Output",
    "EarthquakeRunnerStateMachineArn",
    "MembershipRunnerStateMachineArn",
    "RunnerAutoScalingGroupName",
    "RunnerLaunchTemplateId",
    "RunnerRoleArn",
    "WatcherScheduleName",
    "BatchScheduleName",
    "WatcherLambdaName",
    "ManualWatcherLambdaName",
    "SubmitVerificationLambdaName",
    "BatchVerifierLambdaName",
    "RunnerControlLambdaName",
    "SourceArchiverLambdaName",
    "SourceArchiverFunctionUrlOutput",
    "SigningMaterialKmsKeyId",
] as const;

export type StackOutputKey = (typeof STACK_OUTPUT_KEYS)[number];
export type StackOutputs = Partial<Record<StackOutputKey, string>>;

export type PollOptions = {
    intervalMs: number;
    timeoutMs: number;
};

export type AwsCli = {
    json(args: readonly string[]): Promise<unknown>;
};

export class ExecFileAwsCli implements AwsCli {
    private readonly region: string | undefined;

    constructor(region?: string | undefined) {
        this.region = region;
    }

    async json(args: readonly string[]): Promise<unknown> {
        const finalArgs = [...args];
        if (this.region !== undefined && !finalArgs.includes("--region")) {
            finalArgs.push("--region", this.region);
        }
        if (!finalArgs.includes("--output")) {
            finalArgs.push("--output", "json");
        }
        const { stdout } = await execFileAsync("aws", finalArgs, { maxBuffer: 16 * 1024 * 1024 });
        const trimmed = stdout.trim();
        return trimmed.length === 0 ? {} : (JSON.parse(trimmed) as unknown);
    }
}

export function parseStackOutputs(response: unknown): StackOutputs {
    const stack = firstStack(response);
    const outputs = readArray(stack.Outputs, "Stacks[0].Outputs");
    const parsed: StackOutputs = {};

    for (const output of outputs) {
        if (!isRecord(output)) {
            continue;
        }
        const key = output.OutputKey;
        const value = output.OutputValue;
        if (typeof key !== "string" || typeof value !== "string") {
            continue;
        }
        if ((STACK_OUTPUT_KEYS as readonly string[]).includes(key)) {
            parsed[key as StackOutputKey] = value;
        }
    }

    return parsed;
}

export function parseStackParameters(response: unknown): Record<string, string> {
    const stack = firstStack(response);
    const parameters = readArray(stack.Parameters, "Stacks[0].Parameters");
    const parsed: Record<string, string> = {};

    for (const parameter of parameters) {
        if (
            isRecord(parameter) &&
            typeof parameter.ParameterKey === "string" &&
            typeof parameter.ParameterValue === "string"
        ) {
            parsed[parameter.ParameterKey] = parameter.ParameterValue;
        }
    }

    return parsed;
}

export function requireOutput(outputs: StackOutputs, key: StackOutputKey): string {
    const value = outputs[key];
    if (value === undefined || value.length === 0) {
        throw new Error(`CloudFormation output ${key} is required`);
    }
    return value;
}

export async function describeStack(aws: AwsCli, stackName: string): Promise<unknown> {
    return aws.json(["cloudformation", "describe-stacks", "--stack-name", stackName]);
}

export async function assertExpectedAccount(aws: AwsCli, expectedAccount: string): Promise<string> {
    const identity = await aws.json(["sts", "get-caller-identity"]);
    if (!isRecord(identity) || typeof identity.Account !== "string") {
        throw new Error("Unable to read AWS account from sts get-caller-identity");
    }
    if (identity.Account !== expectedAccount) {
        throw new Error(
            `AWS account mismatch: expected ${expectedAccount}, got ${identity.Account}`,
        );
    }
    return identity.Account;
}

export async function getScheduleState(aws: AwsCli, scheduleName: string): Promise<string> {
    const schedule = await aws.json(["scheduler", "get-schedule", "--name", scheduleName]);
    if (!isRecord(schedule) || typeof schedule.State !== "string") {
        throw new Error(`Unable to read state for schedule ${scheduleName}`);
    }
    return schedule.State;
}

export async function assertSchedulesDisabled(aws: AwsCli, outputs: StackOutputs): Promise<void> {
    for (const key of ["WatcherScheduleName", "BatchScheduleName"] as const) {
        const name = requireOutput(outputs, key);
        const state = await getScheduleState(aws, name);
        if (state !== "DISABLED") {
            throw new Error(`${key} ${name} must be DISABLED, got ${state}`);
        }
    }
}

export async function updateAsgDesiredCapacity(
    aws: AwsCli,
    asgName: string,
    desiredCapacity: 0 | 1,
): Promise<void> {
    await aws.json([
        "autoscaling",
        "update-auto-scaling-group",
        "--auto-scaling-group-name",
        asgName,
        "--desired-capacity",
        String(desiredCapacity),
    ]);
}

export async function describeAsg(aws: AwsCli, asgName: string): Promise<AsgSummary> {
    const response = await aws.json([
        "autoscaling",
        "describe-auto-scaling-groups",
        "--auto-scaling-group-names",
        asgName,
    ]);
    const groups = isRecord(response)
        ? readArray(response.AutoScalingGroups, "AutoScalingGroups")
        : [];
    const group = groups[0];
    if (!isRecord(group)) {
        throw new Error(`Auto Scaling group ${asgName} was not found`);
    }
    const instances = readArray(group.Instances, "AutoScalingGroups[0].Instances")
        .filter(isRecord)
        .map((instance) => ({
            instanceId:
                typeof instance.InstanceId === "string" ? instance.InstanceId : "unknown-instance",
            lifecycleState:
                typeof instance.LifecycleState === "string" ? instance.LifecycleState : "unknown",
        }));
    return {
        name: asgName,
        desiredCapacity: readNumber(group.DesiredCapacity, "DesiredCapacity"),
        maxSize: readNumber(group.MaxSize, "MaxSize"),
        instances,
    };
}

export async function findInServiceInstanceId(
    aws: AwsCli,
    asgName: string,
): Promise<string | null> {
    const summary = await describeAsg(aws, asgName);
    return (
        summary.instances.find((instance) => instance.lifecycleState === "InService")?.instanceId ??
        null
    );
}

export async function assertAsgIdle(aws: AwsCli, asgName: string): Promise<void> {
    const summary = await describeAsg(aws, asgName);
    if (summary.desiredCapacity !== 0) {
        throw new Error(
            `ASG ${asgName} desired capacity must be 0, got ${summary.desiredCapacity}`,
        );
    }
    if (summary.instances.length !== 0) {
        throw new Error(`ASG ${asgName} still has ${summary.instances.length} instance(s)`);
    }
    const running = await listPendingOrRunningAsgEc2Instances(aws, asgName);
    if (running.length > 0) {
        throw new Error(
            `ASG ${asgName} still has pending/running EC2 instances: ${running.join(", ")}`,
        );
    }
}

export async function listPendingOrRunningAsgEc2Instances(
    aws: AwsCli,
    asgName: string,
): Promise<string[]> {
    const response = await aws.json([
        "ec2",
        "describe-instances",
        "--filters",
        `Name=tag:aws:autoscaling:groupName,Values=${asgName}`,
        "Name=instance-state-name,Values=pending,running",
    ]);
    if (!isRecord(response)) {
        return [];
    }
    const reservations = readArray(response.Reservations, "Reservations");
    return reservations.flatMap((reservation) => {
        if (!isRecord(reservation)) {
            return [];
        }
        return readArray(reservation.Instances, "Reservations[].Instances")
            .filter(isRecord)
            .map((instance) =>
                typeof instance.InstanceId === "string" ? instance.InstanceId : "unknown-instance",
            );
    });
}

export async function waitFor<T>(
    label: string,
    poll: PollOptions,
    probe: () => Promise<T | null>,
): Promise<T> {
    const startedAt = Date.now();
    for (;;) {
        const value = await probe();
        if (value !== null) {
            return value;
        }
        if (Date.now() - startedAt >= poll.timeoutMs) {
            throw new Error(`${label} did not become ready within ${poll.timeoutMs}ms`);
        }
        await sleep(poll.intervalMs);
    }
}

export async function waitForSsmOnline(
    aws: AwsCli,
    instanceId: string,
    poll: PollOptions,
): Promise<void> {
    await waitFor("SSM Online", poll, async () => {
        const response = await aws.json([
            "ssm",
            "describe-instance-information",
            "--filters",
            `Key=InstanceIds,Values=${instanceId}`,
        ]);
        const instances = isRecord(response)
            ? readArray(response.InstanceInformationList, "InstanceInformationList")
            : [];
        const online = instances
            .filter(isRecord)
            .some(
                (instance) =>
                    instance.InstanceId === instanceId && instance.PingStatus === "Online",
            );
        return online ? true : null;
    });
}

export type SsmParametersPayload = {
    commands: string[];
};

export function buildSsmParametersPayload(commands: readonly string[]): SsmParametersPayload {
    if (commands.length === 0 || commands.some((command) => command.length === 0)) {
        throw new Error("SSM commands must be non-empty");
    }
    return { commands: [...commands] };
}

export async function writeSsmParametersFile(
    payload: SsmParametersPayload,
    options: { tmpDir?: string; prefix?: string } = {},
): Promise<string> {
    const directory =
        options.tmpDir === undefined
            ? await mkdtemp(path.join(os.tmpdir(), "sonari-aws-ssm-"))
            : options.tmpDir;
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${options.prefix ?? "parameters"}-${Date.now()}.json`);
    await writeFile(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return file;
}

export async function runSsmShellCommand(
    aws: AwsCli,
    input: {
        instanceId: string;
        comment: string;
        commands: readonly string[];
        poll: PollOptions;
    },
): Promise<string> {
    const parametersFile = await writeSsmParametersFile(buildSsmParametersPayload(input.commands), {
        prefix: input.comment,
    });
    const send = await aws.json([
        "ssm",
        "send-command",
        "--instance-ids",
        input.instanceId,
        "--document-name",
        "AWS-RunShellScript",
        "--comment",
        input.comment,
        "--parameters",
        `file://${parametersFile}`,
    ]);
    const commandId = readCommandId(send);
    return waitFor(`SSM command ${input.comment}`, input.poll, async () => {
        const invocation = await aws.json([
            "ssm",
            "get-command-invocation",
            "--command-id",
            commandId,
            "--instance-id",
            input.instanceId,
        ]);
        if (!isRecord(invocation) || typeof invocation.Status !== "string") {
            throw new Error(`Unable to read SSM invocation status for ${input.comment}`);
        }
        if (invocation.Status === "Success") {
            return typeof invocation.StandardOutputContent === "string"
                ? invocation.StandardOutputContent
                : "";
        }
        if (["Cancelled", "Cancelling", "Failed", "TimedOut"].includes(invocation.Status)) {
            const stderr =
                typeof invocation.StandardErrorContent === "string"
                    ? invocation.StandardErrorContent
                    : "";
            throw new Error(stderr.length > 0 ? stderr : `${input.comment} failed`);
        }
        return null;
    });
}

export function buildEarthquakeWrapperInput(input: {
    sourceEventId: string;
    hazardType: number;
    primarySource: number;
    geoResolution: number;
    verifierConfigKey: number;
    verifierConfigVersion: number;
    enclaveInstancePublicKey: string;
}): unknown {
    return {
        action: "process_data",
        payload: {
            source_event_id: input.sourceEventId,
            hazard_type: input.hazardType,
            primary_source: input.primarySource,
            geo_resolution: input.geoResolution,
        },
        registration_metadata: {
            verifier_config_key: input.verifierConfigKey,
            verifier_config_version: input.verifierConfigVersion,
            enclave_instance_public_key: input.enclaveInstancePublicKey,
        },
    };
}

export function shellPipeJsonToEarthquakeWrapper(input: unknown): string {
    return [
        "set -euo pipefail",
        `printf '%s' ${shellSingleQuote(JSON.stringify(input))} | /opt/sonari/bin/run-earthquake-enclave`,
    ].join("\n");
}

export function assertDirectEarthquakeWrapperResult(
    value: unknown,
    expectedAttestationPublicKey: string,
): unknown {
    if (!isRecord(value) || value.status !== "finalized") {
        throw new Error("Expected direct earthquake wrapper JSON with status finalized");
    }
    if (isRecord(value.result) && value.ok === true) {
        throw new Error("Expected direct earthquake wrapper JSON, not { ok, result }");
    }
    const rawDataManifest = value.raw_data_manifest;
    if (!isRecord(rawDataManifest) || !Array.isArray(rawDataManifest.entries)) {
        throw new Error("Expected raw_data_manifest.entries in finalized result");
    }
    if (rawDataManifest.entries.length !== 2) {
        throw new Error("Expected raw_data_manifest.entries length to be 2");
    }

    const actualPublicKey = readPublicKey(value);
    if (actualPublicKey !== expectedAttestationPublicKey) {
        throw new Error("Finalized result public key does not match attestation public key");
    }

    for (const forbidden of [
        "raw_sources",
        "raw_source",
        "source_detail",
        "source_grid",
        "usgs_detail",
        "shakemap_grid",
    ]) {
        if (Object.hasOwn(value, forbidden)) {
            throw new Error(`Finalized result must not include ${forbidden}`);
        }
    }
    return value;
}

export function readAttestationPublicKey(value: unknown): string {
    if (isRecord(value) && typeof value.public_key === "string") {
        return value.public_key;
    }
    if (
        isRecord(value) &&
        isRecord(value.attestation) &&
        typeof value.attestation.public_key === "string"
    ) {
        return value.attestation.public_key;
    }
    throw new Error("Unable to read attestation public_key");
}

export function parseJsonText(text: string, label: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch (error) {
        throw new Error(`${label} returned invalid JSON: ${String(error)}`);
    }
}

export function parseArgs(args: readonly string[]): Record<string, string | boolean> {
    const parsed: Record<string, string | boolean> = {};
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--") {
            continue;
        }
        if (!arg?.startsWith("--")) {
            throw new Error(`Unexpected argument ${arg}`);
        }
        const key = arg.slice(2);
        const next = args[index + 1];
        if (next === undefined || next.startsWith("--")) {
            parsed[key] = true;
            continue;
        }
        parsed[key] = next;
        index += 1;
    }
    return parsed;
}

export function readStringOption(
    options: Record<string, string | boolean>,
    key: string,
    fallback: string,
): string {
    const value = options[key];
    return typeof value === "string" && value.length > 0 ? value : fallback;
}

export type AsgSummary = {
    name: string;
    desiredCapacity: number;
    maxSize: number;
    instances: Array<{ instanceId: string; lifecycleState: string }>;
};

function readCommandId(value: unknown): string {
    if (isRecord(value) && isRecord(value.Command) && typeof value.Command.CommandId === "string") {
        return value.Command.CommandId;
    }
    if (isRecord(value) && typeof value.CommandId === "string") {
        return value.CommandId;
    }
    throw new Error("Unable to read SSM CommandId");
}

function firstStack(response: unknown): Record<string, unknown> {
    if (!isRecord(response)) {
        throw new Error("CloudFormation response must be an object");
    }
    const stacks = readArray(response.Stacks, "Stacks");
    const stack = stacks[0];
    if (!isRecord(stack)) {
        throw new Error("CloudFormation response did not include Stacks[0]");
    }
    return stack;
}

function readArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array`);
    }
    return value;
}

function readNumber(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${label} must be a number`);
    }
    return value;
}

function readPublicKey(value: Record<string, unknown>): string {
    if (typeof value.enclave_instance_public_key === "string") {
        return value.enclave_instance_public_key;
    }
    if (typeof value.public_key === "string") {
        return value.public_key;
    }
    if (isRecord(value.signature) && typeof value.signature.public_key === "string") {
        return value.signature.public_key;
    }
    if (isRecord(value.attestation) && typeof value.attestation.public_key === "string") {
        return value.attestation.public_key;
    }
    throw new Error("Finalized result public key is required");
}

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
