import { describe, expect, it } from "vitest";
import {
    acquireSharedRunnerLease,
    buildSharedRunnerLeaseOwner,
    dispatchRunnerCommand,
    findReadyRunnerInstance,
    parseExpectedVerifierKind,
    parseVerifierKind,
    pollRunnerCommand,
    readRunnerResultText,
    releaseSharedRunnerLease,
    type SharedRunnerLeaseStore,
    setRunnerDesiredCapacity,
    withVerifierKind,
} from "./index.js";

describe("verifier kind contract", () => {
    it("accepts earthquake", () => {
        expect(parseVerifierKind("earthquake")).toBe("earthquake");
    });

    it("accepts membership_identity", () => {
        expect(parseVerifierKind("membership_identity")).toBe("membership_identity");
    });

    it("rejects unknown values fail-closed", () => {
        expect(() => parseVerifierKind("membership")).toThrow(/verifier_kind/);
        expect(() => parseVerifierKind(undefined)).toThrow(/verifier_kind/);
        expect(() => parseVerifierKind({ verifier_kind: "earthquake" })).toThrow(/verifier_kind/);
    });

    it("fails closed when a known kind reaches the wrong workflow boundary", () => {
        expect(parseExpectedVerifierKind("earthquake", "earthquake")).toBe("earthquake");
        expect(() => parseExpectedVerifierKind("membership_identity", "earthquake")).toThrow(
            /verifier_kind/,
        );
    });
});

describe("common runner dispatcher", () => {
    it("orchestrates EC2 capacity, SSM command lifecycle, and S3 result reads", async () => {
        const autoscaling = new RecordingAutoScalingClient();
        const ssm = new RecordingSsmClient();

        await setRunnerDesiredCapacity(autoscaling, {
            autoScalingGroupName: "runner-asg",
            desiredCapacity: 1,
        });
        await expect(
            findReadyRunnerInstance(new RecordingEc2Client(), ssm, {
                autoScalingGroupName: "runner-asg",
            }),
        ).resolves.toBe("i-ready");
        await expect(
            dispatchRunnerCommand(ssm, {
                workflowId: "job-1",
                instanceId: "i-ready",
                dispatchTimestampMs: 1_800_000_000_000,
                buildShellCommand: (resultS3Key) => `run verifier > ${resultS3Key}`,
            }),
        ).resolves.toEqual({
            commandId: "cmd-1",
            resultS3Key: "results/job-1/1800000000000.json",
            commandPollCount: 0,
        });
        await expect(
            pollRunnerCommand(ssm, {
                instanceId: "i-ready",
                commandId: "cmd-1",
                commandPollCount: 0,
            }),
        ).resolves.toEqual({ commandStatus: "SUCCEEDED", commandPollCount: 0 });
        await expect(
            readRunnerResultText(new RecordingS3Client(), {
                bucket: "runner-results",
                key: "results/job-1/1800000000000.json",
            }),
        ).resolves.toBe('{"status":"ok"}');

        expect(autoscaling.capacities).toEqual([1]);
        expect(ssm.commands).toEqual([
            {
                instanceId: "i-ready",
                shellCommand: "run verifier > results/job-1/1800000000000.json",
            },
        ]);
    });

    it("retains verifier kind on dispatcher outputs only when the boundary provided one", () => {
        expect(withVerifierKind("earthquake", { capacity: 1 })).toEqual({
            verifier_kind: "earthquake",
            capacity: 1,
        });
        expect(withVerifierKind(undefined, { capacity: 1 })).toEqual({ capacity: 1 });
    });

    it("serializes shared runner leases across verifier kinds", async () => {
        const store = new InMemorySharedRunnerLeaseStore();
        const earthquakeOwner = buildSharedRunnerLeaseOwner({
            verifierKind: "earthquake",
            workflowId: "us7000sonari",
            attempt: 1,
        });
        const membershipOwner = buildSharedRunnerLeaseOwner({
            verifierKind: "membership_identity",
            workflowId: "membership-job-1",
            attempt: 1,
        });

        await acquireSharedRunnerLease(store, { owner: earthquakeOwner, nowMs: 1_800_000_000_000 });
        await expect(
            acquireSharedRunnerLease(store, { owner: membershipOwner, nowMs: 1_800_000_001_000 }),
        ).rejects.toThrow(/already leased/);
        await expect(releaseSharedRunnerLease(store, membershipOwner)).resolves.toBe(false);
        await expect(releaseSharedRunnerLease(store, earthquakeOwner)).resolves.toBe(true);
        await expect(
            acquireSharedRunnerLease(store, { owner: membershipOwner, nowMs: 1_800_000_002_000 }),
        ).resolves.toBeUndefined();
    });
});

class RecordingAutoScalingClient {
    readonly capacities: number[] = [];

    async setDesiredCapacity(input: { desiredCapacity: number }): Promise<void> {
        this.capacities.push(input.desiredCapacity);
    }
}

class RecordingEc2Client {
    async listRunnerInstances(): Promise<Array<{ instanceId: string; state: string }>> {
        return [
            { instanceId: "i-stopped", state: "stopped" },
            { instanceId: "i-ready", state: "running" },
        ];
    }
}

class RecordingSsmClient {
    readonly commands: Array<{ instanceId: string; shellCommand: string }> = [];

    async listOnlineManagedInstanceIds(): Promise<Set<string>> {
        return new Set(["i-ready"]);
    }

    async checkRunnerBootstrapReady(instanceId: string): Promise<boolean> {
        return instanceId === "i-ready";
    }

    async sendCommand(input: {
        instanceId: string;
        shellCommand: string;
    }): Promise<{ commandId: string }> {
        this.commands.push(input);
        return { commandId: "cmd-1" };
    }

    async getCommandInvocation(): Promise<{ status: string }> {
        return { status: "Success" };
    }
}

class RecordingS3Client {
    async getObjectText(): Promise<string> {
        return '{"status":"ok"}';
    }
}

class InMemorySharedRunnerLeaseStore implements SharedRunnerLeaseStore {
    private lease:
        | {
              owner: string;
              expiresAtSeconds: number;
          }
        | undefined;

    async acquire(input: {
        leaseId: string;
        owner: string;
        nowSeconds: number;
        expiresAtSeconds: number;
    }): Promise<void> {
        if (
            this.lease !== undefined &&
            this.lease.owner !== input.owner &&
            this.lease.expiresAtSeconds >= input.nowSeconds
        ) {
            throw new Error("shared runner is already leased by another verifier workflow");
        }
        this.lease = { owner: input.owner, expiresAtSeconds: input.expiresAtSeconds };
    }

    async release(input: { leaseId: string; owner: string }): Promise<boolean> {
        if (this.lease?.owner !== input.owner) {
            return false;
        }
        this.lease = undefined;
        return true;
    }
}
