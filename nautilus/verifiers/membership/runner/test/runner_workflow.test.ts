import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryVerificationJobRepository } from "../src/index.js";
import {
    type AutoScalingClientLike,
    buildRunnerBootstrapReadinessShellCommand,
    createRunnerControlHandler,
    type Ec2ClientLike,
    handler as runnerWorkflowHandler,
    type S3ClientLike,
    type SsmClientLike,
    type SuiSubmissionAdapter,
} from "../src/runner_workflow.js";
import { validRequest } from "./fixtures.js";

const baseNowMs = 1_800_000_000_000;

describe("membership runner workflow", () => {
    it("retains membership verifier kind across common runner workflow actions", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const ssm = new RecordingSsmClient({
            onlineInstanceIds: ["i-ready"],
            bootstrapReady: true,
            commandId: "cmd-1",
            invocationStatus: "Success",
        });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client([{ instanceId: "i-ready", state: "running" }]),
            ssm,
            s3: new RecordingS3Client({
                [`results/${job.row.job_id}/${baseNowMs + 2}.json`]: JSON.stringify({
                    status: "pending_source",
                    error_code: "WORLD_ID_API_UNAVAILABLE",
                }),
            }),
            repository,
            now: () => baseNowMs + 2,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "start_instance",
                verifier_kind: "membership_identity",
                job_id: job.row.job_id,
                attempt: 1,
            } as never),
        ).resolves.toMatchObject({ verifier_kind: "membership_identity", capacity: 1 });
        await expect(
            handler({
                action: "find_ready_instance",
                verifier_kind: "membership_identity",
                job_id: job.row.job_id,
                attempt: 1,
            } as never),
        ).resolves.toMatchObject({
            verifier_kind: "membership_identity",
            instance_id: "i-ready",
        });
        await expect(
            handler({
                action: "dispatch_tee_command",
                verifier_kind: "membership_identity",
                job_id: job.row.job_id,
                attempt: 1,
                instance_id: "i-ready",
            } as never),
        ).resolves.toMatchObject({
            verifier_kind: "membership_identity",
            command_id: "cmd-1",
            result_s3_key: `results/${job.row.job_id}/${baseNowMs + 2}.json`,
        });
        await expect(
            handler({
                action: "poll_command",
                verifier_kind: "membership_identity",
                job_id: job.row.job_id,
                attempt: 1,
                instance_id: "i-ready",
                command_id: "cmd-1",
                result_s3_key: `results/${job.row.job_id}/${baseNowMs + 2}.json`,
                command_poll_count: 0,
            } as never),
        ).resolves.toMatchObject({
            verifier_kind: "membership_identity",
            command_status: "SUCCEEDED",
        });
        await expect(
            handler({
                action: "read_result",
                verifier_kind: "membership_identity",
                job_id: job.row.job_id,
                attempt: 1,
                result_s3_key: `results/${job.row.job_id}/${baseNowMs + 2}.json`,
            } as never),
        ).resolves.toMatchObject({ verifier_kind: "membership_identity" });
    });

    it("fails closed before AWS setup for unknown verifier kind at the workflow boundary", async () => {
        await expect(
            runnerWorkflowHandler({
                action: "start_instance",
                verifier_kind: "earthquake",
                job_id: "job-1",
                attempt: 1,
            } as never),
        ).rejects.toThrow(/verifier_kind/);
    });

    it("starts EC2 capacity and finds a bootstrap-ready SSM-managed runner", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const autoscaling = new RecordingAutoScalingClient();
        const handler = createRunnerControlHandler({
            autoscaling,
            ec2: new RecordingEc2Client([{ instanceId: "i-ready", state: "running" }]),
            ssm: new RecordingSsmClient({
                onlineInstanceIds: ["i-ready"],
                bootstrapReady: true,
            }),
            s3: new RecordingS3Client(),
            repository,
            config: baseConfig(),
        });

        await expect(
            handler({ action: "start_instance", job_id: job.row.job_id, attempt: 1 }),
        ).resolves.toEqual({
            job_id: job.row.job_id,
            attempt: 1,
            capacity: 1,
        });
        await expect(
            handler({ action: "find_ready_instance", job_id: job.row.job_id, attempt: 1 }),
        ).resolves.toEqual({
            job_id: job.row.job_id,
            attempt: 1,
            instance_id: "i-ready",
        });
        expect(autoscaling.capacities).toEqual([1]);
    });

    it("fails closed when the SSM-managed runner is not bootstrap and proxy ready", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client([{ instanceId: "i-ready", state: "running" }]),
            ssm: new RecordingSsmClient({
                onlineInstanceIds: ["i-ready"],
                bootstrapReady: false,
            }),
            s3: new RecordingS3Client(),
            repository,
            config: baseConfig(),
        });

        await expect(
            handler({ action: "find_ready_instance", job_id: "job", attempt: 1 }),
        ).rejects.toThrow(/bootstrap-ready/);

        const readiness = buildRunnerBootstrapReadinessShellCommand();
        expect(readiness).toContain("systemctl is-active --quiet nitro-enclaves-allocator.service");
        expect(readiness).toContain(
            "systemctl is-active --quiet sonari-world-id-vsock-proxy.service",
        );
        expect(readiness).toContain("SONARI_WORLD_ID_API_BASE is required");
        expect(readiness).toContain("SONARI_WORLD_ID_APP_ID is required");
        expect(readiness).toContain("SONARI_MEMBERSHIP_IDENTITY_EIF_PATH is required");
        expect(readiness).toContain("SONARI_NITRO_RUN_ENCLAVE_ARGS is required");
        expect(readiness).toContain("SONARI_ENCLAVE_STDIO_BRIDGE is required");
        expect(readiness).toContain('test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"');
        expect(readiness).toContain('test -x "$SONARI_ENCLAVE_STDIO_BRIDGE"');
        expect(readiness).not.toContain("SONARI_TEE_SIGNING_KEY_SEED");
    });

    it("dispatches the job request JSON to the enclave command through SSM", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const ssm = new RecordingSsmClient({ commandId: "cmd-1" });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            repository,
            now: () => baseNowMs + 2,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "dispatch_tee_command",
                job_id: job.row.job_id,
                attempt: 1,
                instance_id: "i-runner",
            }),
        ).resolves.toEqual({
            job_id: job.row.job_id,
            attempt: 1,
            instance_id: "i-runner",
            command_id: "cmd-1",
            result_s3_key: `results/${job.row.job_id}/${baseNowMs + 2}.json`,
            command_poll_count: 0,
        });

        const command = ssm.sentCommands[0]?.shellCommand ?? "";
        const row = await repository.get(job.row.job_id);
        expect(row).not.toBeNull();
        expect(command).toContain("source /opt/sonari/runner.env");
        expect(command).toContain(
            "systemctl is-active --quiet sonari-world-id-vsock-proxy.service",
        );
        expect(command).toContain(
            "export SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE SONARI_SIGNING_MATERIAL_KMS_KEY_ID SONARI_MEMBERSHIP_IDENTITY_EIF_PATH SONARI_NITRO_RUN_ENCLAVE_ARGS SONARI_ENCLAVE_STDIO_BRIDGE SONARI_WORLD_ID_API_BASE SONARI_WORLD_ID_APP_ID NITRO_ENCLAVE_PROCESS_COMMAND",
        );
        expect(command).toContain(
            `printf '%s' ${shellSingleQuote(row?.request_json ?? "")} | '/opt/sonari/bin/run-membership-identity-enclave'`,
        );
        expect(command).toContain(
            `aws s3 cp '/tmp/sonari-membership-tee-result-${job.row.job_id}-${baseNowMs + 2}.json' 's3://runner-results/results/${job.row.job_id}/${baseNowMs + 2}.json'`,
        );
        expect(command).not.toContain("SONARI_TEE_SIGNING_KEY_SEED");
        expect(command).not.toContain(
            " | '/opt/sonari/tee-artifact/bin/membership-tee' 'production'",
        );
    });

    it("polls pending SSM command state and treats missing invocations as pending", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const ssm = new RecordingSsmClient({
            invocationError: Object.assign(new Error("not propagated"), {
                name: "InvocationDoesNotExist",
            }),
        });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            repository,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "poll_command",
                job_id: job.row.job_id,
                attempt: 1,
                instance_id: "i-runner",
                command_id: "cmd-1",
                result_s3_key: "results/job/result.json",
                command_poll_count: 4,
            }),
        ).resolves.toMatchObject({
            command_status: "PENDING",
            command_poll_count: 5,
        });
    });

    it("applies pending_source TEE output as retry without requiring a signature", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client({
                "results/job/pending.json": JSON.stringify({
                    status: "pending_source",
                    error_code: "WORLD_ID_API_UNAVAILABLE",
                }),
            }),
            repository,
            now: () => baseNowMs + 2,
            config: baseConfig(),
        });

        const read = await handler({
            action: "read_result",
            job_id: job.row.job_id,
            attempt: 1,
            result_s3_key: "results/job/pending.json",
        });
        await expect(
            handler({
                action: "apply_result",
                job_id: job.row.job_id,
                attempt: 1,
                result: "result" in read ? read.result : neverResult(),
            }),
        ).resolves.toMatchObject({ applied: true });

        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "retry",
            retry_count: 1,
            next_retry_at_ms: baseNowMs + 15 * 60 * 1000 + 2,
            error_code: null,
            error_message: "WORLD_ID_API_UNAVAILABLE",
        });
    });

    it("applies rejected TEE output as failed status-only result", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client({
                "results/job/rejected.json": JSON.stringify({
                    status: "rejected",
                    error_code: "WORLD_ID_VERIFICATION_FAILED",
                }),
            }),
            repository,
            now: () => baseNowMs + 2,
            config: baseConfig(),
        });

        const read = await handler({
            action: "read_result",
            job_id: job.row.job_id,
            attempt: 1,
            result_s3_key: "results/job/rejected.json",
        });
        await handler({
            action: "apply_result",
            job_id: job.row.job_id,
            attempt: 1,
            result: "result" in read ? read.result : neverResult(),
        });

        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "failed",
            error_code: "WORLD_ID_VERIFICATION_FAILED",
            error_message: "WORLD_ID_VERIFICATION_FAILED",
        });
    });

    it("skips Sui submission for status-only TEE output", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const submitter = new RecordingSuiSubmissionAdapter();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            suiSubmission: submitter,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "dry_run_sui_submission",
                job_id: job.row.job_id,
                attempt: 1,
                result: { status: "pending_source", error_code: "WAIT" },
            }),
        ).resolves.toMatchObject({ sui_submission: "skipped" });
        await expect(
            handler({
                action: "submit_sui_submission",
                job_id: job.row.job_id,
                attempt: 1,
                result: { status: "rejected", error_code: "NOPE" },
            }),
        ).resolves.toMatchObject({ sui_submission: "skipped" });
        expect(submitter.dryRuns).toEqual([]);
        expect(submitter.submits).toEqual([]);
    });

    it("fails closed when verified dry-run or submit configuration is missing", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        const submitJob = await repository.upsertRequest(
            {
                ...validRequest(),
                signed_statement_hash: `0x${"88".repeat(32)}`,
            },
            baseNowMs,
        );
        await repository.claimNextDue(baseNowMs + 1);
        await repository.claimNextDue(baseNowMs + 1);
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            now: () => baseNowMs + 2,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "dry_run_sui_submission",
                job_id: job.row.job_id,
                attempt: 1,
                result: verifiedTeeResult(),
            }),
        ).resolves.toMatchObject({ sui_submission: "failed" });
        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "failed",
            error_code: "RELAYER_SUBMIT_FAILED",
            error_message: "Sui submission config is required",
        });
        await expect(
            handler({
                action: "submit_sui_submission",
                job_id: submitJob.row.job_id,
                attempt: 1,
                result: {
                    ...verifiedTeeResult(),
                    signed_statement_hash: `0x${"88".repeat(32)}`,
                },
            }),
        ).resolves.toMatchObject({ sui_submission: "failed" });
        await expect(repository.get(submitJob.row.job_id)).resolves.toMatchObject({
            status: "failed",
            error_code: "RELAYER_SUBMIT_FAILED",
            error_message: "Sui submission config is required",
        });
    });

    it("records submit tx digest and keeps the original digest on duplicate completion", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const submitter = new RecordingSuiSubmissionAdapter({
            submitDigest: "tx-original",
        });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            suiSubmission: submitter,
            now: () => baseNowMs + 2,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "submit_sui_submission",
                job_id: job.row.job_id,
                attempt: 1,
                result: verifiedTeeResult(),
            }),
        ).resolves.toMatchObject({
            sui_submission: "succeeded",
            tx_digest: "tx-original",
        });
        await repository.markCompleted(job.row.job_id, baseNowMs + 3, "tx-late-duplicate");

        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "completed",
            tx_digest: "tx-original",
            completed_at_ms: baseNowMs + 2,
        });
        expect(submitter.submits).toEqual([
            {
                status: "verified",
                payload_bcs_hex: "0x010203",
                signature: `0x${"11".repeat(64)}`,
                public_key: `0x${"22".repeat(32)}`,
            },
        ]);
    });

    it("records explicit timeout failures", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            now: () => baseNowMs + 2,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "mark_failed",
                job_id: job.row.job_id,
                attempt: 1,
                error_code: "AWS_MEMBERSHIP_RUNNER_TIMEOUT",
                message: "SSM command polling exceeded 30 minutes",
            }),
        ).resolves.toMatchObject({ failed: true });
        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "failed",
            error_code: "AWS_MEMBERSHIP_RUNNER_TIMEOUT",
            error_message: "SSM command polling exceeded 30 minutes",
        });
    });

    it("rejects stale workflow attempts before mutating job state", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        await repository.markRetry(job.row.job_id, baseNowMs + 2, baseNowMs + 3, "retry");
        await repository.claimNextDue(baseNowMs + 3);
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "mark_failed",
                job_id: job.row.job_id,
                attempt: 1,
                error_code: "AWS_MEMBERSHIP_RUNNER_TIMEOUT",
            }),
        ).rejects.toThrow(/stale runner workflow attempt/);
        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "processing",
            retry_count: 1,
            error_message: "retry",
        });
    });

    it("bootstraps a fail-closed World ID vsock proxy in the membership AWS template", async () => {
        const template = await readFile(
            path.resolve(process.cwd(), "infra/aws/membership-identity-runner/template.yaml"),
            "utf8",
        );

        expect(template).toContain('vsock_proxy_path="$(command -v vsock-proxy)"');
        expect(template).toContain("sonari-world-id-vsock-proxy.service");
        expect(template).toContain("ExecStart=$vsock_proxy_path 8000 $world_id_api_host 443");
        expect(template).toContain("TeeEifS3Bucket:");
        expect(template).toContain("TeeEifS3Key:");
        expect(template).toContain("TeeEifSha256:");
        expect(template).toContain("aws s3 cp 's3://$");
        expect(template).toContain("{TeeEifS3Bucket}/$");
        expect(template).toContain("{TeeEifS3Key}'");
        expect(template).toContain("/opt/sonari/bin/run-membership-identity-enclave");
        expect(template).toContain("printf 'SONARI_MEMBERSHIP_IDENTITY_EIF_PATH=%q");
        expect(template).toContain(
            "SONARI_ENCLAVE_STDIO_BRIDGE=/usr/local/bin/sonari-enclave-stdio",
        );
        expect(template).toContain("printf 'SONARI_NITRO_RUN_ENCLAVE_ARGS=%q");
        expect(template).toContain("test -x /usr/local/bin/sonari-enclave-stdio");
        expect(template).toContain("systemctl enable --now sonari-world-id-vsock-proxy.service");
        expect(template).toContain(
            "systemctl is-active --quiet sonari-world-id-vsock-proxy.service",
        );
        expect(template).toContain("SONARI_WORLD_ID_UPSTREAM_API_BASE");
        expect(template).toContain("SONARI_WORLD_ID_API_BASE=http://127.0.0.1:8000");
        expect(template).toContain("touch /opt/sonari/bootstrap-complete");
    });
});

function baseConfig() {
    return {
        autoScalingGroupName: "membership-runner-asg",
        resultBucket: "runner-results",
        nitroEnclaveProcessCommand: "/opt/sonari/bin/run-membership-identity-enclave",
    };
}

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function neverResult(): never {
    throw new Error("expected read_result output");
}

function verifiedTeeResult() {
    return {
        status: "verified" as const,
        payload_bcs_hex: "0x010203",
        signature: `0x${"11".repeat(64)}`,
        public_key: `0x${"22".repeat(32)}`,
        intent: "SONARI_IDENTITY_VERIFICATION_V1",
        verifier_family: "identity" as const,
        verifier_version: 1,
        registry_id: validRequest().registry_id,
        membership_id: validRequest().membership_id,
        owner: validRequest().owner,
        provider: validRequest().provider,
        verified: true,
        duplicate_key_hash: `0x${"66".repeat(32)}`,
        evidence_hash: `0x${"77".repeat(32)}`,
        issued_at_ms: baseNowMs,
        expires_at_ms: baseNowMs + 1,
        terms_version: validRequest().terms_version,
        signed_statement_hash: validRequest().signed_statement_hash,
    };
}

class RecordingAutoScalingClient implements AutoScalingClientLike {
    readonly capacities: number[] = [];

    async setDesiredCapacity(input: {
        autoScalingGroupName: string;
        desiredCapacity: number;
    }): Promise<void> {
        this.capacities.push(input.desiredCapacity);
    }
}

class RecordingEc2Client implements Ec2ClientLike {
    constructor(private readonly instances: Array<{ instanceId: string; state: string }> = []) {}

    async listRunnerInstances(): Promise<Array<{ instanceId: string; state: string }>> {
        return this.instances;
    }
}

class RecordingSsmClient implements SsmClientLike {
    readonly sentCommands: Array<{ instanceId: string; shellCommand: string }> = [];

    constructor(
        private readonly options: {
            onlineInstanceIds?: string[];
            bootstrapReady?: boolean;
            commandId?: string;
            invocationStatus?: string;
            invocationError?: unknown;
        } = {},
    ) {}

    async listOnlineManagedInstanceIds(): Promise<Set<string>> {
        return new Set(this.options.onlineInstanceIds ?? []);
    }

    async checkRunnerBootstrapReady(): Promise<boolean> {
        return this.options.bootstrapReady ?? true;
    }

    async sendCommand(input: {
        instanceId: string;
        shellCommand: string;
    }): Promise<{ commandId: string }> {
        this.sentCommands.push(input);
        return { commandId: this.options.commandId ?? "cmd-default" };
    }

    async getCommandInvocation(): Promise<{ status: string }> {
        if (this.options.invocationError !== undefined) {
            throw this.options.invocationError;
        }
        return { status: this.options.invocationStatus ?? "Success" };
    }
}

class RecordingS3Client implements S3ClientLike {
    constructor(private readonly objects: Record<string, string> = {}) {}

    async getObjectText(input: { bucket: string; key: string }): Promise<string> {
        const object = this.objects[input.key];
        if (object === undefined) {
            throw new Error(`missing test object: ${input.key}`);
        }
        return object;
    }
}

class RecordingSuiSubmissionAdapter implements SuiSubmissionAdapter {
    readonly dryRuns: unknown[] = [];
    readonly submits: unknown[] = [];

    constructor(
        private readonly options: {
            dryRunDigest?: string;
            submitDigest?: string;
        } = {},
    ) {}

    async dryRun(result: unknown) {
        this.dryRuns.push(result);
        return {
            ok: true as const,
            value: {
                mode: "dry_run" as const,
                request: fakeSuiRequest(),
                transactionBytes: [1, 2, 3],
                effects: {
                    digest: this.options.dryRunDigest,
                },
            },
        };
    }

    async submit(result: unknown) {
        this.submits.push(result);
        return {
            ok: true as const,
            value: {
                mode: "submit" as const,
                request: fakeSuiRequest(),
                digest: this.options.submitDigest ?? "tx-default",
                effects: {},
            },
        };
    }
}

function fakeSuiRequest() {
    return {
        target: "0xabc::accessor::update_identity_verification",
        packageId: "0xabc",
        pauseStateId: "0x111",
        identityRegistryId: "0x222",
        membershipRegistryId: "0x333",
        verifierRegistryId: "0x444",
        membershipPassId: "0x555",
        clockId: "0x6",
        arguments: [
            "0x111",
            "0x222",
            "0x333",
            "0x444",
            "0x555",
            "0x6",
            [1, 2, 3],
            Array.from({ length: 64 }, () => 0x11),
            Array.from({ length: 32 }, () => 0x22),
        ] as [string, string, string, string, string, string, number[], number[], number[]],
    };
}
