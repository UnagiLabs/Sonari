export const EARTHQUAKE_VERIFIER_KIND = "earthquake";
export const MEMBERSHIP_IDENTITY_VERIFIER_KIND = "membership_identity";

export const VERIFIER_KINDS = [
    EARTHQUAKE_VERIFIER_KIND,
    MEMBERSHIP_IDENTITY_VERIFIER_KIND,
] as const;

export type VerifierKind = (typeof VERIFIER_KINDS)[number];

export function parseVerifierKind(input: unknown): VerifierKind {
    if (input === EARTHQUAKE_VERIFIER_KIND || input === MEMBERSHIP_IDENTITY_VERIFIER_KIND) {
        return input;
    }
    throw new Error("verifier_kind must be earthquake or membership_identity");
}

export interface RunnerAutoScalingClientLike {
    setDesiredCapacity(input: {
        autoScalingGroupName: string;
        desiredCapacity: number;
    }): Promise<void>;
}

export interface RunnerEc2ClientLike {
    listRunnerInstances(input: {
        autoScalingGroupName: string;
    }): Promise<Array<{ instanceId: string; state: string }>>;
}

export interface RunnerSsmClientLike {
    listOnlineManagedInstanceIds(input: { instanceIds: string[] }): Promise<Set<string>>;
    checkRunnerBootstrapReady(instanceId: string): Promise<boolean>;
    sendCommand(input: {
        instanceId: string;
        shellCommand: string;
    }): Promise<{ commandId: string }>;
    getCommandInvocation(input: {
        instanceId: string;
        commandId: string;
    }): Promise<{ status: string }>;
}

export interface RunnerS3ClientLike {
    getObjectText(input: { bucket: string; key: string }): Promise<string>;
}

export function parseExpectedVerifierKind(
    input: unknown,
    expected: VerifierKind,
): VerifierKind | undefined {
    if (input === undefined) {
        return undefined;
    }
    const verifierKind = parseVerifierKind(input);
    if (verifierKind !== expected) {
        throw new Error(`verifier_kind must be ${expected}`);
    }
    return verifierKind;
}

export function withVerifierKind<T extends object>(
    verifierKind: VerifierKind | undefined,
    output: T,
): T | (T & { verifier_kind: VerifierKind }) {
    if (verifierKind === undefined) {
        return output;
    }
    return { verifier_kind: verifierKind, ...output };
}

export async function setRunnerDesiredCapacity(
    autoscaling: RunnerAutoScalingClientLike,
    input: {
        autoScalingGroupName: string;
        desiredCapacity: number;
    },
): Promise<void> {
    await autoscaling.setDesiredCapacity(input);
}

export async function findReadyRunnerInstance(
    ec2: RunnerEc2ClientLike,
    ssm: RunnerSsmClientLike,
    input: {
        autoScalingGroupName: string;
        runnerLabel?: string | undefined;
    },
): Promise<string> {
    const instances = await ec2.listRunnerInstances({
        autoScalingGroupName: input.autoScalingGroupName,
    });
    const runningIds = instances
        .filter((instance) => instance.state === "running")
        .map((instance) => instance.instanceId);
    const onlineManagedInstanceIds = await ssm.listOnlineManagedInstanceIds({
        instanceIds: runningIds,
    });
    for (const instanceId of runningIds) {
        if (!onlineManagedInstanceIds.has(instanceId)) {
            continue;
        }
        if (await ssm.checkRunnerBootstrapReady(instanceId)) {
            return instanceId;
        }
    }
    const runnerLabel = input.runnerLabel ?? "runner";
    throw new Error(`No running SSM-managed ${runnerLabel} instance is bootstrap-ready`);
}

export async function dispatchRunnerCommand(
    ssm: RunnerSsmClientLike,
    input: {
        workflowId: string;
        instanceId: string;
        dispatchTimestampMs: number;
        buildShellCommand(resultS3Key: string): string;
    },
): Promise<{
    commandId: string;
    resultS3Key: string;
    commandPollCount: number;
}> {
    const resultS3Key = `results/${input.workflowId}/${input.dispatchTimestampMs}.json`;
    const sent = await ssm.sendCommand({
        instanceId: input.instanceId,
        shellCommand: input.buildShellCommand(resultS3Key),
    });
    return {
        commandId: sent.commandId,
        resultS3Key,
        commandPollCount: 0,
    };
}

export async function pollRunnerCommand(
    ssm: RunnerSsmClientLike,
    input: {
        instanceId: string;
        commandId: string;
        commandPollCount?: number | undefined;
    },
): Promise<{
    commandStatus: "PENDING" | "SUCCEEDED" | "FAILED";
    commandPollCount: number;
}> {
    const commandStatus = await pollCommandStatus(ssm, {
        instanceId: input.instanceId,
        commandId: input.commandId,
    });
    return {
        commandStatus,
        commandPollCount:
            commandStatus === "PENDING"
                ? (input.commandPollCount ?? 0) + 1
                : (input.commandPollCount ?? 0),
    };
}

export async function readRunnerResultText(
    s3: RunnerS3ClientLike,
    input: {
        bucket: string;
        key: string;
    },
): Promise<string> {
    return s3.getObjectText(input);
}

async function pollCommandStatus(
    ssm: RunnerSsmClientLike,
    input: { instanceId: string; commandId: string },
): Promise<"PENDING" | "SUCCEEDED" | "FAILED"> {
    try {
        const invocation = await ssm.getCommandInvocation(input);
        return normalizeCommandStatus(invocation.status);
    } catch (error) {
        if (isTransientCommandInvocationLookupError(error)) {
            return "PENDING";
        }
        throw error;
    }
}

function normalizeCommandStatus(status: string): "PENDING" | "SUCCEEDED" | "FAILED" {
    if (status === "Success") {
        return "SUCCEEDED";
    }
    if (status === "Pending" || status === "InProgress" || status === "Delayed") {
        return "PENDING";
    }
    return "FAILED";
}

function isTransientCommandInvocationLookupError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "InvocationDoesNotExist"
    );
}
