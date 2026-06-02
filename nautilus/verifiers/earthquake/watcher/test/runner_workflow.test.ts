import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
    createEd25519SuiSignerFromPrivateKey,
    loadFixtureRelayerSubmitInput,
    type RelayerSubmitConfig,
} from "@sonari/earthquake-relayer";
import {
    BCS_ENUMS,
    type EnclaveVerificationMetadata,
    type RawDataEntry,
    type RawDataManifest,
    type TeeCoreResult,
} from "@sonari/earthquake-shared";
import type { RelayerAdapter, RelayerSuccess } from "../src/relayer_preview.js";
import {
    buildRunnerBootstrapReadinessShellCommand,
    createRunnerControlHandler,
    handler as runnerWorkflowHandler,
    HttpWalrusSourceArchiver,
    type AutoScalingClientLike,
    type EnclaveRegistrationAdapter,
    type EnclaveRegistrationClient,
    IntegritySourceArchiveError,
    SuiEnclaveRegistrationAdapter,
    type Ec2ClientLike,
    readEnclaveRegistrationConfigFromEnv,
    readRelayerConfigFromEnv,
    type RelayerSignerSecretReader,
    RetryableSourceArchiveError,
    type S3ClientLike,
    type SourceArchiveAdapter,
    type SsmClientLike,
} from "../src/runner_workflow.js";
import { InMemoryStateRepository } from "../src/state.js";

const validEd25519SuiPrivateKey =
    "suiprivkey1qzhxm3kgv4atgnt2gwkeefddg8zngmje9tvm86ax0as33qs5tjxzktptcaf";
const earthquakeRelayerTarget = "0x123::accessor::create_disaster_event_from_signed_payload";
const earthquakeRelayerRegistry = "0xregistry";
const earthquakeRelayerVerifierRegistry = "0xverifier";
const earthquakeRelayerClock = "0x6";
const finalizedPayloadBcsHex = "0x01";
const finalizedSignature = `0x${"11".repeat(64)}`;
const finalizedPublicKey = `0x${"22".repeat(32)}`;
const attestationDocumentHex = `0x${"aa".repeat(96)}`;
const registrationMetadata: EnclaveVerificationMetadata = {
    verifier_config_key: 1,
    verifier_config_version: 7,
    enclave_instance_public_key: finalizedPublicKey,
};

describe("AWS runner workflow helper", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("retains earthquake verifier kind across common runner workflow actions", async () => {
        const ssm = new RecordingSsmClient({ invocationStatus: "Success" });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client({
                instances: [{ instanceId: "i-ready", state: "running" }],
            }),
            ssm,
            s3: new RecordingS3Client({
                body: JSON.stringify({
                    status: "pending_source",
                    source_event_id: "us7000sonari",
                    error_code: "SHAKEMAP_PRODUCT_MISSING",
                }),
            }),
            now: () => 1_800_000_000_123,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "start_instance",
                verifier_kind: "earthquake",
                source_event_id: "us7000sonari",
            } as never),
        ).resolves.toMatchObject({ verifier_kind: "earthquake", capacity: 1 });
        await expect(
            handler({
                action: "find_ready_instance",
                verifier_kind: "earthquake",
                source_event_id: "us7000sonari",
            } as never),
        ).resolves.toMatchObject({ verifier_kind: "earthquake", instance_id: "i-ready" });
        await expect(
            handler({
                action: "dispatch_tee_command",
                verifier_kind: "earthquake",
                source_event_id: "us7000sonari",
                instance_id: "i-ready",
            } as never),
        ).resolves.toMatchObject({
            verifier_kind: "earthquake",
            command_id: "cmd-123",
            result_s3_key: "results/us7000sonari/1800000000123.json",
        });
        await expect(
            handler({
                action: "poll_command",
                verifier_kind: "earthquake",
                source_event_id: "us7000sonari",
                instance_id: "i-ready",
                command_id: "cmd-123",
                result_s3_key: "results/us7000sonari/1800000000123.json",
                command_poll_count: 0,
            } as never),
        ).resolves.toMatchObject({ verifier_kind: "earthquake", command_status: "SUCCEEDED" });
        await expect(
            handler({
                action: "read_result",
                verifier_kind: "earthquake",
                source_event_id: "us7000sonari",
                result_s3_key: "results/us7000sonari/1800000000123.json",
            } as never),
        ).resolves.toMatchObject({ verifier_kind: "earthquake" });
    });

    it("fails closed before AWS setup for unknown verifier kind at the workflow boundary", async () => {
        await expect(
            runnerWorkflowHandler({
                action: "start_instance",
                verifier_kind: "membership_identity",
                source_event_id: "us7000sonari",
            } as never),
        ).rejects.toThrow(/verifier_kind/);
    });

    it("scales the runner ASG up and down", async () => {
        const autoscaling = new RecordingAutoScalingClient();
        const handler = createRunnerControlHandler({
            autoscaling,
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        await handler({ action: "start_instance", source_event_id: "us7000sonari" });
        await handler({ action: "stop_instance", source_event_id: "us7000sonari" });

        expect(autoscaling.capacities).toEqual([1, 0]);
    });

    it("fails closed when no running SSM-managed instance is available", async () => {
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client({ instances: [] }),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        await expect(
            handler({ action: "find_ready_instance", source_event_id: "us7000sonari" }),
        ).rejects.toThrow(/No running SSM-managed runner instance/);
    });

    it("requires a running EC2 instance to be online in SSM before it is ready", async () => {
        const offlineHandler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client({
                instances: [{ instanceId: "i-offline", state: "running" }],
            }),
            ssm: new RecordingSsmClient({ onlineManagedInstanceIds: [] }),
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });
        const onlineHandler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client({
                instances: [
                    { instanceId: "i-stopped", state: "stopped" },
                    { instanceId: "i-online", state: "running" },
                ],
            }),
            ssm: new RecordingSsmClient({ onlineManagedInstanceIds: ["i-online"] }),
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        await expect(
            offlineHandler({ action: "find_ready_instance", source_event_id: "us7000sonari" }),
        ).rejects.toThrow(/No running SSM-managed runner instance/);
        await expect(
            onlineHandler({ action: "find_ready_instance", source_event_id: "us7000sonari" }),
        ).resolves.toMatchObject({ instance_id: "i-online" });
    });

    it("requires bootstrap readiness after a runner instance is online in SSM", async () => {
        const ssm = new RecordingSsmClient({
            onlineManagedInstanceIds: ["i-cold", "i-ready"],
            bootstrapReadyInstanceIds: ["i-ready"],
        });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client({
                instances: [
                    { instanceId: "i-cold", state: "running" },
                    { instanceId: "i-ready", state: "running" },
                ],
            }),
            ssm,
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        await expect(
            handler({ action: "find_ready_instance", source_event_id: "us7000sonari" }),
        ).resolves.toMatchObject({ instance_id: "i-ready" });
        expect(ssm.bootstrapReadinessChecks).toEqual(["i-cold", "i-ready"]);
    });

    it("fails closed when SSM is online but bootstrap readiness is incomplete", async () => {
        const ssm = new RecordingSsmClient({
            onlineManagedInstanceIds: ["i-cold"],
            bootstrapReadyInstanceIds: [],
        });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client({
                instances: [{ instanceId: "i-cold", state: "running" }],
            }),
            ssm,
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        await expect(
            handler({ action: "find_ready_instance", source_event_id: "us7000sonari" }),
        ).rejects.toThrow(/No running SSM-managed runner instance is bootstrap-ready/);
        expect(ssm.bootstrapReadinessChecks).toEqual(["i-cold"]);
    });

    it("checks required bootstrap sentinel, env, blob-id CLI, egress proxy, and Nitro allocator", () => {
        const command = buildRunnerBootstrapReadinessShellCommand();

        expect(command).toContain("test -f /opt/sonari/bootstrap-complete");
        expect(command).toContain("test -s /opt/sonari/runner.env");
        expect(command).toContain("source /opt/sonari/runner.env");
        expect(command).not.toContain("SONARI_TEE_SIGNING_KEY_SEED");
        expect(command).not.toContain("SONARI_TEE_SIGNING_KEY_SEED_FILE");
        expect(command).toContain(
            ': "${SONARI_EARTHQUAKE_EGRESS_PROXY_URL:?SONARI_EARTHQUAKE_EGRESS_PROXY_URL is required}"',
        );
        expect(command).toContain(
            ': "${SONARI_WALRUS_N_SHARDS:?SONARI_WALRUS_N_SHARDS is required}"',
        );
        expect(command).toContain("test -x \"$SONARI_WALRUS_CLI\"");
        expect(command).not.toContain("SONARI_WALRUS_CONFIG");
        expect(command).not.toContain("SONARI_WALRUS_WALLET");
        expect(command).not.toContain("SONARI_WALRUS_AGGREGATOR_URL");
        expect(command).not.toContain("SONARI_WALRUS_CONTEXT");
        expect(command).not.toContain("SONARI_WALRUS_EPOCHS");
        expect(command).toContain("systemctl is-active --quiet nitro-enclaves-allocator.service");
    });

    it("keeps AWS template source archive and shard-count wiring ahead of relayer", () => {
        const template = readFileSync(
            new URL("../../../../../infra/aws/sonari-verifier-runner/template.yaml", import.meta.url),
            "utf8",
        );

        expect(template).toContain('echo "SONARI_WALRUS_N_SHARDS=1000"');
        expect(template).toContain("walrus_n_shards: $walrus_n_shards");
        expect(template).toContain("SONARI_EARTHQUAKE_VSOCK_SOCAT_TIMEOUT_SECONDS=180");
        expect(template).toContain(
            'socat -t "$SONARI_EARTHQUAKE_VSOCK_SOCAT_TIMEOUT_SECONDS" - "VSOCK-CONNECT:$SONARI_EARTHQUAKE_ENCLAVE_CID:3000"',
        );
        expect(template.indexOf('"ArchiveSources"')).toBeGreaterThan(
            template.indexOf('"ApplyResult"'),
        );
        expect(template.indexOf('"RelayerPreviewOrDryRun"')).toBeGreaterThan(
            template.indexOf('"ArchiveSources"'),
        );
    });

    it("dispatches SSM command and polls pending/success states", async () => {
        const ssm = new RecordingSsmClient({ invocationStatus: "Success" });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            now: () => 1_800_000_000_123,
            config: baseConfig(),
        });

        const dispatched = await handler({
            action: "dispatch_tee_command",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
        });
        const polled = await handler({
            action: "poll_command",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
            command_id: "cmd-123",
        });

        expect(dispatched).toMatchObject({
            command_id: "cmd-123",
            result_s3_key: "results/us7000sonari/1800000000123.json",
        });
        expect(polled).toMatchObject({ command_status: "SUCCEEDED" });
        expect(ssm.commands[0]).toContain("NITRO_ENCLAVE_PROCESS_COMMAND");
        expect(ssm.commands[0]).not.toContain("SONARI_TEE_SIGNING_KEY_SEED");
        expect(ssm.commands[0]).toContain(
            ': "${SONARI_WALRUS_CLI:?SONARI_WALRUS_CLI is required}"',
        );
        expect(ssm.commands[0]).toContain(
            ': "${SONARI_EARTHQUAKE_EGRESS_PROXY_URL:?SONARI_EARTHQUAKE_EGRESS_PROXY_URL is required}"',
        );
        expect(ssm.commands[0]).toContain(
            "export SONARI_WALRUS_CLI SONARI_WALRUS_N_SHARDS SONARI_EARTHQUAKE_EGRESS_PROXY_URL",
        );
        expect(ssm.commands[0]).toContain(
            ': "${SONARI_WALRUS_N_SHARDS:?SONARI_WALRUS_N_SHARDS is required}"',
        );
        expect(ssm.commands[0]).not.toContain("SONARI_WALRUS_CONFIG");
        expect(ssm.commands[0]).not.toContain("SONARI_WALRUS_WALLET");
        expect(ssm.commands[0]).not.toContain("SONARI_WALRUS_AGGREGATOR_URL");
        expect(ssm.commands[0]).not.toContain("SONARI_WALRUS_CONTEXT");
        expect(ssm.commands[0]).not.toContain("SONARI_WALRUS_EPOCHS");
        expect(ssm.commands[0]).toContain("/tmp/sonari-tee-result-us7000sonari-1800000000123.json");
        expect(ssm.commands[0]).not.toContain("latest.json");
    });

    it("registers attestation before dispatching process_data and passes metadata to the runner", async () => {
        const ssm = new RecordingSsmClient();
        const registrar = new RecordingEnclaveRegistrationAdapter();
        let nowMs = 1_800_000_000_123;
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            enclaveRegistration: registrar,
            now: () => nowMs,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "register_enclave_instance",
                source_event_id: "us7000sonari",
                attempt: 1,
                attestation: {
                    attestation_document_hex: attestationDocumentHex,
                    public_key: finalizedPublicKey,
                },
            } as never),
        ).resolves.toMatchObject({
            registration_metadata: registrationMetadata,
        });

        nowMs += 1;
        await expect(
            handler({
                action: "dispatch_process_data_command",
                source_event_id: "us7000sonari",
                attempt: 1,
                instance_id: "i-123",
                registration_metadata: registrationMetadata,
            } as never),
        ).resolves.toMatchObject({
            command_id: "cmd-123",
            result_s3_key: "results/us7000sonari/1800000000124.json",
        });

        expect(registrar.inputs).toEqual([
            {
                source_event_id: "us7000sonari",
                attestation_document_hex: attestationDocumentHex,
                public_key: finalizedPublicKey,
            },
        ]);
        expect(ssm.commands[0]).toContain('"action":"process_data"');
        expect(ssm.commands[0]).toContain('"registration_metadata"');
        expect(ssm.commands[0]).toContain('"verifier_config_version":7');
    });

    it("fails closed before process_data when registration metadata is missing", async () => {
        const ssm = new RecordingSsmClient();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "dispatch_process_data_command",
                source_event_id: "us7000sonari",
                attempt: 1,
                instance_id: "i-123",
            } as never),
        ).rejects.toThrow(/registration metadata/);
        expect(ssm.commands).toEqual([]);
    });

    it("increments SSM command poll count while the command remains pending", async () => {
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient({ invocationStatus: "InProgress" }),
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        const polled = await handler({
            action: "poll_command",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
            command_id: "cmd-123",
            result_s3_key: "results/us7000sonari/1800000000123.json",
            command_poll_count: 59,
        });

        expect(polled).toMatchObject({
            command_status: "PENDING",
            command_poll_count: 60,
        });
    });

    it("records guarded workflow progress when dispatching and polling SSM commands", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const ssm = new RecordingSsmClient({ invocationStatus: "InProgress" });
        let nowMs = 1_800_000_000_123;
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            repository,
            now: () => nowMs,
            config: baseConfig(),
        });

        await handler({
            action: "dispatch_tee_command",
            source_event_id: "us7000sonari",
            attempt: 1,
            instance_id: "i-123",
        });
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "processing",
            runner_attempt: 1,
            runner_phase: "dispatching_command",
            runner_instance_id: "i-123",
            runner_command_id: "cmd-123",
            runner_result_s3_key: "results/us7000sonari/1800000000123.json",
            updated_at_ms: 1_800_000_000_123,
        });

        nowMs += 30_000;
        const polled = await handler({
            action: "poll_command",
            source_event_id: "us7000sonari",
            attempt: 1,
            instance_id: "i-123",
            command_id: "cmd-123",
            result_s3_key: "results/us7000sonari/1800000000123.json",
        });

        expect(polled).toMatchObject({ command_status: "PENDING" });
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            runner_phase: "polling_command",
            runner_instance_id: "i-123",
            runner_command_id: "cmd-123",
            runner_result_s3_key: "results/us7000sonari/1800000000123.json",
            runner_last_poll_at_ms: 1_800_000_030_123,
            updated_at_ms: 1_800_000_030_123,
        });
    });

    it("requires attempt metadata for repository-guarded workflow actions", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const autoscaling = new RecordingAutoScalingClient();
        const ssm = new RecordingSsmClient();
        const handler = createRunnerControlHandler({
            autoscaling,
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_030_123,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "dispatch_tee_command",
                source_event_id: "us7000sonari",
                instance_id: "i-123",
            }),
        ).rejects.toThrow(/runner workflow attempt is required/);
        await expect(
            handler({
                action: "mark_failed",
                source_event_id: "us7000sonari",
            }),
        ).rejects.toThrow(/runner workflow attempt is required/);
        await expect(
            handler({
                action: "stop_instance",
                source_event_id: "us7000sonari",
            }),
        ).rejects.toThrow(/runner workflow attempt is required/);

        expect(ssm.commands).toEqual([]);
        expect(autoscaling.capacities).toEqual([]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "processing",
            runner_phase: "starting_instance",
        });
    });

    it("treats missing SSM command invocations as pending while command registration propagates", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient({ invocationErrorName: "InvocationDoesNotExist" }),
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_030_123,
            config: baseConfig(),
        });

        const polled = await handler({
            action: "poll_command",
            source_event_id: "us7000sonari",
            attempt: 1,
            instance_id: "i-123",
            command_id: "cmd-123",
            result_s3_key: "results/us7000sonari/1800000000123.json",
        });

        expect(polled).toMatchObject({ command_status: "PENDING" });
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            runner_phase: "polling_command",
            runner_last_poll_at_ms: 1_800_000_030_123,
        });
    });

    it("does not let a superseded workflow attempt dispatch, fail, apply, or stop newer work", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markFailed(
            "us7000sonari",
            "AWS_RUNNER_TIMEOUT",
            1_800_000_000_000,
            1_800_000_000_000,
        );
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-2",
            1_800_000_000_001,
        );
        const autoscaling = new RecordingAutoScalingClient();
        const ssm = new RecordingSsmClient();
        const handler = createRunnerControlHandler({
            autoscaling,
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_030_123,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "dispatch_tee_command",
                source_event_id: "us7000sonari",
                attempt: 1,
                instance_id: "i-123",
            }),
        ).rejects.toThrow(/stale runner workflow attempt/);
        await expect(
            handler({
                action: "apply_result",
                source_event_id: "us7000sonari",
                attempt: 1,
                result: pendingSourceResult("us7000sonari"),
            }),
        ).rejects.toThrow(/stale runner workflow attempt/);
        await expect(
            handler({
                action: "mark_failed",
                source_event_id: "us7000sonari",
                attempt: 1,
            }),
        ).rejects.toThrow(/stale runner workflow attempt/);
        await expect(
            handler({
                action: "stop_instance",
                source_event_id: "us7000sonari",
                attempt: 1,
            }),
        ).rejects.toThrow(/stale runner workflow attempt/);

        expect(ssm.commands).toEqual([]);
        expect(autoscaling.capacities).toEqual([]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "processing",
            retry_count: 1,
            runner_attempt: 2,
            runner_phase: "starting_instance",
        });
    });

    it("does not let a superseded workflow attempt relay finalized results", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markFailed(
            "us7000sonari",
            "AWS_RUNNER_TIMEOUT",
            1_800_000_000_000,
            1_800_000_000_000,
        );
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-2",
            1_800_000_000_001,
        );
        const relayer = new RecordingRelayerAdapter();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            relayer,
            now: () => 1_800_000_030_123,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "relayer_preview_or_dry_run",
                source_event_id: "us7000sonari",
                attempt: 1,
                result: finalizedResult(),
            }),
        ).rejects.toThrow(/stale runner workflow attempt/);

        expect(relayer.inputs).toEqual([]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "processing",
            runner_attempt: 2,
            relayer_status: null,
        });
    });

    it("records explicit runner timeout codes for workflow timeout failures", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_001_800_000,
            config: baseConfig(),
        });

        await handler({
            action: "mark_failed",
            source_event_id: "us7000sonari",
            attempt: 1,
            error_code: "AWS_RUNNER_TIMEOUT",
            message: "SSM command polling exceeded 30 minutes",
        });

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "failed",
            error_code: "AWS_RUNNER_TIMEOUT",
            runner_error_message: "SSM command polling exceeded 30 minutes",
        });
    });

    it("allows the current workflow attempt to stop capacity after applying a terminal result", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        await repository.applyRunnerResult(
            "us7000sonari",
            pendingSourceResult("us7000sonari"),
            1_800_000_030_000,
            1_800_000_060_000,
            1,
        );
        const autoscaling = new RecordingAutoScalingClient();
        const handler = createRunnerControlHandler({
            autoscaling,
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_030_123,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "stop_instance",
                source_event_id: "us7000sonari",
                attempt: 1,
            }),
        ).resolves.toMatchObject({ capacity: 0 });

        expect(autoscaling.capacities).toEqual([0]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "pending_source",
            runner_attempt: 1,
            runner_phase: "complete",
            runner_stopped_at_ms: 1_800_000_030_123,
        });
    });

    it("fails closed before dispatching SSM commands for malformed event IDs", async () => {
        const ssm = new RecordingSsmClient();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "dispatch_tee_command",
                source_event_id: "us7000$(touch bad)",
                instance_id: "i-123",
            }),
        ).rejects.toThrow(/invalid source_event_id/);
        await expect(
            handler({
                action: "dispatch_tee_command",
                source_event_id: "us7000/bad",
                instance_id: "i-123",
            }),
        ).rejects.toThrow(/invalid source_event_id/);
        expect(ssm.commands).toEqual([]);
    });

    it("single-quotes shell interpolations and creates unique result paths per dispatch", async () => {
        const ssm = new RecordingSsmClient();
        let nowMs = 1_800_000_000_123;
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            now: () => nowMs,
            config: {
                ...baseConfig(),
                resultBucket: "sonari-results-$(touch bad)",
                nitroEnclaveProcessCommand: "/opt/sonari/bin/run-enclave 'quoted value'",
            },
        });

        const first = await handler({
            action: "dispatch_tee_command",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
        });
        nowMs += 1;
        const second = await handler({
            action: "dispatch_tee_command",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
        });

        expect(first).toMatchObject({ result_s3_key: "results/us7000sonari/1800000000123.json" });
        expect(second).toMatchObject({ result_s3_key: "results/us7000sonari/1800000000124.json" });
        expect(ssm.commands[0]).toContain(
            "NITRO_ENCLAVE_PROCESS_COMMAND='/opt/sonari/bin/run-enclave '\\''quoted value'\\'''",
        );
        expect(ssm.commands[0]).toContain(
            "| '/opt/sonari/bin/run-enclave' 'quoted value' > '/tmp/sonari-tee-result-us7000sonari-1800000000123.json'",
        );
        expect(ssm.commands[0]).not.toContain('| "$NITRO_ENCLAVE_PROCESS_COMMAND"');
        expect(ssm.commands[0]).toContain(
            "'s3://sonari-results-$(touch bad)/results/us7000sonari/1800000000123.json'",
        );
        expect(ssm.commands[0]).not.toContain("$RESULT_S3_KEY'");
        expect(ssm.commands[0]).toContain("/tmp/sonari-tee-result-us7000sonari-1800000000123.json");
        expect(ssm.commands[1]).toContain("/tmp/sonari-tee-result-us7000sonari-1800000000124.json");
    });

    it("preserves command arguments for direct Node-based TEE commands", async () => {
        const ssm = new RecordingSsmClient();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            now: () => 1_800_000_000_123,
            config: {
                ...baseConfig(),
                nitroEnclaveProcessCommand: "node /opt/sonari/process.js --mode production",
            },
        });

        await handler({
            action: "dispatch_tee_command",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
        });

        expect(ssm.commands[0]).toContain(
            "| 'node' '/opt/sonari/process.js' '--mode' 'production' > '/tmp/sonari-tee-result-us7000sonari-1800000000123.json'",
        );
    });

    it("fails closed before dispatching malformed Nitro command strings", async () => {
        const ssm = new RecordingSsmClient();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3: new RecordingS3Client(),
            config: {
                ...baseConfig(),
                nitroEnclaveProcessCommand: "/opt/sonari/bin/run-enclave 'unterminated",
            },
        });

        await expect(
            handler({
                action: "dispatch_tee_command",
                source_event_id: "us7000sonari",
                instance_id: "i-123",
            }),
        ).rejects.toThrow(/invalid NITRO_ENCLAVE_PROCESS_COMMAND/);
        expect(ssm.commands).toEqual([]);
    });

    it("rejects malformed S3 TEE results", async () => {
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client({ body: JSON.stringify({ status: "finalized" }) }),
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "read_result",
                source_event_id: "us7000sonari",
                result_s3_key: "results/us7000sonari/cmd-123.json",
            }),
        ).rejects.toThrow(/invalid finalized TEE result/);
    });

    it("rejects non-finalized S3 TEE results with invalid status-specific error codes", async () => {
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client({
                body: JSON.stringify({
                    status: "pending_mmi",
                    source_event_id: "us7000sonari",
                    error_code: "RELAYER_SUBMIT_FAILED",
                }),
            }),
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "read_result",
                source_event_id: "us7000sonari",
                result_s3_key: "results/us7000sonari/cmd-123.json",
            }),
        ).rejects.toThrow(/invalid non-finalized TEE result/);
    });

    it("rejects non-finalized S3 TEE results for a different source event", async () => {
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client({
                body: JSON.stringify({
                    status: "pending_source",
                    source_event_id: "us7000other",
                    error_code: "SHAKEMAP_PRODUCT_MISSING",
                }),
            }),
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "read_result",
                source_event_id: "us7000sonari",
                result_s3_key: "results/us7000sonari/cmd-123.json",
            }),
        ).rejects.toThrow(/source_event_id mismatch/);
    });

    it("accepts finalized S3 TEE results with hashed event UIDs", async () => {
        const result = finalizedResult();
        if (result.status !== "finalized") {
            throw new Error("test finalized result helper returned non-finalized result");
        }
        const hashedEventUid = `0x${"aa".repeat(32)}`;
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client({
                body: JSON.stringify({
                    ...result,
                    payload: { ...result.payload, event_uid: hashedEventUid },
                }),
            }),
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "read_result",
                source_event_id: "us7000sonari",
                result_s3_key: "results/us7000sonari/cmd-123.json",
            }),
        ).resolves.toMatchObject({
            source_event_id: "us7000sonari",
            result: {
                status: "finalized",
                payload: { event_uid: hashedEventUid },
            },
        });
    });

    it("applies TEE results to DynamoDB-compatible state and skips relayer when not configured", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_001_000,
            config: baseConfig(),
        });
        const result = pendingSourceResult("us7000sonari");

        await handler({
            action: "apply_result",
            source_event_id: "us7000sonari",
            attempt: 1,
            result,
        });
        const relayer = await handler({
            action: "relayer_preview_or_dry_run",
            source_event_id: "us7000sonari",
            attempt: 1,
            result,
        });

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "pending_source",
            error_code: "SHAKEMAP_PRODUCT_MISSING",
        });
        expect(relayer).toMatchObject({ relayer: "skipped" });
    });

    it("archives finalized source manifest entries before relayer work", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const bytes = new TextEncoder().encode("source bytes");
        const result = finalizedResultWithRawManifest(bytes);
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        const sourceArchive = new RecordingSourceArchiveAdapter(bytes);
        const relayer = new RecordingRelayerAdapter();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            relayer,
            sourceArchive,
            now: () => 1_800_000_002_000,
            config: baseConfig(),
        });

        const archived = await handler({
            action: "archive_sources",
            source_event_id: "us7000sonari",
            attempt: 1,
            result,
        });
        const relayed = await handler({
            action: "relayer_preview_or_dry_run",
            source_event_id: "us7000sonari",
            attempt: 1,
            result,
        });

        expect(archived).toMatchObject({
            source_archive: "success",
            source_artifact_s3_keys: [
                `source-artifacts/us7000sonari/1/0-detail_geojson-${sha256Hex(bytes)}.bin`,
            ],
        });
        expect(sourceArchive.fetches).toEqual([
            "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000sonari.geojson",
        ]);
        expect(sourceArchive.puts).toEqual([
            {
                bucket: "sonari-results",
                key: `source-artifacts/us7000sonari/1/0-detail_geojson-${sha256Hex(bytes)}.bin`,
                bytes,
            },
        ]);
        expect(relayed).toMatchObject({ relayer: "succeeded" });
        expect(relayer.inputs).toEqual([result]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            source_archive_status: "success",
            source_archive_error_code: null,
        });
    });

    it("rejects source manifests that do not match the signed raw data hash", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const bytes = new TextEncoder().encode("source bytes");
        const result = finalizedResultWithRawManifest(bytes);
        result.payload.raw_data_hash = `0x${"99".repeat(32)}`;
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        const sourceArchive = new RecordingSourceArchiveAdapter(bytes);
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            sourceArchive,
            now: () => 1_800_000_002_000,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "archive_sources",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
            }),
        ).resolves.toMatchObject({ source_archive: "integrity_failed" });
        expect(sourceArchive.fetches).toEqual([]);
        expect(sourceArchive.puts).toEqual([]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "rejected",
            source_archive_status: "integrity_failed",
        });
    });

    it("rejects source re-fetch URLs outside the allowed USGS HTTPS scope", async () => {
        const invalidSourceUris = [
            "http://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000sonari.geojson",
            "https://169.254.169.254/latest/meta-data/",
            "https://example.test/earthquakes/feed/v1.0/detail/us7000sonari.geojson",
        ];
        const originalFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            return new Response(new TextEncoder().encode("source bytes"));
        }) as typeof fetch;
        try {
            for (const sourceUri of invalidSourceUris) {
                const repository = new InMemoryStateRepository();
                await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
                await repository.markWorkflowStarted(
                    "us7000sonari",
                    "earthquake-us7000sonari-1",
                    1_800_000_000_001,
                );
                const result = finalizedResultWithRawManifest(
                    new TextEncoder().encode("source bytes"),
                    { sourceUri },
                );
                const s3 = new RecordingS3Client();
                const handler = createRunnerControlHandler({
                    autoscaling: new RecordingAutoScalingClient(),
                    ec2: new RecordingEc2Client(),
                    ssm: new RecordingSsmClient(),
                    s3,
                    repository,
                    now: () => 1_800_000_002_000,
                    config: baseConfig(),
                });

                await expect(
                    handler({
                        action: "archive_sources",
                        source_event_id: "us7000sonari",
                        attempt: 1,
                        result,
                    }),
                ).resolves.toMatchObject({ source_archive: "integrity_failed" });
                expect(s3.puts).toEqual([]);
            }
        } finally {
            globalThis.fetch = originalFetch;
        }
        expect(fetchCalls).toBe(0);
    });

    it("records source archive integrity failures and blocks relayer", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const result = finalizedResultWithRawManifest(new TextEncoder().encode("expected"));
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        const relayer = new RecordingRelayerAdapter();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            relayer,
            sourceArchive: new RecordingSourceArchiveAdapter(new TextEncoder().encode("tampered")),
            now: () => 1_800_000_002_000,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "archive_sources",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
            }),
        ).resolves.toMatchObject({ source_archive: "integrity_failed" });
        await expect(
            handler({
                action: "relayer_preview_or_dry_run",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
            }),
        ).resolves.toMatchObject({ relayer: "skipped" });
        expect(relayer.inputs).toEqual([]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "rejected",
            source_archive_status: "integrity_failed",
            error_code: "SOURCE_ARCHIVE_INTEGRITY_FAILED",
        });
    });

    it("records oversized source re-fetch as source archive integrity failure", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const result = finalizedResultWithRawManifest(new TextEncoder().encode("source bytes"));
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        const archive = new RecordingSourceArchiveAdapter(new TextEncoder().encode("source bytes"));
        archive.oversizeFetch = true;
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            sourceArchive: archive,
            now: () => 1_800_000_002_000,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "archive_sources",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
            }),
        ).resolves.toMatchObject({ source_archive: "integrity_failed" });
        expect(archive.puts).toEqual([]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "rejected",
            source_archive_status: "integrity_failed",
        });
    });

    it("records retryable source archive failures without mutating the TEE result", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const result = finalizedResultWithRawManifest(new TextEncoder().encode("source bytes"));
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        const originalJson = JSON.stringify(result);
        const archive = new RecordingSourceArchiveAdapter(new TextEncoder().encode("source bytes"));
        archive.failS3 = true;
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            sourceArchive: archive,
            now: () => 1_800_000_002_000,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "archive_sources",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
            }),
        ).resolves.toMatchObject({ source_archive: "retryable_failed" });

        expect(JSON.stringify(result)).toBe(originalJson);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "failed",
            source_archive_status: "retryable_failed",
            error_code: "SOURCE_ARCHIVE_RETRYABLE_FAILED",
            payload_bcs_hex: result.payload_bcs_hex,
            signature: result.signature,
        });
    });

    it("sends a runner-only token to the HTTP source archiver", async () => {
        const fetchCalls: Array<{ url: string; headers: Record<string, string>; body: unknown }> =
            [];
        const secretReader = new RecordingRelayerSignerSecretReader("archiver-token");
        const archiver = new HttpWalrusSourceArchiver("https://archiver.test/store", {
            secretArn: "arn:aws:secretsmanager:source-archiver-token",
            secretReader,
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            fetchCalls.push({
                url: String(url),
                headers: normalizeHeaders(init?.headers),
                body: JSON.parse(String(init?.body)) as unknown,
            });
            return new Response(JSON.stringify({ walrus_blob_id: "testBlob_123456" }), {
                status: 200,
            });
        }) as typeof fetch;
        try {
            await expect(
                archiver.archiveAndVerify({
                    entry: firstRawDataEntry(
                        finalizedResultWithRawManifest(new TextEncoder().encode("source bytes")),
                    ),
                    artifactS3Key: "source-artifacts/us7000sonari/1/0-detail.bin",
                }),
            ).resolves.toEqual({ walrusBlobId: "testBlob_123456" });
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(fetchCalls).toEqual([
            {
                url: "https://archiver.test/store",
                headers: {
                    "content-type": "application/json",
                    "x-sonari-source-archiver-token": "archiver-token",
                },
                body: {
                    artifact_s3_key: "source-artifacts/us7000sonari/1/0-detail.bin",
                    expected_walrus_blob_id: "testBlob_123456",
                    source_hash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
                    size_bytes: "source bytes".length,
                },
            },
        ]);
        expect(secretReader.secretReads).toEqual([
            "arn:aws:secretsmanager:source-archiver-token",
        ]);
    });

    it("does not cache the source archiver token across HTTP calls", async () => {
        const secrets = new QueueingSecretReader(["first-token", "second-token"]);
        const archiver = new HttpWalrusSourceArchiver("https://archiver.test/store", {
            secretArn: "arn:aws:secretsmanager:source-archiver-token",
            secretReader: secrets,
        });
        const headers: Record<string, string>[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            headers.push(normalizeHeaders(init?.headers));
            return new Response(JSON.stringify({ walrus_blob_id: "testBlob_123456" }), {
                status: 200,
            });
        }) as typeof fetch;
        try {
            const entry = firstRawDataEntry(
                finalizedResultWithRawManifest(new TextEncoder().encode("source bytes")),
            );
            await archiver.archiveAndVerify({
                entry,
                artifactS3Key: "source-artifacts/us7000sonari/1/0-detail.bin",
            });
            await archiver.archiveAndVerify({
                entry,
                artifactS3Key: "source-artifacts/us7000sonari/1/0-detail.bin",
            });
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(headers.map((value) => value["x-sonari-source-archiver-token"])).toEqual([
            "first-token",
            "second-token",
        ]);
        expect(secrets.secretReads).toEqual([
            "arn:aws:secretsmanager:source-archiver-token",
            "arn:aws:secretsmanager:source-archiver-token",
        ]);
    });

    it("passes an abort signal to source archiver HTTP requests", async () => {
        let observedSignal: AbortSignal | undefined;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            observedSignal = init?.signal ?? undefined;
            return new Response(JSON.stringify({ walrus_blob_id: "testBlob_123456" }), {
                status: 200,
            });
        }) as typeof fetch;
        try {
            await new HttpWalrusSourceArchiver("https://archiver.test/store").archiveAndVerify({
                entry: firstRawDataEntry(
                    finalizedResultWithRawManifest(new TextEncoder().encode("source bytes")),
                ),
                artifactS3Key: "source-artifacts/us7000sonari/1/0-detail.bin",
            });
        } finally {
            globalThis.fetch = originalFetch;
        }
        expect(observedSignal).toBeInstanceOf(AbortSignal);
    });

    it("classifies HTTP archiver integrity and retryable failures by status", async () => {
        const originalFetch = globalThis.fetch;
        const entry = firstRawDataEntry(
            finalizedResultWithRawManifest(new TextEncoder().encode("source bytes")),
        );
        try {
            globalThis.fetch = (async () =>
                new Response("mismatch", { status: 422 })) as typeof fetch;
            await expect(
                new HttpWalrusSourceArchiver("https://archiver.test/store").archiveAndVerify({
                    entry,
                    artifactS3Key: "source-artifacts/us7000sonari/1/0-detail.bin",
                }),
            ).rejects.toBeInstanceOf(IntegritySourceArchiveError);

            globalThis.fetch = (async () =>
                new Response("unavailable", { status: 503 })) as typeof fetch;
            await expect(
                new HttpWalrusSourceArchiver("https://archiver.test/store").archiveAndVerify({
                    entry,
                    artifactS3Key: "source-artifacts/us7000sonari/1/0-detail.bin",
                }),
            ).rejects.toBeInstanceOf(RetryableSourceArchiveError);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("marks dry-run relayer as failed when RELAYER_NETWORK is missing", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const result = loadFixtureRelayerSubmitInput("usgs/finalized_minimal");
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        await repository.markSourceArchiveResult(
            "us7000sonari",
            { status: "success", artifactS3Keys: ["source-artifacts/us7000sonari/1/0.bin"] },
            1_800_000_001_500,
            1,
        );
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_002_000,
            config: {
                ...baseConfig(),
                relayer: {
                    mode: "dry_run",
                    target: earthquakeRelayerTarget,
                    registry: earthquakeRelayerRegistry,
                    verifierRegistry: earthquakeRelayerVerifierRegistry,
                    grpcUrl: "https://fullnode.testnet.sui.io:443",
                    senderAddress: "0xsender",
                    configurationError: "RELAYER_NETWORK is required",
                },
            },
        });

        await expect(
            handler({
                action: "relayer_preview_or_dry_run",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
            }),
        ).resolves.toMatchObject({ relayer: "failed" });
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            relayer_mode: "dry_run",
            relayer_status: "failed",
            relayer_error_code: "RELAYER_SUBMIT_FAILED",
            relayer_error_message: "RELAYER_NETWORK is required",
        });
    });

    it("fails submit relayer before signer access unless RELAYER_ALLOW_SUBMIT is true", async () => {
        const relayer = readRelayerConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );
        expect(relayer).toBeUndefined();

        process.env.RELAYER_MODE = "submit";
        process.env.RELAYER_NETWORK = "testnet";
        process.env.RELAYER_TARGET = earthquakeRelayerTarget;
        process.env.RELAYER_REGISTRY = earthquakeRelayerRegistry;
        process.env.RELAYER_VERIFIER_REGISTRY = earthquakeRelayerVerifierRegistry;
        process.env.RELAYER_GRPC_URL = "https://fullnode.testnet.sui.io:443";
        process.env.RELAYER_ALLOW_SUBMIT = "false";
        process.env.RELAYER_SIGNER_SECRET_ARN = "arn:aws:secretsmanager:relayer-signer";
        const reader = new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey);
        const config = readRelayerConfigFromEnv(reader);

        expect(config).toMatchObject({
            mode: "submit",
            network: "testnet",
            allowSubmit: false,
            grpcUrl: "https://fullnode.testnet.sui.io:443",
        });
        expect(reader.secretReads).toEqual([]);
    });

    it("creates a lazy submit signer loader from RELAYER_SIGNER_SECRET_ARN", async () => {
        process.env.RELAYER_MODE = "submit";
        process.env.RELAYER_NETWORK = "testnet";
        process.env.RELAYER_TARGET = earthquakeRelayerTarget;
        process.env.RELAYER_REGISTRY = earthquakeRelayerRegistry;
        process.env.RELAYER_VERIFIER_REGISTRY = earthquakeRelayerVerifierRegistry;
        process.env.RELAYER_GRPC_URL = "https://fullnode.testnet.sui.io:443";
        process.env.RELAYER_ALLOW_SUBMIT = "true";
        process.env.RELAYER_SIGNER_SECRET_ARN = "arn:aws:secretsmanager:relayer-signer";
        const reader = new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey);
        const config = readRelayerConfigFromEnv(reader);

        expect(config).toMatchObject({
            mode: "submit",
            network: "testnet",
            allowSubmit: true,
        });
        expect(reader.secretReads).toEqual([]);
        await expect(config?.loadSigner?.()).resolves.toMatchObject({
            toSuiAddress: expect.any(Function),
        });
        expect(reader.secretReads).toEqual(["arn:aws:secretsmanager:relayer-signer"]);
    });

    it("derives enclave registration config from relayer submit environment lazily", async () => {
        process.env.RELAYER_NETWORK = "testnet";
        process.env.RELAYER_TARGET = earthquakeRelayerTarget;
        process.env.RELAYER_VERIFIER_REGISTRY = earthquakeRelayerVerifierRegistry;
        process.env.RELAYER_GRPC_URL = "https://fullnode.testnet.sui.io:443";
        process.env.ENCLAVE_REGISTRATION_ALLOW_SUBMIT = "true";
        process.env.ENCLAVE_INSTANCE_TTL_MS = "60000";
        process.env.RELAYER_SIGNER_SECRET_ARN = "arn:aws:secretsmanager:relayer-signer";
        const reader = new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey);
        const config = readEnclaveRegistrationConfigFromEnv(reader);

        expect(config).toMatchObject({
            target: "0x123::metadata_verifier::register_enclave_instance",
            verifierRegistry: earthquakeRelayerVerifierRegistry,
            network: "testnet",
            grpcUrl: "https://fullnode.testnet.sui.io:443",
            allowSubmit: true,
            instanceTtlMs: 60_000,
        });
        expect(config.configurationError).toBeUndefined();
        expect(reader.secretReads).toEqual([]);
        await expect(config.loadSigner?.()).resolves.toMatchObject({
            toSuiAddress: expect.any(Function),
        });
        expect(reader.secretReads).toEqual(["arn:aws:secretsmanager:relayer-signer"]);
    });

    it("registers an attested enclave on Sui and returns contract metadata", async () => {
        const signer = createEd25519SuiSignerFromPrivateKey(validEd25519SuiPrivateKey);
        const client = new RecordingEnclaveRegistrationClient();
        const adapter = new SuiEnclaveRegistrationAdapter({
            target: "0x123::metadata_verifier::register_enclave_instance",
            verifierRegistry: earthquakeRelayerVerifierRegistry,
            network: "testnet",
            grpcUrl: "https://fullnode.testnet.sui.io:443",
            allowSubmit: true,
            signer,
            client,
            instanceTtlMs: 60_000,
            now: () => 1_800_000_000_000,
        });

        await expect(
            adapter.register({
                sourceEventId: "us7000sonari",
                attestationDocumentHex,
                publicKey: finalizedPublicKey,
            }),
        ).resolves.toEqual(registrationMetadata);
        expect(client.requests).toHaveLength(1);
        expect(client.requests[0]?.signer).toBe(signer);
        expect(client.requests[0]?.include).toEqual({ effects: true, events: true });
    });

    it("accepts base64 encoded enclave public keys in Sui registration events", async () => {
        const signer = createEd25519SuiSignerFromPrivateKey(validEd25519SuiPrivateKey);
        const client = new RecordingEnclaveRegistrationClient(
            Buffer.from(Array.from({ length: 32 }, () => 0x22)).toString("base64"),
        );
        const adapter = new SuiEnclaveRegistrationAdapter({
            target: "0x123::metadata_verifier::register_enclave_instance",
            verifierRegistry: earthquakeRelayerVerifierRegistry,
            network: "testnet",
            grpcUrl: "https://fullnode.testnet.sui.io:443",
            allowSubmit: true,
            signer,
            client,
            instanceTtlMs: 60_000,
            now: () => 1_800_000_000_000,
        });

        await expect(
            adapter.register({
                sourceEventId: "us7000sonari",
                attestationDocumentHex,
                publicKey: finalizedPublicKey,
            }),
        ).resolves.toEqual(registrationMetadata);
    });

    it("fails enclave registration before Sui submission when submit is not explicitly allowed", async () => {
        const signer = createEd25519SuiSignerFromPrivateKey(validEd25519SuiPrivateKey);
        const client = new RecordingEnclaveRegistrationClient();
        const adapter = new SuiEnclaveRegistrationAdapter({
            target: "0x123::metadata_verifier::register_enclave_instance",
            verifierRegistry: earthquakeRelayerVerifierRegistry,
            network: "testnet",
            grpcUrl: "https://fullnode.testnet.sui.io:443",
            allowSubmit: false,
            signer,
            client,
            instanceTtlMs: 60_000,
        });

        await expect(
            adapter.register({
                sourceEventId: "us7000sonari",
                attestationDocumentHex,
                publicKey: finalizedPublicKey,
            }),
        ).rejects.toThrow(/ALLOW_SUBMIT/);
        expect(client.requests).toEqual([]);
    });

    it("returns a relayer configuration error instead of throwing when required object IDs are missing", () => {
        process.env.RELAYER_MODE = "dry_run";
        process.env.RELAYER_NETWORK = "testnet";
        process.env.RELAYER_GRPC_URL = "https://fullnode.testnet.sui.io:443";
        process.env.RELAYER_SENDER_ADDRESS = "0xsender";

        const config = readRelayerConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );

        expect(config).toMatchObject({
            mode: "dry_run",
            configurationError:
                "RELAYER_TARGET, RELAYER_REGISTRY, RELAYER_VERIFIER_REGISTRY required for RELAYER_MODE=dry_run",
        });
    });

    it("stores submit digest and object ID while moving the row to submitted", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const result = loadFixtureRelayerSubmitInput("usgs/finalized_minimal");
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        await repository.markSourceArchiveResult(
            "us7000sonari",
            { status: "success", artifactS3Keys: ["source-artifacts/us7000sonari/1/0.bin"] },
            1_800_000_001_500,
            1,
        );
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_002_000,
            config: {
                ...baseConfig(),
                relayer: {
                    mode: "submit",
                    target: earthquakeRelayerTarget,
                    registry: earthquakeRelayerRegistry,
                    verifierRegistry: earthquakeRelayerVerifierRegistry,
                    network: "testnet",
                    grpcUrl: "https://fullnode.testnet.sui.io:443",
                    allowSubmit: true,
                    loadSigner: async () =>
                        createEd25519SuiSignerFromPrivateKey(validEd25519SuiPrivateKey),
                    submitPayload: async (input: unknown, config: RelayerSubmitConfig) => {
                        expect(input).toEqual(result);
                        expect(config.signer?.toSuiAddress()).toBe(
                            "0xec4afbacb79ca9f456ff4ed20a2a63f1c325ed887f8581e066bd9bdf5fed2bd8",
                        );
                        const request = {
                            target: config.target,
                            registry: config.registry,
                            verifierRegistry: config.verifierRegistry,
                            clock: "0x6",
                            verifierConfigKey: result.verifier_config_key,
                            verifierConfigVersion: result.verifier_config_version,
                            enclaveInstancePublicKey: result.enclave_instance_public_key,
                            arguments: [
                                config.registry,
                                config.verifierRegistry,
                                "0x6",
                                [],
                                [],
                                [],
                            ] as [string, string, string, number[], number[], number[]],
                            submitRequest: {
                                target: config.target,
                                registry: config.registry,
                                verifierRegistry: config.verifierRegistry,
                                clock: "0x6",
                                verifierConfigKey: result.verifier_config_key,
                                verifierConfigVersion: result.verifier_config_version,
                                enclaveInstancePublicKey: result.enclave_instance_public_key,
                                arguments: [
                                    config.registry,
                                    config.verifierRegistry,
                                    "0x6",
                                    [],
                                    [],
                                    [],
                                ] as [string, string, string, number[], number[], number[]],
                            },
                        };
                        return {
                            ok: true,
                            value: {
                                request,
                                digest: "tx-digest",
                                objectId: "0xdisaster",
                                effects: {},
                            },
                        };
                    },
                },
            },
        });

        const relayerResult = await handler({
            action: "relayer_preview_or_dry_run",
            source_event_id: "us7000sonari",
            attempt: 1,
            result,
        });
        expect(relayerResult).toMatchObject({
            relayer: "succeeded",
            relayer_success: {
                mode: "submit",
                target: earthquakeRelayerTarget,
                registry: earthquakeRelayerRegistry,
                verifierRegistry: earthquakeRelayerVerifierRegistry,
                digest: "tx-digest",
                objectId: "0xdisaster",
            },
        });
        if (!("relayer" in relayerResult) || relayerResult.relayer !== "succeeded") {
            throw new Error("expected relayer success");
        }
        expect("request" in relayerResult.relayer_success).toBe(false);
        expect(JSON.stringify(relayerResult.relayer_success).length).toBeLessThan(512);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "finalized",
            relayer_status: null,
            relayer_digest: null,
            relayer_object_id: null,
        });

        await expect(
            handler({
                action: "record_relayer_success",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
                relayer_success: relayerResult.relayer_success,
            }),
        ).resolves.toMatchObject({ relayer: "recorded" });
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "submitted",
            relayer_mode: "submit",
            relayer_status: "succeeded",
            relayer_digest: "tx-digest",
            relayer_object_id: "0xdisaster",
            relayer_submitted_at_ms: 1_800_000_002_000,
        });
    });
});

function baseConfig() {
    return {
        autoScalingGroupName: "sonari-runner",
        resultBucket: "sonari-results",
        nitroEnclaveProcessCommand: "/opt/sonari/bin/run-enclave",
    };
}

function pendingSourceResult(sourceEventId: string): TeeCoreResult {
    return {
        status: "pending_source",
        source_event_id: sourceEventId,
        error_code: "SHAKEMAP_PRODUCT_MISSING",
    };
}

function finalizedResult(): Extract<TeeCoreResult, { status: "finalized" }> {
    return {
        status: "finalized",
        payload: {
            intent: BCS_ENUMS.intent.SONARI_EARTHQUAKE_ORACLE,
            oracle_version: 1,
            event_uid: `0x${"aa".repeat(32)}`,
            hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
            status: BCS_ENUMS.onchainStatus.FINALIZED,
            event_revision: 1,
            source_event_id: "us7000sonari",
            title: "M 7.1 - Sonari Fixture Earthquake",
            region: "Sonari Fixture Region",
            occurred_at_ms: 1_800_000_000_000,
            magnitude_x100: 710,
            verified_at_ms: 1_800_000_000_000,
            source_updated_at_ms: 1_800_000_000_000,
            primary_source: BCS_ENUMS.primarySource.USGS,
            severity_band: 2,
            source_set_hash: `0x${"11".repeat(32)}`,
            raw_data_hash: `0x${"22".repeat(32)}`,
            raw_data_uri: "walrus://raw",
            affected_cells_root: `0x${"33".repeat(32)}`,
            affected_cells_uri: "walrus://cells",
            affected_cells_data_hash: `0x${"44".repeat(32)}`,
            affected_cell_count: 1,
            geo_resolution: 7,
            cells_generation_method:
                BCS_ENUMS.cellsGenerationMethod.SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
            cell_metric: BCS_ENUMS.cellMetric.USGS_MMI,
            cell_aggregation: BCS_ENUMS.cellAggregation.GRID_POINT_P90,
            intensity_scale: BCS_ENUMS.intensityScale.MMI_X100,
            freshness_deadline_ms: 1_800_021_600_000,
        },
        payload_bcs_hex: finalizedPayloadBcsHex,
        signature: finalizedSignature,
        public_key: finalizedPublicKey,
        verifier_config_key: 1,
        verifier_config_version: 1,
        enclave_instance_public_key: finalizedPublicKey,
    };
}

function finalizedResultWithRawManifest(
    bytes: Uint8Array,
    options: { sourceUri?: string } = {},
): Extract<TeeCoreResult, { status: "finalized" }> {
    const hash = `0x${sha256Hex(bytes)}`;
    const manifest: RawDataManifest = {
        entries: [
            {
                name: "USGS",
                event_id: "us7000sonari",
                product: "detail_geojson",
                uri: "walrus://blob/testBlob_123456",
                content_hash: hash,
                source_uri:
                    options.sourceUri ??
                    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000sonari.geojson",
                walrus_blob_id: "testBlob_123456",
                source_hash: hash,
                size_bytes: bytes.byteLength,
            },
        ],
        oracle_version: 1,
    };
    const result = finalizedResult();
    return {
        ...result,
        payload: {
            ...result.payload,
            raw_data_hash: rawDataManifestHash(manifest),
        },
        raw_data_manifest: manifest,
    };
}

function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function rawDataManifestHash(manifest: RawDataManifest): string {
    return `0x${createHash("sha256").update(canonicalRawDataManifestJson(manifest)).digest("hex")}`;
}

function canonicalRawDataManifestJson(manifest: RawDataManifest): string {
    return JSON.stringify({
        entries: manifest.entries.map((entry) => ({
            name: entry.name,
            event_id: entry.event_id,
            product: entry.product,
            uri: entry.uri,
            content_hash: entry.content_hash,
            source_uri: entry.source_uri,
            walrus_blob_id: entry.walrus_blob_id,
            source_hash: entry.source_hash,
            size_bytes: entry.size_bytes,
        })),
        oracle_version: manifest.oracle_version,
    });
}

function normalizeHeaders(headers: RequestInit["headers"] | undefined): Record<string, string> {
    if (headers === undefined) {
        return {};
    }
    if (headers instanceof Headers) {
        return Object.fromEntries(headers.entries());
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }
    return Object.fromEntries(
        Object.entries(headers).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    );
}

function firstRawDataEntry(result: Extract<TeeCoreResult, { status: "finalized" }>) {
    const entry = result.raw_data_manifest?.entries[0];
    if (entry === undefined) {
        throw new Error("fixture raw_data_manifest entry missing");
    }
    return entry;
}

class RecordingAutoScalingClient implements AutoScalingClientLike {
    readonly capacities: number[] = [];

    async setDesiredCapacity(input: { desiredCapacity: number }): Promise<void> {
        this.capacities.push(input.desiredCapacity);
    }
}

class RecordingEc2Client implements Ec2ClientLike {
    constructor(
        private readonly options: { instances?: Array<{ instanceId: string; state: string }> } = {},
    ) {}

    async listRunnerInstances(): Promise<Array<{ instanceId: string; state: string }>> {
        return this.options.instances ?? [{ instanceId: "i-123", state: "running" }];
    }
}

class RecordingSsmClient implements SsmClientLike {
    readonly commands: string[] = [];
    readonly bootstrapReadinessChecks: string[] = [];

    constructor(
        private readonly options: {
            invocationStatus?: string;
            onlineManagedInstanceIds?: string[];
            invocationErrorName?: string;
            bootstrapReadyInstanceIds?: string[];
        } = {},
    ) {}

    async listOnlineManagedInstanceIds(input: { instanceIds: string[] }): Promise<Set<string>> {
        const online = new Set(this.options.onlineManagedInstanceIds ?? input.instanceIds);
        return new Set(input.instanceIds.filter((instanceId) => online.has(instanceId)));
    }

    async checkRunnerBootstrapReady(instanceId: string): Promise<boolean> {
        this.bootstrapReadinessChecks.push(instanceId);
        const ready = new Set(this.options.bootstrapReadyInstanceIds ?? [instanceId]);
        return ready.has(instanceId);
    }

    async sendCommand(input: { shellCommand: string }): Promise<{ commandId: string }> {
        this.commands.push(input.shellCommand);
        return { commandId: "cmd-123" };
    }

    async getCommandInvocation(): Promise<{ status: string }> {
        if (this.options.invocationErrorName !== undefined) {
            throw Object.assign(new Error(this.options.invocationErrorName), {
                name: this.options.invocationErrorName,
            });
        }
        return { status: this.options.invocationStatus ?? "InProgress" };
    }
}

class RecordingS3Client implements S3ClientLike {
    readonly puts: Array<{ bucket: string; key: string; bytes: Uint8Array }> = [];

    constructor(private readonly options: { body?: string } = {}) {}

    async getObjectText(): Promise<string> {
        return (
            this.options.body ??
            JSON.stringify({
                status: "pending_source",
                source_event_id: "us7000sonari",
                error_code: "SHAKEMAP_PRODUCT_MISSING",
            })
        );
    }

    async putObjectBytes(input: {
        bucket: string;
        key: string;
        bytes: Uint8Array;
    }): Promise<void> {
        this.puts.push(input);
    }
}

class RecordingSourceArchiveAdapter implements SourceArchiveAdapter {
    readonly fetches: string[] = [];
    readonly puts: Array<{ bucket: string; key: string; bytes: Uint8Array }> = [];
    readonly archived: Array<{ artifactS3Key: string; walrusBlobId: string }> = [];
    failFetch = false;
    failS3 = false;
    oversizeFetch = false;
    walrusBlobId = "testBlob_123456";

    readonly fetcher = {
        fetchBytes: async (entry: RawDataEntry): Promise<Uint8Array> => {
            this.fetches.push(entry.source_uri);
            if (this.failFetch) {
                throw new Error("source fetch unavailable");
            }
            if (this.oversizeFetch) {
                throw new IntegritySourceArchiveError(
                    `source size exceeded signed size for ${entry.source_uri}`,
                );
            }
            return this.bytes;
        },
    };

    readonly s3 = {
        putObjectBytes: async (input: {
            bucket: string;
            key: string;
            bytes: Uint8Array;
        }): Promise<void> => {
            if (this.failS3) {
                throw new Error("S3 put failed");
            }
            this.puts.push(input);
        },
    };

    readonly walrus = {
        archiveAndVerify: async (input: {
            artifactS3Key: string;
        }): Promise<{ walrusBlobId: string }> => {
            this.archived.push({
                artifactS3Key: input.artifactS3Key,
                walrusBlobId: this.walrusBlobId,
            });
            return { walrusBlobId: this.walrusBlobId };
        },
    };

    constructor(private readonly bytes: Uint8Array) {}
}

class RecordingEnclaveRegistrationAdapter implements EnclaveRegistrationAdapter {
    readonly inputs: Array<{
        source_event_id: string;
        attestation_document_hex: string;
        public_key: string;
    }> = [];

    async register(input: {
        sourceEventId: string;
        attestationDocumentHex: string;
        publicKey: string;
    }): Promise<typeof registrationMetadata> {
        this.inputs.push({
            source_event_id: input.sourceEventId,
            attestation_document_hex: input.attestationDocumentHex,
            public_key: input.publicKey,
        });
        return registrationMetadata;
    }
}

class RecordingEnclaveRegistrationClient implements EnclaveRegistrationClient {
    readonly requests: Array<{
        transaction: unknown;
        signer: unknown;
        include: { effects: true; events: true };
    }> = [];

    constructor(
        private readonly eventPublicKey: unknown = Array.from({ length: 32 }, () => 0x22),
    ) {}

    async signAndExecuteTransaction(input: {
        transaction: unknown;
        signer: unknown;
        include: { effects: true; events: true };
    }) {
        this.requests.push(input);
        return {
            $kind: "Transaction" as const,
            Transaction: {
                status: { success: true, error: null },
                effects: {},
                events: [
                    {
                        type: "0x123::metadata_verifier::EnclaveInstanceRegistered",
                        json: {
                            verifier_family: 3,
                            verifier_version: "1",
                            config_version: String(registrationMetadata.verifier_config_version),
                            public_key: this.eventPublicKey,
                        },
                    },
                ],
            },
        };
    }
}

class RecordingRelayerSignerSecretReader implements RelayerSignerSecretReader {
    readonly secretReads: string[] = [];

    constructor(private readonly secret: string) {}

    async getSecretString(secretArn: string): Promise<string> {
        this.secretReads.push(secretArn);
        return this.secret;
    }
}

class QueueingSecretReader implements RelayerSignerSecretReader {
    readonly secretReads: string[] = [];

    constructor(private readonly secrets: string[]) {}

    async getSecretString(secretArn: string): Promise<string> {
        this.secretReads.push(secretArn);
        const secret = this.secrets.shift();
        if (secret === undefined) {
            throw new Error("secret queue is empty");
        }
        return secret;
    }
}

class RecordingRelayerAdapter implements RelayerAdapter {
    readonly mode = "preview" as const;
    readonly inputs: TeeCoreResult[] = [];

    async relay(input: TeeCoreResult): Promise<{ ok: true; value: RelayerSuccess }> {
        this.inputs.push(input);
        return {
            ok: true,
            value: {
                mode: this.mode,
                request: {
                    target: earthquakeRelayerTarget,
                    registry: earthquakeRelayerRegistry,
                    verifierRegistry: earthquakeRelayerVerifierRegistry,
                    clock: earthquakeRelayerClock,
                    arguments: [
                        earthquakeRelayerRegistry,
                        earthquakeRelayerVerifierRegistry,
                        earthquakeRelayerClock,
                        [],
                        [],
                        [],
                    ],
                    submitRequest: {
                        target: earthquakeRelayerTarget,
                        registry: earthquakeRelayerRegistry,
                        verifierRegistry: earthquakeRelayerVerifierRegistry,
                        clock: earthquakeRelayerClock,
                        arguments: [
                            earthquakeRelayerRegistry,
                            earthquakeRelayerVerifierRegistry,
                            earthquakeRelayerClock,
                            [],
                            [],
                            [],
                        ],
                    },
                },
            },
        };
    }
}
