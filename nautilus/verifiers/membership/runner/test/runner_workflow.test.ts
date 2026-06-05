import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { InMemoryVerificationJobRepository } from "../src/index.js";
import {
    type AutoScalingClientLike,
    buildRunnerBootstrapReadinessShellCommand,
    createRunnerControlHandler,
    type Ec2ClientLike,
    readEnclaveRegistrationConfigFromEnv,
    readSuiSubmissionConfigFromEnv,
    handler as runnerWorkflowHandler,
    type S3ClientLike,
    type SsmClientLike,
    type SuiSubmissionAdapter,
} from "../src/runner_workflow.js";
import { validRequest } from "./fixtures.js";

const baseNowMs = 1_800_000_000_000;

describe("membership runner workflow", () => {
    const legacyLocalWorldIdBase = "SONARI_WORLD_ID_API_BASE=http://127.0.0.1:" + "8000";

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
        expect(readiness).toContain("SONARI_WORLD_ID_EGRESS_PROXY_URL is required");
        expect(readiness).toContain("SONARI_WORLD_ID_APP_ID is required");
        expect(readiness).toContain("SONARI_MEMBERSHIP_IDENTITY_EIF_PATH is required");
        expect(readiness).toContain("SONARI_NITRO_RUN_ENCLAVE_ARGS is required");
        expect(readiness).toContain("SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID is required");
        expect(readiness).toContain('test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"');
        expect(readiness).not.toContain("SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE");
        expect(readiness).not.toContain("SONARI_SIGNING_MATERIAL_KMS_KEY_ID");
        expect(readiness).not.toContain('test -s "$SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE"');
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
            "export SONARI_MEMBERSHIP_IDENTITY_EIF_PATH SONARI_NITRO_RUN_ENCLAVE_ARGS SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID SONARI_WORLD_ID_API_BASE SONARI_WORLD_ID_EGRESS_PROXY_URL SONARI_WORLD_ID_APP_ID NITRO_ENCLAVE_PROCESS_COMMAND",
        );
        // The shared run-sonari-verifier dispatcher selects the membership enclave
        // only when SONARI_VERIFIER_KIND is set; the SSM dispatch must export it.
        expect(command).toContain("export SONARI_VERIFIER_KIND=membership_identity");
        expect(command).toContain(
            `printf '%s' ${shellSingleQuote(row?.request_json ?? "")} | '/opt/sonari/bin/run-membership-identity-enclave'`,
        );
        expect(command).toContain(
            `aws s3 cp '/tmp/sonari-membership-tee-result-${job.row.job_id}-${baseNowMs + 2}.json' 's3://runner-results/results/${job.row.job_id}/${baseNowMs + 2}.json'`,
        );
        expect(command).not.toContain("SONARI_TEE_SIGNING_KEY_SEED");
        expect(command).not.toContain("SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE");
        expect(command).not.toContain("SONARI_SIGNING_MATERIAL_KMS_KEY_ID");
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

    it("applies verified TEE output as completed for TEE-only server path", async () => {
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
                action: "apply_result",
                job_id: job.row.job_id,
                attempt: 1,
                result: verifiedTeeResult(),
            }),
        ).resolves.toMatchObject({ applied: true, result: { status: "verified" } });

        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "completed",
            tx_digest: expect.stringMatching(/^tee-result:[0-9a-f]{64}$/),
            completed_at_ms: baseNowMs + 2,
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
            error_message: "Sui dry-run handoff is required before submit",
        });
    });

    it("records dry-run handoff data for verified TEE output before completion", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const submitter = new RecordingSuiSubmissionAdapter({
            dryRunDigest: "dry-run-digest",
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
                action: "dry_run_sui_submission",
                job_id: job.row.job_id,
                attempt: 1,
                result: verifiedTeeResult(),
            }),
        ).resolves.toMatchObject({ sui_submission: "succeeded" });

        const row = await repository.get(job.row.job_id);
        expect(row).toMatchObject({
            status: "processing",
            sui_dry_run_completed_at_ms: baseNowMs + 2,
        });
        expect(row?.sui_dry_run_result_json).not.toBeNull();
        const dryRunRecord = JSON.parse(row?.sui_dry_run_result_json ?? "{}") as {
            signed_payload?: unknown;
            request?: { target?: string };
            transaction_bytes?: number[];
            effects?: { digest?: string };
        };
        expect(dryRunRecord).toEqual({
            signed_payload: {
                status: "verified",
                payload_bcs_hex: "0x010203",
                signature: `0x${"11".repeat(64)}`,
                public_key: `0x${"22".repeat(32)}`,
                membership_id: validRequest().membership_id,
            },
            request: fakeSuiRequest(),
            transaction_bytes: [1, 2, 3],
            effects: { digest: "dry-run-digest" },
        });
        expect(submitter.dryRuns).toEqual([dryRunRecord.signed_payload]);
        expect(submitter.submits).toEqual([]);
    });

    it("allows submit-capable registration mode to run dry-run preflight without submit", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        let signAndExecuteCalls = 0;
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            now: () => baseNowMs + 2,
            config: {
                ...baseConfig(),
                suiSubmission: {
                    mode: "submit",
                    packageId: "0xabc",
                    pauseStateId: "0x111",
                    identityRegistryId: "0x222",
                    membershipRegistryId: "0x333",
                    verifierRegistryId: "0x444",
                    clockId: "0x6",
                    network: "testnet",
                    grpcUrl: "https://fullnode.testnet.sui.io:443",
                    senderAddress: "0xsender",
                    allowSubmit: true,
                    transaction: {
                        build: async () => new Uint8Array([4, 5, 6]),
                    },
                    client: {
                        simulateTransaction: async () => ({
                            $kind: "Transaction",
                            Transaction: {
                                digest: "dry-run-digest",
                                status: { success: true, error: null },
                                effects: { status: { success: true } },
                            },
                        }),
                        signAndExecuteTransaction: async () => {
                            signAndExecuteCalls += 1;
                            throw new Error("submit must not run during dry-run preflight");
                        },
                        waitForTransaction: async () => ({}),
                    },
                },
            },
        });

        await expect(
            handler({
                action: "dry_run_sui_submission",
                job_id: job.row.job_id,
                attempt: 1,
                result: verifiedTeeResult(),
            }),
        ).resolves.toMatchObject({ sui_submission: "succeeded" });

        const row = await repository.get(job.row.job_id);
        const dryRunRecord = JSON.parse(row?.sui_dry_run_result_json ?? "{}") as {
            transaction_bytes?: number[];
            submit_context?: unknown;
        };
        expect(row).toMatchObject({
            status: "processing",
            sui_dry_run_completed_at_ms: baseNowMs + 2,
        });
        expect(dryRunRecord.transaction_bytes).toEqual([4, 5, 6]);
        expect(dryRunRecord.submit_context).toEqual({
            network: "testnet",
            grpc_url: "https://fullnode.testnet.sui.io:443",
            sender_address: "0xsender",
        });
        expect(signAndExecuteCalls).toBe(0);
    });

    it("fails closed without a valid stored dry-run handoff before submit", async () => {
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
        ).resolves.toMatchObject({ sui_submission: "failed" });

        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "failed",
            error_code: "RELAYER_SUBMIT_FAILED",
            error_message: "Sui dry-run handoff is required before submit",
            tx_digest: null,
        });
        expect(submitter.submits).toEqual([]);
    });

    it("rejects malformed or mismatched stored dry-run handoff before submit", async () => {
        for (const [name, handoff] of [
            ["malformed", "{"],
            [
                // STEP 5: membership_id は tx args から除外済みのため、
                // payload_bcs_hex の改ざんで照合ミスを検出する
                "mismatched",
                JSON.stringify(
                    dryRunHandoffRecord({
                        signed_payload: {
                            ...signedPayloadForTest(),
                            payload_bcs_hex: `0x${"99".repeat(3)}`,
                        },
                    }),
                ),
            ],
        ] as const) {
            const repository = new InMemoryVerificationJobRepository();
            const job = await repository.upsertRequest(
                {
                    ...validRequest(),
                    signed_statement_hash:
                        name === "malformed" ? `0x${"89".repeat(32)}` : `0x${"8a".repeat(32)}`,
                },
                baseNowMs,
            );
            await repository.claimNextDue(baseNowMs + 1);
            await repository.markSuiDryRunSucceeded(job.row.job_id, baseNowMs + 2, handoff);
            const submitter = new RecordingSuiSubmissionAdapter();
            const handler = createRunnerControlHandler({
                autoscaling: new RecordingAutoScalingClient(),
                ec2: new RecordingEc2Client(),
                ssm: new RecordingSsmClient(),
                s3: new RecordingS3Client(),
                repository,
                suiSubmission: submitter,
                now: () => baseNowMs + 3,
                config: baseConfig(),
            });

            await expect(
                handler({
                    action: "submit_sui_submission",
                    job_id: job.row.job_id,
                    attempt: 1,
                    result: {
                        ...verifiedTeeResult(),
                        signed_statement_hash: JSON.parse(job.row.request_json)
                            .signed_statement_hash,
                    },
                }),
                name,
            ).resolves.toMatchObject({ sui_submission: "failed" });
            expect(submitter.submits, name).toEqual([]);
        }
    });

    it("rejects stored dry-run handoff with stale Sui request config before submit", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        await repository.markSuiDryRunSucceeded(
            job.row.job_id,
            baseNowMs + 2,
            JSON.stringify(
                dryRunHandoffRecord({
                    request: {
                        ...fakeSuiRequest(),
                        packageId: "0xstale",
                        target: "0xstale::accessor::update_identity_verification",
                    },
                }),
            ),
        );
        const submitter = new RecordingSuiSubmissionAdapter();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            suiSubmission: submitter,
            now: () => baseNowMs + 3,
            config: {
                ...baseConfig(),
                suiSubmission: fakeRunnerSuiSubmissionConfig(),
            },
        });

        await expect(
            handler({
                action: "submit_sui_submission",
                job_id: job.row.job_id,
                attempt: 1,
                result: verifiedTeeResult(),
            }),
        ).resolves.toMatchObject({ sui_submission: "failed" });

        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "failed",
            error_code: "RELAYER_SUBMIT_FAILED",
            error_message: "Stored Sui dry-run request target does not match submit config",
            tx_digest: null,
        });
        expect(submitter.submits).toEqual([]);
    });

    it("rejects stored dry-run handoff with stale Sui submit context before submit", async () => {
        for (const [name, submitContext, expectedMessage] of [
            [
                "network",
                {
                    ...fakeSuiSubmitContext(),
                    network: "devnet",
                    grpc_url: "https://fullnode.devnet.sui.io:443",
                },
                "Stored Sui dry-run submit_context network does not match submit config",
            ],
            [
                "grpcUrl",
                {
                    ...fakeSuiSubmitContext(),
                    grpc_url: "https://fullnode.mainnet.sui.io:443",
                },
                "Stored Sui dry-run submit_context grpcUrl does not match submit config",
            ],
            [
                "senderAddress",
                {
                    ...fakeSuiSubmitContext(),
                    sender_address: "0xother-sender",
                },
                "Stored Sui dry-run submit_context senderAddress does not match submit config",
            ],
        ] as const) {
            const repository = new InMemoryVerificationJobRepository();
            const job = await repository.upsertRequest(
                {
                    ...validRequest(),
                    signed_statement_hash:
                        name === "network"
                            ? `0x${"8b".repeat(32)}`
                            : name === "grpcUrl"
                              ? `0x${"8c".repeat(32)}`
                              : `0x${"8d".repeat(32)}`,
                },
                baseNowMs,
            );
            await repository.claimNextDue(baseNowMs + 1);
            await repository.markSuiDryRunSucceeded(
                job.row.job_id,
                baseNowMs + 2,
                JSON.stringify(dryRunHandoffRecord({ submit_context: submitContext })),
            );
            const submitter = new RecordingSuiSubmissionAdapter();
            const handler = createRunnerControlHandler({
                autoscaling: new RecordingAutoScalingClient(),
                ec2: new RecordingEc2Client(),
                ssm: new RecordingSsmClient(),
                s3: new RecordingS3Client(),
                repository,
                suiSubmission: submitter,
                now: () => baseNowMs + 3,
                config: {
                    ...baseConfig(),
                    suiSubmission: fakeRunnerSuiSubmissionConfig(),
                },
            });

            await expect(
                handler({
                    action: "submit_sui_submission",
                    job_id: job.row.job_id,
                    attempt: 1,
                    result: {
                        ...verifiedTeeResult(),
                        signed_statement_hash: JSON.parse(job.row.request_json)
                            .signed_statement_hash,
                    },
                }),
                name,
            ).resolves.toMatchObject({ sui_submission: "failed" });

            await expect(repository.get(job.row.job_id), name).resolves.toMatchObject({
                status: "failed",
                error_code: "RELAYER_SUBMIT_FAILED",
                error_message: expectedMessage,
                tx_digest: null,
            });
            expect(submitter.submits, name).toEqual([]);
        }
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

        await handler({
            action: "dry_run_sui_submission",
            job_id: job.row.job_id,
            attempt: 1,
            result: verifiedTeeResult(),
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
        expect(submitter.submits).toEqual([verifiedTeeResult()]);
    });

    it("records submit tx digest when post-submit waitForTransaction fails (digest-based result)", async () => {
        // STEP 5: readback 廃止のため waitForTransaction 失敗のケースをテスト
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const submitter = new RecordingSuiSubmissionAdapter({
            submitDigest: "tx-wait-failed",
            submitFailureMessage: "waitForTransaction timed out",
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

        await handler({
            action: "dry_run_sui_submission",
            job_id: job.row.job_id,
            attempt: 1,
            result: verifiedTeeResult(),
        });
        await expect(
            handler({
                action: "submit_sui_submission",
                job_id: job.row.job_id,
                attempt: 1,
                result: verifiedTeeResult(),
            }),
        ).resolves.toMatchObject({ sui_submission: "failed" });

        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "failed",
            tx_digest: "tx-wait-failed",
            error_code: "RELAYER_SUBMIT_FAILED",
            error_message: "waitForTransaction timed out",
        });
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

    it("bootstraps fail-closed World ID egress and server bootstrap in the membership AWS template", async () => {
        const template = await readFile(
            new URL(
                "../../../../../infra/aws/membership-identity-runner/template.yaml",
                import.meta.url,
            ),
            "utf8",
        );

        expect(template).toContain('vsock_proxy_path="$(command -v vsock-proxy)"');
        expect(template).toContain("sonari-world-id-vsock-proxy.service");
        expect(template).toContain(
            "ExecStart=/opt/sonari/bin/sonari-world-id-egress-connect-proxy --listen-port 18081 --allowlist-file /opt/sonari/world-id-egress-allowlist",
        );
        expect(template).toContain("ExecStart=$vsock_proxy_path 18080 127.0.0.1 18081");
        expect(template).toContain("SONARI_WORLD_ID_EGRESS_PROXY_URL=http://127.0.0.1:18080");
        expect(template).toContain('--arg egress_proxy_url "$SONARI_WORLD_ID_EGRESS_PROXY_URL"');
        expect(template).toContain("egress_proxy_url: $egress_proxy_url");
        expect(template).toContain("TeeEifS3Bucket:");
        expect(template).toContain("TeeEifS3Key:");
        expect(template).toContain("TeeEifSha256:");
        expect(template).toContain("aws s3 cp 's3://$");
        expect(template).toContain("{TeeEifS3Bucket}/$");
        expect(template).toContain("{TeeEifS3Key}'");
        expect(template).toContain("/opt/sonari/bin/run-membership-identity-enclave");
        expect(template).toContain("printf 'SONARI_MEMBERSHIP_IDENTITY_EIF_PATH=%q");
        expect(template).toContain("printf 'SONARI_NITRO_RUN_ENCLAVE_ARGS=%q");
        expect(template).toContain("SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID");
        expect(template).not.toContain("SONARI_DEV_MEMBERSHIP_STDIO_BRIDGE");
        expect(template).not.toContain("sonari-enclave-stdio");
        expect(template).not.toContain("Sonari dev fixture World ID proxy placeholder");
        expect(template).toContain("systemctl enable --now sonari-world-id-vsock-proxy.service");
        expect(template).toContain(
            "systemctl is-active --quiet sonari-world-id-vsock-proxy.service",
        );
        expect(template).toContain('echo "SONARI_WORLD_ID_API_BASE=https://developer.world.org"');
        expect(template).not.toContain("SONARI_WORLD_ID_UPSTREAM_API_BASE");
        expect(template).not.toContain(legacyLocalWorldIdBase);
        expect(template).not.toContain(
            'echo "SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE=/opt/sonari/signing-seed.ciphertext"',
        );
        expect(template).not.toContain('echo "SONARI_SIGNING_MATERIAL_KMS_KEY_ID=');
        expect(template).toContain("touch /opt/sonari/bootstrap-complete");
    });
    // STEP 4: VSOCK server request dispatch
    describe("membership runner VSOCK server dispatch", () => {
        it("run-membership-identity-enclave routes stdin action to VSOCK /get_attestation and /process_data endpoints", async () => {
            const template = await readFile(
                new URL(
                    "../../../../../infra/aws/membership-identity-runner/template.yaml",
                    import.meta.url,
                ),
                "utf8",
            );

            // The wrapper script must route get_attestation to /get_attestation and
            // process_data to /process_data via VSOCK-CONNECT (socat/equivalent).
            expect(template).toContain("/get_attestation");
            expect(template).toContain("/process_data");
            expect(template).toContain("VSOCK-CONNECT");
            expect(template).toContain("SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID");
        });

        it("dispatch_get_attestation_command sends action=get_attestation via stdin to the enclave wrapper", async () => {
            const repository = new InMemoryVerificationJobRepository();
            const job = await repository.upsertRequest(validRequest(), baseNowMs);
            await repository.claimNextDue(baseNowMs + 1);
            const ssm = new RecordingSsmClient({ commandId: "cmd-attest-4" });
            const handler = createRunnerControlHandler({
                autoscaling: new RecordingAutoScalingClient(),
                ec2: new RecordingEc2Client(),
                ssm,
                s3: new RecordingS3Client(),
                repository,
                now: () => baseNowMs + 2,
                config: baseConfig(),
            });

            await handler({
                action: "dispatch_get_attestation_command",
                job_id: job.row.job_id,
                attempt: 1,
                instance_id: "i-runner",
            } as never);

            const sentCommand = ssm.sentCommands[0]?.shellCommand ?? "";
            // Must send {"action":"get_attestation"} to the wrapper (stdin)
            expect(sentCommand).toContain('"action":"get_attestation"');
            // one-shot subprocess stdin passthrough (raw requestJson) must not remain
            expect(sentCommand).not.toContain("nitroEnclaveProcessCommand");
        });

        it("dispatch_process_data_command sends action=process_data with registration_metadata via stdin", async () => {
            const repository = new InMemoryVerificationJobRepository();
            const job = await repository.upsertRequest(validRequest(), baseNowMs);
            await repository.claimNextDue(baseNowMs + 1);
            const fakeRegistrationMetadata = {
                verifier_config_key: 2,
                verifier_config_version: 1,
                enclave_instance_public_key: `0x${"cc".repeat(32)}`,
            };
            const ssm = new RecordingSsmClient({ commandId: "cmd-process-4" });
            const handler = createRunnerControlHandler({
                autoscaling: new RecordingAutoScalingClient(),
                ec2: new RecordingEc2Client(),
                ssm,
                s3: new RecordingS3Client(),
                repository,
                now: () => baseNowMs + 2,
                config: baseConfig(),
            });

            await handler({
                action: "dispatch_process_data_command",
                job_id: job.row.job_id,
                attempt: 1,
                instance_id: "i-runner",
                registration_metadata: fakeRegistrationMetadata,
            } as never);

            const sentCommand = ssm.sentCommands[0]?.shellCommand ?? "";
            expect(sentCommand).toContain('"action":"process_data"');
            expect(sentCommand).toContain('"registration_metadata"');
            expect(sentCommand).toContain('"verifier_config_key":2');
            // one-shot subprocess stdin passthrough (raw requestJson) must not remain
            expect(sentCommand).not.toContain("nitroEnclaveProcessCommand");
        });
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

// STEP 7: env namespace separation, dynamic membershipPassId, stop_instance, register adapter wiring
describe("STEP 7: env namespace, stop_instance, register adapter wiring", () => {
    it("stop_instance sets desiredCapacity to 0 (per-job EC2 lifecycle)", async () => {
        const autoscaling = new RecordingAutoScalingClient();
        const handler = createRunnerControlHandler({
            autoscaling,
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        const result = await handler({
            action: "stop_instance",
            job_id: "job-stop-7",
            attempt: 1,
        });

        expect(result).toMatchObject({ capacity: 0 });
        expect(autoscaling.capacities).toContain(0);
    });

    it("IDENTITY_RELAYER_MODE is used (not RELAYER_MODE) to activate submission config", () => {
        const originalEnv = { ...process.env };
        try {
            delete process.env.RELAYER_MODE;
            delete process.env.IDENTITY_RELAYER_MODE;

            // Without any env var: should return undefined
            const noMode = readSuiSubmissionConfigFromEnv(noopSecretReader);
            expect(noMode).toBeUndefined();

            // RELAYER_MODE alone must NOT activate config (namespace separation)
            process.env.RELAYER_MODE = "dry_run";
            const withOldKey = readSuiSubmissionConfigFromEnv(noopSecretReader);
            expect(withOldKey).toBeUndefined();
            delete process.env.RELAYER_MODE;

            // IDENTITY_RELAYER_MODE activates config
            process.env.IDENTITY_RELAYER_MODE = "dry_run";
            const withNewKey = readSuiSubmissionConfigFromEnv(noopSecretReader);
            expect(withNewKey).not.toBeUndefined();
            expect(withNewKey?.mode).toBe("dry_run");
        } finally {
            // restore
            for (const key of Object.keys(process.env)) {
                if (!(key in originalEnv)) delete process.env[key];
            }
            Object.assign(process.env, originalEnv);
        }
    });

    it("SONARI_MEMBERSHIP_PASS_ID is not required for submission config (dynamic membershipPassId)", () => {
        const originalEnv = { ...process.env };
        try {
            process.env.IDENTITY_RELAYER_MODE = "dry_run";
            process.env.SONARI_IDENTITY_PACKAGE_ID = "0xpkg";
            process.env.SONARI_IDENTITY_PAUSE_STATE_ID = "0xpause";
            process.env.SONARI_IDENTITY_REGISTRY_ID = "0xidentity";
            process.env.SONARI_MEMBERSHIP_REGISTRY_ID = "0xmembership";
            process.env.SONARI_VERIFIER_REGISTRY_ID = "0xverifier";
            delete process.env.SONARI_MEMBERSHIP_PASS_ID; // must NOT be required

            const config = readSuiSubmissionConfigFromEnv(noopSecretReader);
            expect(config).not.toBeUndefined();
            // No configurationError from missing SONARI_MEMBERSHIP_PASS_ID
            expect(config?.configurationError).not.toContain("SONARI_MEMBERSHIP_PASS_ID");
        } finally {
            for (const key of Object.keys(process.env)) {
                if (!(key in originalEnv)) delete process.env[key];
            }
            Object.assign(process.env, originalEnv);
        }
    });

    it("readEnclaveRegistrationConfigFromEnv derives target and verifierRegistry from Sui env vars", () => {
        const originalEnv = { ...process.env };
        try {
            process.env.IDENTITY_RELAYER_MODE = "submit";
            process.env.SONARI_IDENTITY_PACKAGE_ID = "0xpkg";
            process.env.SONARI_VERIFIER_REGISTRY_ID = "0xreg";
            process.env.RELAYER_ALLOW_SUBMIT = "true";

            const config = readEnclaveRegistrationConfigFromEnv(noopSecretReader);
            expect(config).not.toBeUndefined();
            expect(config?.target).toContain("register_enclave_instance_for_config");
            expect(config?.target).toContain("0xpkg");
            expect(config?.verifierRegistry).toBe("0xreg");
            expect(config?.allowSubmit).toBe(true);
        } finally {
            for (const key of Object.keys(process.env)) {
                if (!(key in originalEnv)) delete process.env[key];
            }
            Object.assign(process.env, originalEnv);
        }
    });

    it("readEnclaveRegistrationConfigFromEnv returns undefined when IDENTITY_RELAYER_MODE is unset", () => {
        const originalEnv = { ...process.env };
        try {
            delete process.env.IDENTITY_RELAYER_MODE;
            const config = readEnclaveRegistrationConfigFromEnv(noopSecretReader);
            expect(config).toBeUndefined();
        } finally {
            for (const key of Object.keys(process.env)) {
                if (!(key in originalEnv)) delete process.env[key];
            }
            Object.assign(process.env, originalEnv);
        }
    });

    it("readEnclaveRegistrationConfigFromEnv returns undefined for dry_run mode", () => {
        const originalEnv = { ...process.env };
        try {
            process.env.IDENTITY_RELAYER_MODE = "dry_run";
            process.env.SONARI_IDENTITY_PACKAGE_ID = "0xpkg";
            process.env.SONARI_VERIFIER_REGISTRY_ID = "0xreg";

            const config = readEnclaveRegistrationConfigFromEnv(noopSecretReader);
            expect(config).toBeUndefined();
        } finally {
            for (const key of Object.keys(process.env)) {
                if (!(key in originalEnv)) delete process.env[key];
            }
            Object.assign(process.env, originalEnv);
        }
    });

    it("passes Sui dry-run, registration env, and signer secret access to RunnerControlLambda", async () => {
        const template = await readFile(
            new URL(
                "../../../../../infra/aws/membership-identity-runner/template.yaml",
                import.meta.url,
            ),
            "utf8",
        );

        expect(template).toContain("IdentityRelayerMode:");
        expect(template).toContain("SonariIdentityPackageId:");
        expect(template).toContain("SonariIdentityPauseStateId:");
        expect(template).toContain("SonariIdentityRegistryId:");
        expect(template).toContain("SonariMembershipRegistryId:");
        expect(template).toContain("SonariVerifierRegistryId:");
        expect(template).toContain("SonariSuiClockId:");
        expect(template).toContain("RelayerGrpcUrl:");
        expect(template).toContain("RelayerSenderAddress:");
        expect(template).toContain("RelayerAllowSubmit:");
        expect(template).toContain("RelayerSignerSecretArn:");
        expect(template).toContain("IDENTITY_RELAYER_MODE: !Ref IdentityRelayerMode");
        expect(template).toContain("SONARI_IDENTITY_PACKAGE_ID: !Ref SonariIdentityPackageId");
        expect(template).toContain(
            "SONARI_IDENTITY_PAUSE_STATE_ID: !Ref SonariIdentityPauseStateId",
        );
        expect(template).toContain("SONARI_IDENTITY_REGISTRY_ID: !Ref SonariIdentityRegistryId");
        expect(template).toContain(
            "SONARI_MEMBERSHIP_REGISTRY_ID: !Ref SonariMembershipRegistryId",
        );
        expect(template).toContain("SONARI_VERIFIER_REGISTRY_ID: !Ref SonariVerifierRegistryId");
        expect(template).toContain("SONARI_SUI_CLOCK_ID: !Ref SonariSuiClockId");
        expect(template).toContain("RELAYER_NETWORK: !Ref RelayerNetwork");
        expect(template).toContain("RELAYER_GRPC_URL: !Ref RelayerGrpcUrl");
        expect(template).toContain("RELAYER_SENDER_ADDRESS: !Ref RelayerSenderAddress");
        expect(template).toContain("RELAYER_ALLOW_SUBMIT: !Ref RelayerAllowSubmit");
        expect(template).toContain("RELAYER_SIGNER_SECRET_ARN: !Ref RelayerSignerSecretArn");
        expect(template).toContain("secretsmanager:GetSecretValue");
        expect(template).toContain("Resource: !Ref RelayerSignerSecretArn");
    });
});

const noopSecretReader = {
    getSecretString: async (_arn: string) => "",
};

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
            submitFailureMessage?: string;
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
        if (this.options.submitFailureMessage !== undefined) {
            return {
                ok: false as const,
                error_code: "RELAYER_SUBMIT_FAILED" as const,
                message: this.options.submitFailureMessage,
                digest: this.options.submitDigest,
            };
        }
        // STEP 5: digest ベース判定。readback フィールドなし
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
    // STEP 5: membershipPassId フィールド削除、arguments は 8 要素
    return {
        target: "0xabc::accessor::update_identity_verification",
        packageId: "0xabc",
        pauseStateId: "0x111",
        identityRegistryId: "0x222",
        membershipRegistryId: "0x333",
        verifierRegistryId: "0x444",
        clockId: "0x6",
        arguments: [
            "0x111",
            "0x222",
            "0x333",
            "0x444",
            "0x6",
            [1, 2, 3],
            Array.from({ length: 64 }, () => 0x11),
            Array.from({ length: 32 }, () => 0x22),
        ] as [string, string, string, string, string, number[], number[], number[]],
    };
}

function fakeRunnerSuiSubmissionConfig() {
    return {
        mode: "submit" as const,
        packageId: "0xabc",
        pauseStateId: "0x111",
        identityRegistryId: "0x222",
        membershipRegistryId: "0x333",
        verifierRegistryId: "0x444",
        clockId: "0x6",
        network: "testnet" as const,
        grpcUrl: "https://fullnode.testnet.sui.io:443",
        senderAddress: "0xsender",
    };
}

function fakeSuiSubmitContext() {
    return {
        network: "testnet",
        grpc_url: "https://fullnode.testnet.sui.io:443",
        sender_address: "0xsender",
    };
}

function signedPayloadForTest() {
    return {
        status: "verified" as const,
        payload_bcs_hex: "0x010203",
        signature: `0x${"11".repeat(64)}`,
        public_key: `0x${"22".repeat(32)}`,
        membership_id: validRequest().membership_id,
    };
}

function dryRunHandoffRecord(
    overrides: Partial<{
        signed_payload: ReturnType<typeof signedPayloadForTest>;
        request: ReturnType<typeof fakeSuiRequest>;
        transaction_bytes: number[];
        effects: Record<string, unknown>;
        submit_context: ReturnType<typeof fakeSuiSubmitContext>;
    }> = {},
) {
    return {
        signed_payload: signedPayloadForTest(),
        request: fakeSuiRequest(),
        transaction_bytes: [1, 2, 3],
        effects: { digest: "dry-run-digest" },
        ...overrides,
    };
}

// STEP 3: attestation → register → process_data flow
describe("membership runner attestation/register/process_data flow", () => {
    const fakeAttestationHex = `0x${"ab".repeat(100)}`;
    const fakePublicKey = `0x${"cc".repeat(32)}`;
    const fakeRegistrationMetadata = {
        verifier_config_key: 2,
        verifier_config_version: 1,
        enclave_instance_public_key: `0x${"cc".repeat(32)}`,
    };

    it("dispatches get_attestation command and returns attestation result via S3", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const ssm = new RecordingSsmClient({ commandId: "cmd-attest" });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client({
                [`results/${job.row.job_id}/${baseNowMs + 2}.json`]: JSON.stringify({
                    attestation_document_hex: fakeAttestationHex,
                    public_key: fakePublicKey,
                }),
            }),
            repository,
            now: () => baseNowMs + 2,
            config: baseConfig(),
        });

        const dispatched = await handler({
            action: "dispatch_get_attestation_command",
            job_id: job.row.job_id,
            attempt: 1,
            instance_id: "i-runner",
        } as never);
        expect(dispatched).toMatchObject({
            job_id: job.row.job_id,
            instance_id: "i-runner",
            command_id: "cmd-attest",
        });

        const sentCommand = ssm.sentCommands[0]?.shellCommand ?? "";
        expect(sentCommand).toContain('"action":"get_attestation"');

        const attestationResult = await handler({
            action: "read_attestation_result",
            job_id: job.row.job_id,
            attempt: 1,
            result_s3_key: `results/${job.row.job_id}/${baseNowMs + 2}.json`,
        } as never);
        expect(attestationResult).toMatchObject({
            attestation: {
                attestation_document_hex: fakeAttestationHex,
                public_key: fakePublicKey,
            },
        });
    });

    it("register_enclave_instance calls EnclaveRegistrationAdapter with config_key=2 and returns registration_metadata", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const enclaveRegistration = new RecordingEnclaveRegistrationAdapter(
            fakeRegistrationMetadata,
        );
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            enclaveRegistration,
            now: () => baseNowMs + 2,
            config: baseConfig(),
        });

        const result = await handler({
            action: "register_enclave_instance",
            job_id: job.row.job_id,
            attempt: 1,
            attestation: {
                attestation_document_hex: fakeAttestationHex,
                public_key: fakePublicKey,
            },
        } as never);

        expect(result).toMatchObject({
            job_id: job.row.job_id,
            registration_metadata: {
                verifier_config_key: 2,
                verifier_config_version: 1,
                enclave_instance_public_key: fakePublicKey,
            },
        });
        expect(enclaveRegistration.calls).toHaveLength(1);
        expect(enclaveRegistration.calls[0]).toMatchObject({
            attestationDocumentHex: fakeAttestationHex,
            publicKey: fakePublicKey,
        });
    });

    it("register_enclave_instance uses local metadata when enclaveRegistration adapter is not configured", async () => {
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

        const result = await handler({
            action: "register_enclave_instance",
            job_id: job.row.job_id,
            attempt: 1,
            attestation: {
                attestation_document_hex: fakeAttestationHex,
                public_key: fakePublicKey,
            },
        } as never);

        expect(result).toMatchObject({
            job_id: job.row.job_id,
            registration_metadata: {
                verifier_config_key: 2,
                verifier_config_version: 1,
                enclave_instance_public_key: fakePublicKey,
            },
        });
    });

    it("dispatch_process_data_command injects registration_metadata with verifier_config_key=2 into TEE input", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const ssm = new RecordingSsmClient({ commandId: "cmd-process" });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            repository,
            now: () => baseNowMs + 2,
            config: baseConfig(),
        });

        const result = await handler({
            action: "dispatch_process_data_command",
            job_id: job.row.job_id,
            attempt: 1,
            instance_id: "i-runner",
            registration_metadata: fakeRegistrationMetadata,
        } as never);

        expect(result).toMatchObject({
            job_id: job.row.job_id,
            instance_id: "i-runner",
            command_id: "cmd-process",
        });

        const sentCommand = ssm.sentCommands[0]?.shellCommand ?? "";
        expect(sentCommand).toContain('"action":"process_data"');
        expect(sentCommand).toContain('"registration_metadata"');
        expect(sentCommand).toContain('"verifier_config_key":2');
    });

    it("dispatch_process_data_command validates registration_metadata has verifier_config_key=2", async () => {
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
                action: "dispatch_process_data_command",
                job_id: job.row.job_id,
                attempt: 1,
                instance_id: "i-runner",
                registration_metadata: {
                    verifier_config_key: 1, // wrong - should be 2
                    verifier_config_version: 1,
                    enclave_instance_public_key: fakePublicKey,
                },
            } as never),
        ).rejects.toThrow(/enclave registration metadata is malformed/);
    });

    it("full attestation→register→process_data flow returns correct result with verifier_kind preserved", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.claimNextDue(baseNowMs + 1);
        const ssm = new RecordingSsmClient({
            commandId: "cmd-attest",
            invocationStatus: "Success",
        });
        const enclaveRegistration = new RecordingEnclaveRegistrationAdapter(
            fakeRegistrationMetadata,
        );
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client({
                [`results/${job.row.job_id}/${baseNowMs + 2}.json`]: JSON.stringify({
                    attestation_document_hex: fakeAttestationHex,
                    public_key: fakePublicKey,
                }),
            }),
            repository,
            enclaveRegistration,
            now: () => baseNowMs + 2,
            config: baseConfig(),
        });

        // Step 1: dispatch get_attestation
        const dispatchResult = await handler({
            action: "dispatch_get_attestation_command",
            verifier_kind: "membership_identity",
            job_id: job.row.job_id,
            attempt: 1,
            instance_id: "i-runner",
        } as never);
        expect(dispatchResult).toMatchObject({ verifier_kind: "membership_identity" });

        // Step 2: read attestation result
        const attestResult = await handler({
            action: "read_attestation_result",
            verifier_kind: "membership_identity",
            job_id: job.row.job_id,
            attempt: 1,
            result_s3_key: `results/${job.row.job_id}/${baseNowMs + 2}.json`,
        } as never);
        expect(attestResult).toMatchObject({
            verifier_kind: "membership_identity",
            attestation: { public_key: fakePublicKey },
        });

        const attestation =
            "attestation" in attestResult ? attestResult.attestation : neverAttestation();

        // Step 3: register enclave instance
        const registerResult = await handler({
            action: "register_enclave_instance",
            verifier_kind: "membership_identity",
            job_id: job.row.job_id,
            attempt: 1,
            attestation,
        } as never);
        expect(registerResult).toMatchObject({
            verifier_kind: "membership_identity",
            registration_metadata: { verifier_config_key: 2 },
        });

        const registrationMetadata =
            "registration_metadata" in registerResult
                ? registerResult.registration_metadata
                : neverMetadata();

        // Step 4: dispatch process_data with registration_metadata
        const processResult = await handler({
            action: "dispatch_process_data_command",
            verifier_kind: "membership_identity",
            job_id: job.row.job_id,
            attempt: 1,
            instance_id: "i-runner",
            registration_metadata: registrationMetadata,
        } as never);
        expect(processResult).toMatchObject({
            verifier_kind: "membership_identity",
            instance_id: "i-runner",
            command_id: "cmd-attest",
        });

        const processCommand = ssm.sentCommands.find((c) =>
            c.shellCommand.includes('"action":"process_data"'),
        );
        expect(processCommand).toBeDefined();
        expect(processCommand?.shellCommand).toContain('"verifier_config_key":2');
    });
});

class RecordingEnclaveRegistrationAdapter {
    readonly calls: Array<{ jobId: string; attestationDocumentHex: string; publicKey: string }> =
        [];

    constructor(
        private readonly metadata: {
            verifier_config_key: number;
            verifier_config_version: number;
            enclave_instance_public_key: string;
        },
    ) {}

    async register(input: {
        jobId: string;
        attestationDocumentHex: string;
        publicKey: string;
    }): Promise<typeof this.metadata> {
        this.calls.push(input);
        return this.metadata;
    }
}

function neverAttestation(): never {
    throw new Error("expected attestation in result");
}

function neverMetadata(): never {
    throw new Error("expected registration_metadata in result");
}
