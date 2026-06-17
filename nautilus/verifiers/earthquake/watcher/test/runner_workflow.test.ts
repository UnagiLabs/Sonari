import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
    createEd25519SuiSignerFromPrivateKey,
    type RelayerSubmitConfig,
} from "@sonari/earthquake-relayer";
import {
    BCS_ENUMS,
    type EnclaveVerificationMetadata,
    type EarthquakeOraclePayload,
    type EvidenceManifest,
    type RawDataEntry,
    type RawDataManifest,
    type TeeCoreResult,
    computeAffectedCellsRootHex,
    encodeEarthquakeOraclePayloadBcsHex,
} from "@sonari/earthquake-shared";
import { FAILED_RETRY_BACKOFF_MS } from "../src/constants.js";
import type { RelayerAdapter, RelayerErrorCode, RelayerSuccess } from "../src/relayer_preview.js";
import {
    GraphqlFloorCensusReader,
    JsonRpcFloorCensusReader,
    type FloorCensusOnchainReader,
} from "../src/census.js";
import {
    buildRunnerBootstrapReadinessShellCommand,
    createRunnerControlHandler,
    handler as runnerWorkflowHandler,
    HttpWalrusSourceArchiver,
    type AutoScalingClientLike,
    ConfigurationSourceArchiveError,
    type EnclaveRegistrationAdapter,
    type EnclaveRegistrationClient,
    type EnclaveRegistryReader,
    IntegritySourceArchiveError,
    SuiEnclaveRegistrationAdapter,
    type Ec2ClientLike,
    readEnclaveRegistrationConfigFromEnv,
    readFloorCensusConfigFromEnv,
    readRelayerConfigFromEnv,
    type RelayerSignerSecretReader,
    RetryableSourceArchiveError,
    type S3ClientLike,
    type AffectedCellsProofRegistrarAdapter,
    type RunnerFloorCensusAdapter,
    type SourceArchiveAdapter,
    type SsmClientLike,
} from "../src/runner_workflow.js";
import { InMemoryStateRepository } from "../src/state.js";

const validEd25519SuiPrivateKey =
    "suiprivkey1qzhxm3kgv4atgnt2gwkeefddg8zngmje9tvm86ax0as33qs5tjxzktptcaf";
const earthquakeRelayerTarget = "0x123::accessor::create_disaster_event_and_campaign_from_signed_payload";
const earthquakeRelayerRegistry = "0xregistry";
const earthquakeRelayerVerifierRegistry = "0xverifier";
const earthquakeRelayerCategoryRegistry = "0xcategoryregistry";
const earthquakeRelayerCategoryPool = "0xcategorypool";
const earthquakeRelayerClock = "0x6";
const finalizedSignature = `0x${"11".repeat(64)}`;
const finalizedPublicKey = `0x${"22".repeat(32)}`;
const attestationDocumentHex = `0x${"aa".repeat(96)}`;
const registrationMetadata: EnclaveVerificationMetadata = {
    verifier_config_key: 1,
    verifier_config_version: 7,
    enclave_instance_public_key: finalizedPublicKey,
};
const censusRegistrationMetadata: EnclaveVerificationMetadata = {
    verifier_config_key: 3,
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
        const earthquakeStateMachine = template.slice(
            template.indexOf("EarthquakeRunnerStateMachine:"),
            template.indexOf("MembershipRunnerStateMachine:"),
        );

        expect(template).toContain('echo "SONARI_WALRUS_N_SHARDS=1000"');
        expect(template).toContain("walrus_n_shards:\\$walrus_n_shards");
        expect(template).toContain("cat >/opt/sonari/bin/run-http-enclave");
        expect(template).toContain('socat -t "$T" - "VSOCK-CONNECT:$C:7777"');
        expect(template).toContain('socat -t "${!T:-180}" - "VSOCK-CONNECT:$C:3000"');
        expect(template.indexOf('"ArchiveSources"')).toBeGreaterThan(
            template.indexOf('"ApplyResult"'),
        );
        expect(template.indexOf('"RelayerPreviewOrDryRun"')).toBeGreaterThan(
            template.indexOf('"ArchiveSources"'),
        );
        expect(earthquakeStateMachine).toContain('"action": "apply_result"');
        expect(earthquakeStateMachine).toContain('"action": "archive_sources"');
        expect(earthquakeStateMachine).toContain('"action": "relayer_preview_or_dry_run"');
        expect(earthquakeStateMachine).toContain('"action": "record_relayer_success"');
        expect(earthquakeStateMachine).toContain('"result_s3_key.$": "$.result_s3_key"');
        for (const action of [
            "poll_command",
            "read_health_check_result",
            "read_attestation_result",
            "register_enclave_instance",
            "read_result",
            "apply_result",
            "archive_sources",
            "register_affected_cells_proof",
            "relayer_preview_or_dry_run",
            "record_relayer_success",
            "run_floor_census",
            "mark_failed",
            "stop_instance",
        ]) {
            const actionIndex = earthquakeStateMachine.indexOf(`"action": "${action}"`);
            expect(actionIndex, `missing action ${action}`).toBeGreaterThanOrEqual(0);
            const nextActionIndex = earthquakeStateMachine.indexOf('"action":', actionIndex + 1);
            const actionBlock = earthquakeStateMachine.slice(
                actionIndex,
                nextActionIndex === -1 ? undefined : nextActionIndex,
            );
            expect(actionBlock, `${action} must preserve event_revision`).toContain(
                '"event_revision.$": "$.event_revision"',
            );
        }
        expect(earthquakeStateMachine).not.toContain('"result.$": "$.result"');
        expect(earthquakeStateMachine).toContain('"instance_id.$": "$.instance_id"');
        expect(template).toContain("RunnerControlLambda:");
        expect(template).toContain("Handler: dist/src/runner_workflow.handler");
        expect(template).toContain("Timeout: 900");
        expect(template).toContain("SourceArchiverLambda:");
        expect(template).toContain("Handler: dist/src/source_archiver.sourceArchiverHandler");
        expect(template).toContain("Timeout: 240");
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
            } as never),
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
            } as never),
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
        const result = pendingSourceResult("us7000sonari");
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
            result_s3_key: "results/us7000sonari/cmd-123.json",
            result_status: "finalized",
        });
    });

    it("keeps full TEE result bodies out of workflow task results", async () => {
        const result = finalizedResultWithRawManifest(new TextEncoder().encode("source bytes"), {
            eventRevision: 2,
        });
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client({ body: JSON.stringify(result) }),
            config: baseConfig(),
        });

        const read = await handler({
            action: "read_result",
            source_event_id: "us7000sonari",
            instance_id: "i-123",
            result_s3_key: "results/us7000sonari/cmd-123.json",
        });

        expect(read).toMatchObject({
            source_event_id: "us7000sonari",
            instance_id: "i-123",
            result_s3_key: "results/us7000sonari/cmd-123.json",
            result_status: "finalized",
        });
        expect("result" in read).toBe(false);
        expect(JSON.stringify(read).length).toBeLessThan(512);
    });

    it("applies TEE results from S3 to DynamoDB-compatible state and skips relayer when not configured", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const result = pendingSourceResult("us7000sonari");
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client({ body: JSON.stringify(result) }),
            repository,
            now: () => 1_800_000_001_000,
            config: baseConfig(),
        });

        const applied = await handler({
            action: "apply_result",
            source_event_id: "us7000sonari",
            attempt: 1,
            instance_id: "i-123",
            result_s3_key: "results/us7000sonari/cmd-123.json",
        });
        const relayer = await handler({
            action: "relayer_preview_or_dry_run",
            source_event_id: "us7000sonari",
            attempt: 1,
            result_s3_key: "results/us7000sonari/cmd-123.json",
        });

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "pending_source",
            error_code: "SHAKEMAP_PRODUCT_MISSING",
        });
        expect(applied).toMatchObject({ instance_id: "i-123" });
        expect(relayer).toMatchObject({ relayer: "skipped" });
    });

    it("stores only a compact finalized result summary in DynamoDB state", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const baseResult = finalizedResultWithRawManifest(new TextEncoder().encode("source bytes"));
        const result = {
            ...baseResult,
            affected_cells: {
                ...baseResult.affected_cells,
                affected_cells: Array.from({ length: 20_000 }, (_, index) => ({
                    h3_index: String(6_088_190_135_139_041_27n + BigInt(index)),
                    intensity_value: 831,
                    cell_band: 2,
                })),
            },
        };
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client({ body: JSON.stringify(result) }),
            repository,
            now: () => 1_800_000_001_000,
            config: baseConfig(),
        });

        await handler({
            action: "apply_result",
            source_event_id: "us7000sonari",
            attempt: 1,
            result_s3_key: "results/us7000sonari/cmd-123.json",
        });

        const row = await repository.get("us7000sonari");
        expect(row?.tee_result_json).not.toContain("affected_cells");
        expect(row?.tee_result_json?.length).toBeLessThan(2_000);
        expect(JSON.parse(row?.tee_result_json ?? "{}")).toMatchObject({
            status: "finalized",
            payload: {
                evidence_manifest_uri: "walrus://blob/manifestBlob_123456",
                evidence_manifest_hash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
            },
            payload_bcs_hex: expect.any(String),
            signature: finalizedSignature,
            public_key: finalizedPublicKey,
        });
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
            instance_id: "i-123",
            result,
        } as never);
        const relayed = await handler({
            action: "relayer_preview_or_dry_run",
            source_event_id: "us7000sonari",
            attempt: 1,
            result,
        } as never);

        expect(archived).toMatchObject({
            instance_id: "i-123",
            source_archive: "success",
            source_artifact_s3_keys: [
                `source-artifacts/us7000sonari/1/0-detail_geojson-${sha256Hex(bytes)}.bin`,
                "source-artifacts/us7000sonari/1/affected_cells.json",
                "source-artifacts/us7000sonari/1/evidence_manifest.json",
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
            {
                bucket: "sonari-results",
                key: "source-artifacts/us7000sonari/1/affected_cells.json",
                bytes: jsonBytes(result.affected_cells),
            },
            {
                bucket: "sonari-results",
                key: "source-artifacts/us7000sonari/1/evidence_manifest.json",
                bytes: jsonBytes(result.evidence_manifest),
            },
        ]);
        expect(sourceArchive.archived).toEqual([
            {
                artifactS3Key: `source-artifacts/us7000sonari/1/0-detail_geojson-${sha256Hex(bytes)}.bin`,
                walrusBlobId: "rawBlob_123456",
            },
            {
                artifactS3Key: "source-artifacts/us7000sonari/1/affected_cells.json",
                walrusBlobId: "cellsBlob_123456",
            },
            {
                artifactS3Key: "source-artifacts/us7000sonari/1/evidence_manifest.json",
                walrusBlobId: "manifestBlob_123456",
            },
        ]);
        expect(relayed).toMatchObject({ relayer: "succeeded" });
        expect(relayer.inputs).toEqual([result]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            source_archive_status: "success",
            source_archive_error_code: null,
        });
    });

    it("rejects evidence manifests that do not match the signed manifest hash", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const bytes = new TextEncoder().encode("source bytes");
        const result = finalizedResultWithRawManifest(bytes);
        result.payload.evidence_manifest_hash = `0x${"99".repeat(32)}`;
        result.payload_bcs_hex = encodeEarthquakeOraclePayloadBcsHex(
            result.payload as EarthquakeOraclePayload,
        );
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
            } as never),
        ).resolves.toMatchObject({ source_archive: "integrity_failed" });
        expect(sourceArchive.fetches).toEqual([]);
        expect(sourceArchive.puts).toEqual([]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "rejected",
            source_archive_status: "integrity_failed",
        });
    });

    it("rejects evidence manifests whose source list does not match archived raw entries", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const bytes = new TextEncoder().encode("source bytes");
        const result = finalizedResultWithRawManifest(bytes);
        if (
            result.evidence_manifest === undefined ||
            result.evidence_manifest_ref === undefined
        ) {
            throw new Error("fixture expected evidence manifest metadata");
        }
        const source = result.evidence_manifest.sources[0];
        if (source === undefined) {
            throw new Error("fixture expected evidence manifest source");
        }
        const evidenceManifest: EvidenceManifest = {
            ...result.evidence_manifest,
            sources: [
                {
                    ...source,
                    artifact_uri: "walrus://blob/otherRawBlob_123456",
                },
            ],
        };
        const evidenceManifestBytes = jsonBytes(evidenceManifest);
        const evidenceManifestHash = `0x${sha256Hex(evidenceManifestBytes)}`;
        const payload: EarthquakeOraclePayload = {
            ...(result.payload as EarthquakeOraclePayload),
            evidence_manifest_hash: evidenceManifestHash,
        };
        const tamperedResult: Extract<TeeCoreResult, { status: "finalized" }> = {
            ...result,
            payload,
            payload_bcs_hex: encodeEarthquakeOraclePayloadBcsHex(payload),
            evidence_manifest: evidenceManifest,
            evidence_manifest_ref: {
                ...result.evidence_manifest_ref,
                source_hash: evidenceManifestHash,
                size_bytes: evidenceManifestBytes.byteLength,
            },
        };
        await repository.applyRunnerResult(
            "us7000sonari",
            tamperedResult,
            1_800_000_001_000,
            undefined,
            1,
        );
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
                result: tamperedResult,
            } as never),
        ).resolves.toMatchObject({ source_archive: "integrity_failed" });
        expect(sourceArchive.fetches).toEqual([]);
        expect(sourceArchive.puts).toEqual([]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "rejected",
            source_archive_status: "integrity_failed",
        });
    });

    it("rejects affected-cells artifacts whose leaves do not match the signed root", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const bytes = new TextEncoder().encode("source bytes");
        const result = finalizedResultWithRawManifest(bytes);
        if (
            result.affected_cells === undefined ||
            result.affected_cells_ref === undefined ||
            result.evidence_manifest === undefined ||
            result.evidence_manifest_ref === undefined
        ) {
            throw new Error("fixture expected generated artifact metadata");
        }
        const affectedCell = result.affected_cells.affected_cells[0];
        if (affectedCell === undefined) {
            throw new Error("fixture expected affected cell leaf");
        }
        const affectedCells = {
            ...result.affected_cells,
            affected_cells: [
                {
                    ...affectedCell,
                    cell_band: 1,
                },
            ],
        };
        const affectedCellsBytes = jsonBytes(affectedCells);
        const affectedCellsHash = `0x${sha256Hex(affectedCellsBytes)}`;
        const evidenceManifest: EvidenceManifest = {
            ...result.evidence_manifest,
            affected_cells: {
                ...result.evidence_manifest.affected_cells,
                hash: affectedCellsHash,
            },
        };
        const evidenceManifestBytes = jsonBytes(evidenceManifest);
        const evidenceManifestHash = `0x${sha256Hex(evidenceManifestBytes)}`;
        const payload: EarthquakeOraclePayload = {
            ...(result.payload as EarthquakeOraclePayload),
            evidence_manifest_hash: evidenceManifestHash,
        };
        const tamperedResult: Extract<TeeCoreResult, { status: "finalized" }> = {
            ...result,
            payload,
            payload_bcs_hex: encodeEarthquakeOraclePayloadBcsHex(payload),
            affected_cells: affectedCells,
            affected_cells_ref: {
                ...result.affected_cells_ref,
                source_hash: affectedCellsHash,
                size_bytes: affectedCellsBytes.byteLength,
            },
            evidence_manifest: evidenceManifest,
            evidence_manifest_ref: {
                ...result.evidence_manifest_ref,
                source_hash: evidenceManifestHash,
                size_bytes: evidenceManifestBytes.byteLength,
            },
        };
        await repository.applyRunnerResult(
            "us7000sonari",
            tamperedResult,
            1_800_000_001_000,
            undefined,
            1,
        );
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
                result: tamperedResult,
            } as never),
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
                    } as never),
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
            } as never),
        ).resolves.toMatchObject({ source_archive: "integrity_failed" });
        await expect(
            handler({
                action: "relayer_preview_or_dry_run",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
            } as never),
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
            } as never),
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
            } as never),
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

    it("records source archiver configuration failures without scheduling a retry", async () => {
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
        archive.failWalrusConfiguration = true;
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
            } as never),
        ).resolves.toMatchObject({ source_archive: "configuration_failed" });

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "rejected",
            source_archive_status: "configuration_failed",
            error_code: "SOURCE_ARCHIVE_CONFIGURATION_FAILED",
            next_retry_at_ms: null,
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
            return new Response(JSON.stringify({ walrus_blob_id: "rawBlob_123456" }), {
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
            ).resolves.toEqual({ walrusBlobId: "rawBlob_123456" });
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
                    expected_walrus_blob_id: "rawBlob_123456",
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
            return new Response(JSON.stringify({ walrus_blob_id: "rawBlob_123456" }), {
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
            return new Response(JSON.stringify({ walrus_blob_id: "rawBlob_123456" }), {
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

            globalThis.fetch = (async () =>
                new Response(JSON.stringify({ error: "configuration" }), {
                    status: 500,
                    headers: { "content-type": "application/json" },
                })) as typeof fetch;
            await expect(
                new HttpWalrusSourceArchiver("https://archiver.test/store").archiveAndVerify({
                    entry,
                    artifactS3Key: "source-artifacts/us7000sonari/1/0-detail.bin",
                }),
            ).rejects.toBeInstanceOf(ConfigurationSourceArchiveError);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("registers affected cells proof metadata after source archive success", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const result = finalizedResultWithRawManifest(new TextEncoder().encode("source bytes"));
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        await repository.markSourceArchiveResult(
            "us7000sonari",
            { status: "success", artifactS3Keys: ["source-artifacts/us7000sonari/2/affected_cells.json"] },
            1_800_000_001_500,
            1,
        );
        const registrar = new RecordingAffectedCellsProofRegistrar();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            affectedCellsProofRegistrar: registrar,
            now: () => 1_800_000_002_000,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "register_affected_cells_proof",
                source_event_id: "us7000sonari",
                attempt: 1,
                instance_id: "i-proof",
                result,
            } as never),
        ).resolves.toMatchObject({
            affected_cells_proof_registration: "success",
            instance_id: "i-proof",
        });

        expect(registrar.inputs).toEqual([
            {
                event_uid: (result.payload as EarthquakeOraclePayload).event_uid,
                event_revision: (result.payload as EarthquakeOraclePayload).event_revision,
                affected_cells_uri: "walrus://blob/cellsBlob_123456",
                affected_cells_hash: result.affected_cells_ref?.source_hash,
                affected_cells_root: (result.payload as EarthquakeOraclePayload).affected_cells_root,
                affected_cell_count: (result.payload as EarthquakeOraclePayload).affected_cell_count,
                geo_resolution: 7,
            },
        ]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "finalized",
            source_archive_status: "success",
            affected_cells_proof_registration_status: "success",
            affected_cells_proof_registration_error_code: null,
            affected_cells_proof_registration_next_retry_at_ms: null,
        });
    });

    it("keeps relayer work independent from retryable affected proof registration failures", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const result = finalizedResultWithRawManifest(new TextEncoder().encode("source bytes"));
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        await repository.markSourceArchiveResult(
            "us7000sonari",
            { status: "success", artifactS3Keys: ["source-artifacts/us7000sonari/1/affected_cells.json"] },
            1_800_000_001_500,
            1,
        );
        const relayer = new RecordingRelayerAdapter();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            relayer,
            affectedCellsProofRegistrar: new FailingAffectedCellsProofRegistrar(),
            now: () => 1_800_000_002_000,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "register_affected_cells_proof",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
            } as never),
        ).resolves.toMatchObject({ affected_cells_proof_registration: "retryable_failed" });
        await expect(
            handler({
                action: "relayer_preview_or_dry_run",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
            } as never),
        ).resolves.toMatchObject({ relayer: "succeeded" });

        expect(relayer.inputs).toEqual([result]);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "finalized",
            source_archive_status: "success",
            affected_cells_proof_registration_status: "retryable_failed",
            affected_cells_proof_registration_error_code:
                "AFFECTED_CELLS_PROOF_REGISTRATION_RETRYABLE_FAILED",
            affected_cells_proof_registration_next_retry_at_ms:
                1_800_000_002_000 + FAILED_RETRY_BACKOFF_MS,
            relayer_status: null,
        });
    });

    it("restores affected proof registration retry state after retry-only task failures", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const result = finalizedResultWithRawManifest(new TextEncoder().encode("source bytes"));
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        await repository.markSourceArchiveResult(
            "us7000sonari",
            {
                status: "success",
                artifactS3Keys: ["source-artifacts/us7000sonari/1/affected_cells.json"],
            },
            1_800_000_001_500,
            1,
        );
        await repository.markAffectedCellsProofRegistrationResult(
            "us7000sonari",
            {
                status: "retryable_failed",
                errorCode: "AFFECTED_CELLS_PROOF_REGISTRATION_RETRYABLE_FAILED",
                retryableNextRetryAtMs: 1_800_000_001_600,
                message: "worker unavailable",
            },
            1_800_000_001_500,
            1,
        );
        await repository.claimAffectedCellsProofRegistrationRetry(
            "us7000sonari",
            1_800_000_001_600,
            1_800_000_002_000,
        );
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            now: () => 1_800_000_003_000,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "restore_affected_cells_proof_registration_retry",
                source_event_id: "us7000sonari",
                attempt: 1,
                message: "States task failed",
            } as never),
        ).resolves.toMatchObject({
            affected_cells_proof_registration: "retry_restored",
        });

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            affected_cells_proof_registration_status: "retryable_failed",
            affected_cells_proof_registration_error_code:
                "AFFECTED_CELLS_PROOF_REGISTRATION_RETRYABLE_FAILED",
            affected_cells_proof_registration_next_retry_at_ms:
                1_800_000_003_000 + FAILED_RETRY_BACKOFF_MS,
            affected_cells_proof_registration_error_message: "States task failed",
        });
    });

    it("marks dry-run relayer as failed when RELAYER_NETWORK is missing", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
        );
        const result = finalizedResultWithRawManifest(new TextEncoder().encode("source bytes"));
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
                    categoryRegistry: earthquakeRelayerCategoryRegistry,
                    categoryPool: earthquakeRelayerCategoryPool,
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
            } as never),
        ).resolves.toMatchObject({ relayer: "failed" });
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            relayer_mode: "dry_run",
            relayer_status: "failed",
            relayer_error_code: "RELAYER_SUBMIT_FAILED",
            relayer_error_message: "RELAYER_NETWORK is required",
        });
    });

    it("marks duplicate or stale Move relayer rejections terminal", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
            0,
            1,
        );
        const result = finalizedResultWithRawManifest(new TextEncoder().encode("source bytes"));
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        await repository.markSourceArchiveResult(
            "us7000sonari",
            { status: "success", artifactS3Keys: ["source-artifacts/us7000sonari/1/0.bin"] },
            1_800_000_001_500,
            1,
        );
        const relayer = new FailingRelayerAdapter(
            "MOVE_REJECTED",
            "MoveAbort EDuplicateDisasterEvent while creating disaster event",
        );
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            relayer,
            now: () => 1_800_000_002_000,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "relayer_preview_or_dry_run",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
            } as never),
        ).resolves.toMatchObject({ relayer: "failed" });

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "rejected",
            next_retry_at_ms: null,
            error_code: "MOVE_REJECTED",
            planned_event_revision: 1,
            relayer_mode: "preview",
            relayer_status: "failed",
            relayer_error_code: "MOVE_REJECTED",
            relayer_error_message: "MoveAbort EDuplicateDisasterEvent while creating disaster event",
        });
        await expect(repository.listDue(1_800_000_003_000, 10)).resolves.toEqual([]);
    });

    it("keeps generic Move relayer rejections on the current path", async () => {
        const repository = new InMemoryStateRepository();
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000);
        await repository.markWorkflowStarted(
            "us7000sonari",
            "earthquake-us7000sonari-1",
            1_800_000_000_001,
            0,
            1,
        );
        const result = finalizedResultWithRawManifest(new TextEncoder().encode("source bytes"));
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_001_000, undefined, 1);
        await repository.markSourceArchiveResult(
            "us7000sonari",
            { status: "success", artifactS3Keys: ["source-artifacts/us7000sonari/1/0.bin"] },
            1_800_000_001_500,
            1,
        );
        const relayer = new FailingRelayerAdapter("MOVE_REJECTED", "MoveAbort EVerifierPaused");
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            relayer,
            now: () => 1_800_000_002_000,
            config: baseConfig(),
        });

        await expect(
            handler({
                action: "relayer_preview_or_dry_run",
                source_event_id: "us7000sonari",
                attempt: 1,
                result,
            } as never),
        ).resolves.toMatchObject({ relayer: "failed" });

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "finalized",
            error_code: null,
            planned_event_revision: 1,
            relayer_status: "failed",
            relayer_error_code: "MOVE_REJECTED",
            relayer_error_message: "MoveAbort EVerifierPaused",
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
        process.env.RELAYER_CATEGORY_REGISTRY = earthquakeRelayerCategoryRegistry;
        process.env.RELAYER_CATEGORY_POOL = earthquakeRelayerCategoryPool;
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
        process.env.RELAYER_CATEGORY_REGISTRY = earthquakeRelayerCategoryRegistry;
        process.env.RELAYER_CATEGORY_POOL = earthquakeRelayerCategoryPool;
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

    it("uses FLOOR_CENSUS_GRAPHQL_URL before other floor census endpoint sources", () => {
        setRequiredFloorCensusEnv();
        process.env.FLOOR_CENSUS_GRAPHQL_URL = "https://floor.example/graphql";
        process.env.SONARI_SUI_GRAPHQL_URL = "https://sonari.example/graphql";
        process.env.FLOOR_CENSUS_JSON_RPC_URL = "https://fullnode.example:443";

        const config = readFloorCensusConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );

        expect(config?.reader).toBeInstanceOf(GraphqlFloorCensusReader);
        expect(readReaderEndpoint(config?.reader)).toBe("https://floor.example/graphql");
    });

    it("falls back to SONARI_SUI_GRAPHQL_URL for floor census GraphQL reads", () => {
        setRequiredFloorCensusEnv();
        process.env.SONARI_SUI_GRAPHQL_URL = "https://sonari.example/graphql";

        const config = readFloorCensusConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );

        expect(config?.reader).toBeInstanceOf(GraphqlFloorCensusReader);
        expect(readReaderEndpoint(config?.reader)).toBe("https://sonari.example/graphql");
    });

    it("falls back to the RELAYER_NETWORK default GraphQL endpoint for floor census reads", () => {
        setRequiredFloorCensusEnv();
        process.env.RELAYER_NETWORK = "testnet";

        const config = readFloorCensusConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );

        expect(config?.reader).toBeInstanceOf(GraphqlFloorCensusReader);
        expect(readReaderEndpoint(config?.reader)).toBe("https://graphql.testnet.sui.io/graphql");
    });

    it("does not use FLOOR_CENSUS_JSON_RPC_URL for the production floor census reader", () => {
        setRequiredFloorCensusEnv();
        process.env.FLOOR_CENSUS_JSON_RPC_URL = "https://fullnode.example:443";

        const config = readFloorCensusConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );

        expect(config?.reader).toBeInstanceOf(GraphqlFloorCensusReader);
        expect(config?.reader).not.toBeInstanceOf(JsonRpcFloorCensusReader);
        expect(readReaderEndpoint(config?.reader)).toBe("https://graphql.testnet.sui.io/graphql");
    });

    it("creates a GraphQL floor census reader for production config", () => {
        setRequiredFloorCensusEnv();

        const config = readFloorCensusConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );

        expect(config?.reader).toBeInstanceOf(GraphqlFloorCensusReader);
        expect(config?.trustedValidatorCommitteeDigest).toBe(
            "11111111111111111111111111111111",
        );
    });

    it("requires a trusted validator committee digest for floor census submit mode", () => {
        setRequiredFloorCensusEnv();
        delete process.env.SONARI_CENSUS_TRUSTED_VALIDATOR_COMMITTEE_DIGEST;

        const config = readFloorCensusConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );

        expect(config?.configurationError).toContain(
            "SONARI_CENSUS_TRUSTED_VALIDATOR_COMMITTEE_DIGEST required for FLOOR_CENSUS_MODE=submit",
        );
    });

    it("requires an EventStreamHead object id for floor census submit mode", () => {
        setRequiredFloorCensusEnv();
        delete process.env.SONARI_EVENT_STREAM_HEAD_OBJECT_ID;

        const config = readFloorCensusConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );

        expect(config?.configurationError).toContain(
            "SONARI_EVENT_STREAM_HEAD_OBJECT_ID required for FLOOR_CENSUS_MODE=submit",
        );
    });

    it("wires an authenticated event proof collector when the EventStreamHead is configured", () => {
        setRequiredFloorCensusEnv();

        const config = readFloorCensusConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );

        expect(config?.configurationError).toBeUndefined();
        const options = readReaderOptions(config?.reader);
        expect(options?.authenticatedEventProofCollector).toBeDefined();
        expect(options?.eventStreamHeadObjectId).toBe(`0x${"ee".repeat(32)}`);
    });

    it("threads an optional authenticated events start checkpoint into the reader", () => {
        setRequiredFloorCensusEnv();
        process.env.SONARI_AUTHENTICATED_EVENTS_START_CHECKPOINT = "1234";

        const config = readFloorCensusConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );

        expect(config?.configurationError).toBeUndefined();
        expect(readReaderOptions(config?.reader)?.authenticatedEventsStartCheckpoint).toBe(1234);
    });

    it("fails closed on a malformed authenticated events start checkpoint", () => {
        setRequiredFloorCensusEnv();
        process.env.SONARI_AUTHENTICATED_EVENTS_START_CHECKPOINT = "not-a-number";

        const config = readFloorCensusConfigFromEnv(
            new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey),
        );

        expect(config?.configurationError).toContain(
            "SONARI_AUTHENTICATED_EVENTS_START_CHECKPOINT must be a non-negative integer",
        );
    });

    it("derives enclave registration config from relayer submit environment lazily", async () => {
        process.env.RELAYER_NETWORK = "testnet";
        process.env.RELAYER_TARGET = earthquakeRelayerTarget;
        process.env.RELAYER_VERIFIER_REGISTRY = earthquakeRelayerVerifierRegistry;
        process.env.RELAYER_CATEGORY_REGISTRY = earthquakeRelayerCategoryRegistry;
        process.env.RELAYER_CATEGORY_POOL = earthquakeRelayerCategoryPool;
        process.env.RELAYER_GRPC_URL = "https://fullnode.testnet.sui.io:443";
        process.env.ENCLAVE_REGISTRATION_ALLOW_SUBMIT = "true";
        process.env.ENCLAVE_INSTANCE_TTL_MS = "60000";
        process.env.RELAYER_SIGNER_SECRET_ARN = "arn:aws:secretsmanager:relayer-signer";
        const reader = new RecordingRelayerSignerSecretReader(validEd25519SuiPrivateKey);
        const config = readEnclaveRegistrationConfigFromEnv(reader);
        const censusConfig = readEnclaveRegistrationConfigFromEnv(reader, {
            configKey: 3,
            expectedFamily: 5,
        });

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
        expect(censusConfig.target).toBe(
            "0x123::metadata_verifier::register_enclave_instance_for_config",
        );
        expect(censusConfig).toMatchObject({ configKey: 3, expectedFamily: 5 });
    });

    it("registers an attested enclave on Sui and returns contract metadata", async () => {
        const signer = createEd25519SuiSignerFromPrivateKey(validEd25519SuiPrivateKey);
        const client = new RecordingEnclaveRegistrationClient();
        const adapter = new SuiEnclaveRegistrationAdapter({
            target: `0x${"12".repeat(32)}::metadata_verifier::register_enclave_instance`,
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

    it("uses config-specific enclave registration target when registering census enclaves", async () => {
        const signer = createEd25519SuiSignerFromPrivateKey(validEd25519SuiPrivateKey);
        const client = new RecordingEnclaveRegistrationClient(
            Array.from({ length: 32 }, () => 0x22),
            5,
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
            configKey: 3,
            expectedFamily: 5,
            now: () => 1_800_000_000_000,
        });

        await expect(
            adapter.register({
                sourceEventId: "us7000sonari",
                attestationDocumentHex,
                publicKey: finalizedPublicKey,
            }),
        ).resolves.toMatchObject({
            verifier_config_key: 3,
            verifier_config_version: registrationMetadata.verifier_config_version,
        });
        expect(client.requests[0]?.transaction).toBeDefined();
    });

    it("reuses verified metadata when enclave registration reports an existing instance", async () => {
        const signer = createEd25519SuiSignerFromPrivateKey(validEd25519SuiPrivateKey);
        const client = new FailingEnclaveRegistrationClient(
            "Transaction resolution failed: MoveAbort in 2nd command, abort code: 16, in '0x123::metadata_verifier::register_enclave_instance_internal'",
        );
        const registryReader = new RecordingEnclaveRegistryReader(censusRegistrationMetadata);
        const adapter = new SuiEnclaveRegistrationAdapter({
            target: "0x123::metadata_verifier::register_enclave_instance",
            verifierRegistry: earthquakeRelayerVerifierRegistry,
            network: "testnet",
            grpcUrl: "https://fullnode.testnet.sui.io:443",
            allowSubmit: true,
            signer,
            client,
            instanceTtlMs: 60_000,
            configKey: 3,
            expectedFamily: 5,
            registryReader,
            now: () => 1_800_000_000_000,
        });

        await expect(
            adapter.register({
                sourceEventId: "us7000sonari",
                attestationDocumentHex,
                publicKey: finalizedPublicKey,
            }),
        ).resolves.toEqual(censusRegistrationMetadata);
        expect(registryReader.inputs).toEqual([
            {
                verifierRegistry: earthquakeRelayerVerifierRegistry,
                publicKey: finalizedPublicKey,
                expectedFamily: 5,
                expectedVersion: 1,
                configKey: 3,
                nowMs: 1_800_000_000_000,
            },
        ]);
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
                "RELAYER_TARGET, RELAYER_REGISTRY, RELAYER_VERIFIER_REGISTRY, RELAYER_CATEGORY_REGISTRY, RELAYER_CATEGORY_POOL required for RELAYER_MODE=dry_run",
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
        const result = finalizedResultWithRawManifest(new TextEncoder().encode("source bytes"));
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
                    categoryRegistry: earthquakeRelayerCategoryRegistry,
                    categoryPool: earthquakeRelayerCategoryPool,
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
                            categoryRegistry: config.categoryRegistry,
                            categoryPool: config.categoryPool,
                            clock: "0x6",
                            verifierConfigKey: 1,
                            verifierConfigVersion: 1,
                            enclaveInstancePublicKey: finalizedPublicKey,
                            arguments: [
                                config.registry,
                                config.verifierRegistry,
                                config.categoryRegistry,
                                config.categoryPool,
                                "0x6",
                                [],
                                [],
                                [],
                            ] as [
                                string,
                                string,
                                string,
                                string,
                                string,
                                number[],
                                number[],
                                number[],
                            ],
                            submitRequest: {
                                target: config.target,
                                registry: config.registry,
                                verifierRegistry: config.verifierRegistry,
                                categoryRegistry: config.categoryRegistry,
                                categoryPool: config.categoryPool,
                                clock: "0x6",
                                verifierConfigKey: 1,
                                verifierConfigVersion: 1,
                                enclaveInstancePublicKey: finalizedPublicKey,
                                arguments: [
                                    config.registry,
                                    config.verifierRegistry,
                                    config.categoryRegistry,
                                    config.categoryPool,
                                    "0x6",
                                    [],
                                    [],
                                    [],
                                ] as [
                                    string,
                                    string,
                                    string,
                                    string,
                                    string,
                                    number[],
                                    number[],
                                    number[],
                                ],
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
            instance_id: "i-123",
            result,
        } as never);
        expect(relayerResult).toMatchObject({
            relayer: "succeeded",
            instance_id: "i-123",
            relayer_success: {
                mode: "submit",
                target: earthquakeRelayerTarget,
                registry: earthquakeRelayerRegistry,
                verifierRegistry: earthquakeRelayerVerifierRegistry,
                categoryRegistry: earthquakeRelayerCategoryRegistry,
                categoryPool: earthquakeRelayerCategoryPool,
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
                instance_id: "i-123",
                result,
                relayer_success: relayerResult.relayer_success,
            } as never),
        ).resolves.toMatchObject({
            relayer: "recorded",
            instance_id: "i-123",
            relayer_success: relayerResult.relayer_success,
        });
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            status: "submitted",
            relayer_mode: "submit",
            relayer_status: "succeeded",
            relayer_digest: "tx-digest",
            relayer_object_id: "0xdisaster",
            relayer_submitted_at_ms: 1_800_000_002_000,
        });
    });

    it("runs floor census once after recorded relayer success", async () => {
        const repository = new InMemoryStateRepository();
        const result = finalizedResultWithRawManifest(jsonBytes({ fixture: "floor-census" }), {
            eventRevision: 2,
        });
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000, {
            requestedSourceEventId: "us7000sonari",
        });
        await repository.markWorkflowStarted("us7000sonari", "exec", 1_800_000_001_000);
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_002_000, undefined, 1);
        await repository.markRelayerSucceeded(
            "us7000sonari",
            ({
                mode: "submit",
                request: {
                    target: earthquakeRelayerTarget,
                    registry: earthquakeRelayerRegistry,
                    verifierRegistry: earthquakeRelayerVerifierRegistry,
                    categoryRegistry: earthquakeRelayerCategoryRegistry,
                    categoryPool: earthquakeRelayerCategoryPool,
                    clock: earthquakeRelayerClock,
                    verifierConfigKey: 1,
                    verifierConfigVersion: 1,
                    enclaveInstancePublicKey: finalizedPublicKey,
                    arguments: [
                        earthquakeRelayerRegistry,
                        earthquakeRelayerVerifierRegistry,
                        earthquakeRelayerCategoryRegistry,
                        earthquakeRelayerCategoryPool,
                        earthquakeRelayerClock,
                        [],
                        [],
                        [],
                    ],
                    submitRequest: {
                        target: earthquakeRelayerTarget,
                        registry: earthquakeRelayerRegistry,
                        verifierRegistry: earthquakeRelayerVerifierRegistry,
                        categoryRegistry: earthquakeRelayerCategoryRegistry,
                        categoryPool: earthquakeRelayerCategoryPool,
                        clock: earthquakeRelayerClock,
                        verifierConfigKey: 1,
                        verifierConfigVersion: 1,
                        enclaveInstancePublicKey: finalizedPublicKey,
                        arguments: [
                            earthquakeRelayerRegistry,
                            earthquakeRelayerVerifierRegistry,
                            earthquakeRelayerCategoryRegistry,
                            earthquakeRelayerCategoryPool,
                            earthquakeRelayerClock,
                            [],
                            [],
                            [],
                        ],
                    },
                },
                digest: "tx-digest",
                objectId: "0xdisaster",
            } as RelayerSuccess),
            1_800_000_003_000,
            1,
        );
        const floorCensus = new RecordingFloorCensusAdapter();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client(),
            repository,
            floorCensus,
            now: () => 1_800_000_004_000,
            config: baseConfig(),
        });
        const event = {
            action: "run_floor_census",
            source_event_id: "us7000sonari",
            attempt: 1,
            result_s3_key: "results/us7000sonari/finalized.json",
            result,
            relayer_success: {
                mode: "submit",
                target: earthquakeRelayerTarget,
                registry: earthquakeRelayerRegistry,
                verifierRegistry: earthquakeRelayerVerifierRegistry,
                categoryRegistry: earthquakeRelayerCategoryRegistry,
                categoryPool: earthquakeRelayerCategoryPool,
                digest: "tx-digest",
                objectId: "0xdisaster",
            },
        } as const;

        await expect(handler(event as never)).resolves.toMatchObject({
            floor_census: "succeeded",
        });
        await expect(handler(event as never)).resolves.toMatchObject({
            floor_census: "skipped",
        });
        expect(floorCensus.inputs).toHaveLength(1);
        expect(floorCensus.inputs[0]).toMatchObject({
            result: { payload: { event_revision: 2 } },
        });
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            floor_census_status: "succeeded",
            floor_census_digest: "census-digest",
            floor_census_counts_json: JSON.stringify(["1", "2", "3"]),
        });
    });

    it("runs configured floor census through Census TEE before submitting", async () => {
        const repository = new InMemoryStateRepository();
        const result = finalizedResultWithRawManifest(jsonBytes({ fixture: "floor-census" }));
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000, {
            requestedSourceEventId: "us7000sonari",
        });
        await repository.markWorkflowStarted("us7000sonari", "exec", 1_800_000_001_000);
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_002_000, undefined, 1);
        const ssm = new RecordingSsmClient({ invocationStatus: "Success" });
        const s3 = new RecordingS3Client({
            bodies: [
                JSON.stringify(result),
                JSON.stringify({
                    attestation_document_hex: attestationDocumentHex,
                    public_key: finalizedPublicKey,
                }),
                JSON.stringify({
                    payload: { registered_members_by_band: ["1", "2", "3"] },
                    payload_bcs_hex: `0x${"aa".repeat(32)}`,
                    signature: `0x${"11".repeat(64)}`,
                    public_key: finalizedPublicKey,
                }),
            ],
        });
        const registrar = new RecordingEnclaveRegistrationAdapter(censusRegistrationMetadata);
        const client = new RecordingFloorCensusSubmitClient();
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm,
            s3,
            repository,
            enclaveRegistration: registrar,
            now: () => 1_800_000_004_000,
            config: {
                ...baseConfig(),
                censusNitroEnclaveProcessCommand: "/opt/sonari/bin/run-census-enclave",
                floorCensus: {
                    target: "0x123::accessor::set_floor_census",
                    pauseState: "0xpause",
                    verifierRegistry: earthquakeRelayerVerifierRegistry,
                    categoryPool: earthquakeRelayerCategoryPool,
                    mainPool: "0xmainpool",
                    membershipRegistry: `0x${"77".repeat(32)}`,
                    signer: createEd25519SuiSignerFromPrivateKey(validEd25519SuiPrivateKey),
                    reader: new RecordingFloorCensusReader(),
                    client,
                    now: () => 1_800_000_004_100,
                },
            },
        });

        await expect(
            handler({
                action: "run_floor_census",
                source_event_id: "us7000sonari",
                attempt: 1,
                instance_id: "i-123",
                result_s3_key: "results/us7000sonari/finalized.json",
                relayer_success: {
                    mode: "submit",
                    target: earthquakeRelayerTarget,
                    registry: earthquakeRelayerRegistry,
                    verifierRegistry: earthquakeRelayerVerifierRegistry,
                    categoryRegistry: earthquakeRelayerCategoryRegistry,
                    categoryPool: earthquakeRelayerCategoryPool,
                    digest: "tx-digest",
                    objectId: `0x${"55".repeat(32)}`,
                },
            } as never),
        ).resolves.toMatchObject({ floor_census: "succeeded" });

        expect(ssm.commands).toHaveLength(2);
        expect(ssm.commands[0]).toContain(
            "aws s3 cp 's3://sonari-results/source-artifacts/us7000sonari/census-tee-inputs/1800000004000.json' - |",
        );
        expect(ssm.commands[0]).toContain(
            ': "${SCT:?SCT is required}"',
        );
        expect(ssm.commands[0]).toContain(
            'SONARI_CENSUS_TRUSTED_VALIDATOR_COMMITTEE_DIGEST="$SCT"',
        );
        expect(ssm.commands[0]).toContain(
            "export SONARI_CENSUS_EIF_PATH SONARI_CENSUS_NITRO_RUN_ENCLAVE_ARGS SONARI_CENSUS_ENCLAVE_CID SONARI_CENSUS_TRUSTED_VALIDATOR_COMMITTEE_DIGEST NITRO_ENCLAVE_PROCESS_COMMAND",
        );
        expect(ssm.commands[0]).toContain("export SONARI_VERIFIER_KIND=census");
        expect(ssm.commands[1]).toContain(
            "aws s3 cp 's3://sonari-results/source-artifacts/us7000sonari/census-tee-inputs/1800000004001.json' - |",
        );
        expect(ssm.commands[1]).not.toContain('"action":"process_data"');
        expect(s3.puts).toHaveLength(2);
        expect(s3.puts[0]).toMatchObject({
            bucket: "sonari-results",
            key: "source-artifacts/us7000sonari/census-tee-inputs/1800000004000.json",
        });
        expect(JSON.parse(Buffer.from(s3.puts[0]?.bytes ?? []).toString("utf8"))).toEqual({
            action: "get_attestation",
        });
        expect(s3.puts[1]).toMatchObject({
            bucket: "sonari-results",
            key: "source-artifacts/us7000sonari/census-tee-inputs/1800000004001.json",
        });
        expect(JSON.parse(Buffer.from(s3.puts[1]?.bytes ?? []).toString("utf8"))).toMatchObject({
            action: "process_data",
            registration_metadata: { verifier_config_key: 3 },
        });
        expect(registrar.inputs).toEqual([
            {
                source_event_id: "us7000sonari",
                attestation_document_hex: attestationDocumentHex,
                public_key: finalizedPublicKey,
            },
        ]);
        expect(client.requests).toHaveLength(1);
        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            floor_census_status: "succeeded",
            floor_census_digest: "census-submit-digest",
            floor_census_counts_json: JSON.stringify(["1", "2", "3"]),
        });
    });

    it("marks configured floor census failed when Census TEE cannot be prepared", async () => {
        const repository = new InMemoryStateRepository();
        const result = finalizedResultWithRawManifest(jsonBytes({ fixture: "floor-census" }));
        await repository.upsertManualEvent("us7000sonari", 1_800_000_000_000, {
            requestedSourceEventId: "us7000sonari",
        });
        await repository.markWorkflowStarted("us7000sonari", "exec", 1_800_000_001_000);
        await repository.applyRunnerResult("us7000sonari", result, 1_800_000_002_000, undefined, 1);
        const handler = createRunnerControlHandler({
            autoscaling: new RecordingAutoScalingClient(),
            ec2: new RecordingEc2Client(),
            ssm: new RecordingSsmClient(),
            s3: new RecordingS3Client({ body: JSON.stringify(result) }),
            repository,
            now: () => 1_800_000_004_000,
            config: {
                ...baseConfig(),
                censusNitroEnclaveProcessCommand: "/opt/sonari/bin/run-census-enclave",
                floorCensus: {
                    target: "0x123::accessor::set_floor_census",
                    pauseState: "0xpause",
                    verifierRegistry: earthquakeRelayerVerifierRegistry,
                    categoryPool: earthquakeRelayerCategoryPool,
                    mainPool: "0xmainpool",
                    membershipRegistry: `0x${"77".repeat(32)}`,
                },
            },
        });

        await expect(
            handler({
                action: "run_floor_census",
                source_event_id: "us7000sonari",
                attempt: 1,
                result_s3_key: "results/us7000sonari/finalized.json",
                relayer_success: {
                    mode: "submit",
                    target: earthquakeRelayerTarget,
                    registry: earthquakeRelayerRegistry,
                    verifierRegistry: earthquakeRelayerVerifierRegistry,
                    categoryRegistry: earthquakeRelayerCategoryRegistry,
                    categoryPool: earthquakeRelayerCategoryPool,
                    digest: "tx-digest",
                    objectId: `0x${"55".repeat(32)}`,
                },
            } as never),
        ).rejects.toThrow("floor census requires a runner instance_id");

        await expect(repository.get("us7000sonari")).resolves.toMatchObject({
            floor_census_status: "failed",
            floor_census_error_message: "floor census requires a runner instance_id",
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
    const payload: EarthquakeOraclePayload = {
        intent: BCS_ENUMS.intent.SONARI_EARTHQUAKE_ORACLE,
        oracle_version: 1,
        event_uid: `0x${"aa".repeat(32)}`,
        event_revision: 1,
        source_event_id: "us7000sonari",
        title: "M 7.1 - Sonari Fixture Earthquake",
        region: "Sonari Fixture Region",
        occurred_at_ms: 1_800_000_000_000,
        hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
        status: BCS_ENUMS.onchainStatus.FINALIZED,
        severity_band: 2,
        affected_cells_root: `0x${"33".repeat(32)}`,
        affected_cell_count: 1,
        evidence_manifest_uri: "walrus://blob/manifestBlob_123456",
        evidence_manifest_hash: `0x${"55".repeat(32)}`,
        verified_at_ms: 1_800_000_000_000,
        freshness_deadline_ms: 1_800_021_600_000,
    };
    return {
        status: "finalized",
        payload,
        payload_bcs_hex: encodeEarthquakeOraclePayloadBcsHex(payload),
        signature: finalizedSignature,
        public_key: finalizedPublicKey,
        verifier_config_key: 1,
        verifier_config_version: 1,
        enclave_instance_public_key: finalizedPublicKey,
    };
}

function finalizedResultWithRawManifest(
    bytes: Uint8Array,
    options: { sourceUri?: string; eventRevision?: number } = {},
): Extract<TeeCoreResult, { status: "finalized" }> {
    const eventRevision = options.eventRevision ?? 1;
    const hash = `0x${sha256Hex(bytes)}`;
    const manifest: RawDataManifest = {
        entries: [
            {
                name: "USGS",
                event_id: "us7000sonari",
                product: "detail_geojson",
                uri: "walrus://blob/rawBlob_123456",
                content_hash: hash,
                source_uri:
                    options.sourceUri ??
                    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000sonari.geojson",
                walrus_blob_id: "rawBlob_123456",
                source_hash: hash,
                size_bytes: bytes.byteLength,
            },
        ],
        oracle_version: 1,
    };
    const affectedCells = {
        event_uid: `0x${"aa".repeat(32)}`,
        event_revision: eventRevision,
        oracle_version: 1,
        geo_resolution: 7,
        cells_generation_method: "shakemap_gridxml_h3_center_bilinear_v1",
        cell_metric: "USGS_MMI",
        cell_aggregation: "H3_CENTER_BILINEAR",
        intensity_scale: "MMI_X100",
        affected_cells: [{ h3_index: "608819013513904127", intensity_value: 831, cell_band: 2 }],
    };
    const affectedCellsRoot = computeAffectedCellsRootHex(affectedCells);
    if (affectedCellsRoot === null) {
        throw new Error("fixture affected cells should produce a Merkle root");
    }
    const affectedCellsBytes = jsonBytes(affectedCells);
    const affectedCellsHash = `0x${sha256Hex(affectedCellsBytes)}`;
    const affectedCellsRef = {
        uri: "walrus://blob/cellsBlob_123456",
        walrus_blob_id: "cellsBlob_123456",
        source_hash: affectedCellsHash,
        size_bytes: affectedCellsBytes.byteLength,
    };
    const evidenceManifest = {
        schema_version: 1,
        oracle_version: 1,
        event_uid: `0x${"aa".repeat(32)}`,
        event_revision: eventRevision,
        hazard_type: "EARTHQUAKE",
        source_event_id: "us7000sonari",
        sources: manifest.entries.map((entry) => ({
            source: entry.name,
            product: entry.product,
            source_uri: entry.source_uri,
            artifact_uri: entry.uri,
            content_hash: entry.content_hash,
            size_bytes: entry.size_bytes,
            source_updated_at_ms: 1_800_000_000_000,
        })),
        earthquake: {
            title: "M 7.1 - Sonari Fixture Earthquake",
            region: "Sonari Fixture Region",
            occurred_at_ms: 1_800_000_000_000,
            magnitude_x100: 710,
            source_updated_at_ms: 1_800_000_000_000,
        },
        affected_cells: {
            uri: affectedCellsRef.uri,
            hash: affectedCellsHash,
            root: affectedCellsRoot,
            count: 1,
            geo_resolution: 7,
        },
    };
    const evidenceManifestBytes = jsonBytes(evidenceManifest);
    const evidenceManifestHash = `0x${sha256Hex(evidenceManifestBytes)}`;
    const evidenceManifestRef = {
        uri: "walrus://blob/manifestBlob_123456",
        walrus_blob_id: "manifestBlob_123456",
        source_hash: evidenceManifestHash,
        size_bytes: evidenceManifestBytes.byteLength,
    };
    const result = finalizedResult();
    const payload: EarthquakeOraclePayload = {
        ...(result.payload as EarthquakeOraclePayload),
        event_revision: eventRevision,
        affected_cells_root: affectedCellsRoot,
        evidence_manifest_uri: evidenceManifestRef.uri,
        evidence_manifest_hash: evidenceManifestHash,
    };
    return {
        ...result,
        payload,
        payload_bcs_hex: encodeEarthquakeOraclePayloadBcsHex(payload),
        raw_data_manifest: manifest,
        affected_cells: affectedCells,
        evidence_manifest: evidenceManifest,
        affected_cells_ref: affectedCellsRef,
        evidence_manifest_ref: evidenceManifestRef,
    };
}

function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
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

    constructor(private readonly options: { body?: string; bodies?: string[] } = {}) {}

    async getObjectText(): Promise<string> {
        const next = this.options.bodies?.shift();
        if (next !== undefined) {
            return next;
        }
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
    failWalrusConfiguration = false;
    oversizeFetch = false;
    walrusBlobId: string | undefined;

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
            entry: RawDataEntry;
            artifactS3Key: string;
        }): Promise<{ walrusBlobId: string }> => {
            if (this.failWalrusConfiguration) {
                throw new ConfigurationSourceArchiveError("SourceArchiver configuration failed");
            }
            const walrusBlobId = this.walrusBlobId ?? input.entry.walrus_blob_id;
            this.archived.push({
                artifactS3Key: input.artifactS3Key,
                walrusBlobId,
            });
            return { walrusBlobId };
        },
    };

    constructor(private readonly bytes: Uint8Array) {}
}

function setRequiredFloorCensusEnv(): void {
    process.env.FLOOR_CENSUS_MODE = "submit";
    process.env.FLOOR_CENSUS_TARGET = "0x123::floor_census::submit";
    process.env.FLOOR_CENSUS_PAUSE_STATE = "0xpause";
    process.env.FLOOR_CENSUS_CATEGORY_POOL = earthquakeRelayerCategoryPool;
    process.env.FLOOR_CENSUS_MAIN_POOL = "0xmainpool";
    process.env.SONARI_MEMBERSHIP_REGISTRY_ID = `0x${"77".repeat(32)}`;
    process.env.RELAYER_VERIFIER_REGISTRY = earthquakeRelayerVerifierRegistry;
    process.env.RELAYER_NETWORK = "testnet";
    process.env.RELAYER_GRPC_URL = "https://fullnode.testnet.sui.io:443";
    process.env.RELAYER_SIGNER_SECRET_ARN = "arn:aws:secretsmanager:relayer-signer";
    process.env.SONARI_CENSUS_TRUSTED_VALIDATOR_COMMITTEE_DIGEST =
        "11111111111111111111111111111111";
    process.env.SONARI_EVENT_STREAM_HEAD_OBJECT_ID = `0x${"ee".repeat(32)}`;
}

function readReaderEndpoint(reader: FloorCensusOnchainReader | undefined): unknown {
    return reader === undefined ? undefined : Reflect.get(reader, "endpoint");
}

function readReaderOptions(
    reader: FloorCensusOnchainReader | undefined,
): Record<string, unknown> | undefined {
    if (reader === undefined) {
        return undefined;
    }
    const options = Reflect.get(reader, "options");
    return typeof options === "object" && options !== null
        ? (options as Record<string, unknown>)
        : undefined;
}

class RecordingEnclaveRegistrationAdapter implements EnclaveRegistrationAdapter {
    readonly inputs: Array<{
        source_event_id: string;
        attestation_document_hex: string;
        public_key: string;
    }> = [];

    constructor(private readonly metadata: EnclaveVerificationMetadata = registrationMetadata) {}

    async register(input: {
        sourceEventId: string;
        attestationDocumentHex: string;
        publicKey: string;
    }): Promise<EnclaveVerificationMetadata> {
        this.inputs.push({
            source_event_id: input.sourceEventId,
            attestation_document_hex: input.attestationDocumentHex,
            public_key: input.publicKey,
        });
        return this.metadata;
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
        private readonly verifierFamily = 3,
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
                            verifier_family: this.verifierFamily,
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

class FailingEnclaveRegistrationClient implements EnclaveRegistrationClient {
    readonly requests: Array<{
        transaction: unknown;
        signer: unknown;
        include: { effects: true; events: true };
    }> = [];

    constructor(private readonly message: string) {}

    async signAndExecuteTransaction(input: {
        transaction: unknown;
        signer: unknown;
        include: { effects: true; events: true };
    }) {
        this.requests.push(input);
        return {
            $kind: "FailedTransaction" as const,
            FailedTransaction: {
                status: {
                    success: false,
                    error: { message: this.message },
                },
            },
        };
    }
}

class RecordingEnclaveRegistryReader implements EnclaveRegistryReader {
    readonly inputs: Parameters<EnclaveRegistryReader["readExistingRegistration"]>[0][] = [];

    constructor(private readonly metadata: EnclaveVerificationMetadata | undefined) {}

    async readExistingRegistration(
        input: Parameters<EnclaveRegistryReader["readExistingRegistration"]>[0],
    ): Promise<EnclaveVerificationMetadata | undefined> {
        this.inputs.push(input);
        return this.metadata;
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

class RecordingAffectedCellsProofRegistrar implements AffectedCellsProofRegistrarAdapter {
    readonly inputs: Parameters<AffectedCellsProofRegistrarAdapter["register"]>[0][] = [];

    async register(
        input: Parameters<AffectedCellsProofRegistrarAdapter["register"]>[0],
    ): Promise<{ stored: boolean; shardCount: number }> {
        this.inputs.push(input);
        return { stored: true, shardCount: 1 };
    }
}

class FailingAffectedCellsProofRegistrar implements AffectedCellsProofRegistrarAdapter {
    async register(): Promise<{ stored: boolean; shardCount: number }> {
        throw new Error("affected proof worker unavailable");
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
                    categoryRegistry: earthquakeRelayerCategoryRegistry,
                    categoryPool: earthquakeRelayerCategoryPool,
                    clock: earthquakeRelayerClock,
                    arguments: [
                        earthquakeRelayerRegistry,
                        earthquakeRelayerVerifierRegistry,
                        earthquakeRelayerCategoryRegistry,
                        earthquakeRelayerCategoryPool,
                        earthquakeRelayerClock,
                        [],
                        [],
                        [],
                    ],
                    submitRequest: {
                        target: earthquakeRelayerTarget,
                        registry: earthquakeRelayerRegistry,
                        verifierRegistry: earthquakeRelayerVerifierRegistry,
                        categoryRegistry: earthquakeRelayerCategoryRegistry,
                        categoryPool: earthquakeRelayerCategoryPool,
                        clock: earthquakeRelayerClock,
                        arguments: [
                            earthquakeRelayerRegistry,
                            earthquakeRelayerVerifierRegistry,
                            earthquakeRelayerCategoryRegistry,
                            earthquakeRelayerCategoryPool,
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

class FailingRelayerAdapter implements RelayerAdapter {
    readonly mode = "preview" as const;
    readonly inputs: TeeCoreResult[] = [];

    constructor(
        private readonly errorCode: RelayerErrorCode,
        private readonly message: string,
    ) {}

    async relay(input: TeeCoreResult) {
        this.inputs.push(input);
        return { ok: false as const, error_code: this.errorCode, message: this.message };
    }
}

class RecordingFloorCensusAdapter implements RunnerFloorCensusAdapter {
    readonly inputs: unknown[] = [];

    async run(input: unknown) {
        this.inputs.push(input);
        return {
            status: "succeeded" as const,
            digest: "census-digest",
            campaignId: "0xcampaign",
            disasterEventId: "0xdisaster",
            counts: [1n, 2n, 3n] as const,
            censusBcsHex: `0x${"aa".repeat(32)}`,
            signatureHex: `0x${"11".repeat(64)}`,
            publicKeyHex: `0x${"22".repeat(32)}`,
        };
    }
}

class RecordingFloorCensusReader implements FloorCensusOnchainReader {
    async findCampaignId(): Promise<{ campaignId: string; checkpoint: number }> {
        return { campaignId: `0x${"66".repeat(32)}`, checkpoint: 123 };
    }

    async listHomeCellRegisteredEvents() {
        return [
            {
                lineage: `0x${"44".repeat(32)}`,
                homeCell: "608819013513904127",
                registeredAtMs: 1_799_999_999_000,
            },
        ];
    }

    async listActiveLineages(input: { lineages: readonly string[] }): Promise<ReadonlySet<string>> {
        return new Set(input.lineages);
    }

    async collectAuthenticatedEventProof() {
        return {
            protocol: "sui-authenticated-events-v1" as const,
            stream_id: `0x${"12".repeat(32)}`,
            event_stream_head_object_id: `0x${"34".repeat(32)}`,
            start_checkpoint: 0,
            end_checkpoint: 123,
            highest_indexed_checkpoint: 123,
            validator_committee_bcs: "Y29tbWl0dGVl",
            checkpoint_summary_bcs: "c3VtbWFyeQ==",
            checkpoint_signature_bcs: "c2lnbmF0dXJl",
            event_stream_head: {
                object_id: `0x${"34".repeat(32)}`,
                version: "7",
                digest: "11111111111111111111111111111111",
                object_bcs: "aGVhZA==",
            },
            ocs_proof: {
                leaf_index: 3,
                tree_root: "11111111111111111111111111111112",
                merkle_proof: ["cHJvb2YtMQ=="],
            },
            events: [
                {
                    checkpoint: 100,
                    transaction_index: 0,
                    event_index: 0,
                    type: `0x${"12".repeat(32)}::membership::MembershipPassIssued`,
                    event_bcs: "ZXZlbnQtMQ==",
                },
            ],
        };
    }
}

class RecordingFloorCensusSubmitClient {
    readonly requests: Array<{
        transaction: unknown;
        signer: unknown;
        include: { effects: true; events: true };
    }> = [];

    async signAndExecuteTransaction(input: {
        transaction: unknown;
        signer: unknown;
        include: { effects: true; events: true };
    }) {
        this.requests.push(input);
        return {
            $kind: "Transaction" as const,
            Transaction: {
                digest: "census-submit-digest",
                status: { success: true, error: null },
                effects: {},
                events: [],
            },
        };
    }
}
