import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const templatePath = path.join(process.cwd(), "infra/aws/sonari-verifier-runner/template.yaml");

async function readTemplate(): Promise<string> {
    return readFile(templatePath, "utf8");
}

function countType(template: string, resourceType: string): number {
    return (
        template.match(new RegExp(`Type: ${resourceType.replaceAll(":", "\\:")}`, "g"))?.length ?? 0
    );
}

function extractHeredoc(template: string, startMarker: string, endMarker: string): string {
    const start = template.indexOf(startMarker);
    const bodyStart = template.indexOf("\n", start);
    const end = template.indexOf(endMarker, bodyStart);

    expect(start).toBeGreaterThan(-1);
    expect(bodyStart).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(bodyStart);

    return template.slice(bodyStart, end);
}

describe("AWS Sonari verifier runner CloudFormation template", () => {
    it("shares exactly one EC2 AutoScalingGroup and LaunchTemplate across verifier kinds", async () => {
        const template = await readTemplate();

        expect(template).toContain("RunnerAutoScalingGroup:");
        expect(template).toContain("RunnerLaunchTemplate:");
        expect(countType(template, "AWS::AutoScaling::AutoScalingGroup")).toBe(1);
        expect(countType(template, "AWS::EC2::LaunchTemplate")).toBe(1);
        expect(template).toContain('MinSize: "0"');
        expect(template).toContain('MaxSize: "1"');
        expect(template).toContain('DesiredCapacity: "0"');
    });

    it("keeps both domain Lambda entrypoint families in the same stack", async () => {
        const template = await readTemplate();

        expect(template).toContain("EventsTable:");
        expect(template).toContain("WatcherLambda:");
        expect(template).toContain("ManualWatcherLambda:");
        expect(template).toContain("WatcherSchedule:");
        expect(template).toContain("Handler: dist/src/lambda.scheduledHandler");
        expect(template).toContain("Handler: dist/src/lambda.manualHandler");

        expect(template).toContain("VerificationJobsTable:");
        expect(template).toContain("RunnerLeaseTable:");
        expect(template).toContain("TableName: !Sub $" + "{AWS::StackName}-runner_lease");
        expect(template).toContain("AttributeName: lease_expires_at");
        expect(template).toContain("TimeToLiveSpecification:");
        expect(template).toContain("SubmitVerificationLambda:");
        expect(template).toContain("SubmitVerificationFunctionUrl:");
        expect(template).toContain("SubmitVerificationFunctionUrlPermission:");
        expect(template).toContain("SubmitVerificationFunctionInvokeUrlPermission:");
        expect(template).toContain("SubmitVerificationFunctionUrlOutput:");
        expect(template).toContain("BatchVerifierLambda:");
        expect(template).toContain("BatchSchedule:");
        expect(template).toContain("Handler: dist/src/lambda.submitVerificationHandler");
        expect(template).toContain("Handler: dist/src/lambda.batchVerifierHandler");
        expect(template).toContain("SONARI_IDENTITY_REGISTRY_ID: !Ref SonariIdentityRegistryId");

        expect(template).toContain("RunnerControlLambda:");
        expect(template).toContain("Handler: dist/src/runner_workflow.handler");
        expect(template).toContain("RUNNER_LEASE_TABLE_NAME: !Ref RunnerLeaseTable");
        expect(template).toContain(
            'SOURCE_ARCHIVER_URL: !If [HasSourceArchiverConfig, !GetAtt SourceArchiverFunctionUrl.FunctionUrl, ""]',
        );
        expect(template).toContain(
            'SOURCE_ARCHIVER_TOKEN_SECRET_ARN: !If [HasSourceArchiverConfig, !Ref SourceArchiverTokenSecretArn, ""]',
        );
        expect(template).toContain(
            'AFFECTED_PROOF_REGISTRAR_URL: !If [HasAffectedProofRegistrarConfig, !Ref AffectedProofRegistrarUrl, ""]',
        );
        expect(template).toContain(
            'AFFECTED_PROOF_REGISTRAR_TOKEN_SECRET_ARN: !If [HasAffectedProofRegistrarConfig, !Ref AffectedProofRegistrarTokenSecretArn, ""]',
        );
        expect(template).toContain("!GetAtt RunnerLeaseTable.Arn");
        const runnerControlRoleStart = template.indexOf("RunnerControlLambdaRole:");
        const runnerStateMachineRoleStart = template.indexOf("RunnerStateMachineRole:");
        const runnerControlRole = template.slice(
            runnerControlRoleStart,
            runnerStateMachineRoleStart,
        );
        expect(runnerControlRole).toContain("Action: s3:PutObject");
        expect(runnerControlRole).toContain(
            "Resource: !Sub $" + "{RunnerResultBucket.Arn}/source-artifacts/*",
        );
        expect(runnerControlRole).toContain("HasAffectedProofRegistrarConfig");
        expect(runnerControlRole).toContain("Resource: !Ref AffectedProofRegistrarTokenSecretArn");
        expect(template).toContain(
            "EARTHQUAKE_NITRO_ENCLAVE_PROCESS_COMMAND: !Ref EarthquakeNitroEnclaveProcessCommand",
        );
        expect(template).toContain(
            "MEMBERSHIP_NITRO_ENCLAVE_PROCESS_COMMAND: !Ref MembershipNitroEnclaveProcessCommand",
        );
    });

    it("exposes SubmitVerification through a public POST Function URL", async () => {
        const template = await readTemplate();
        const start = template.indexOf("SubmitVerificationFunctionUrl:");
        const end = template.indexOf("BatchVerifierLambda:", start);
        const submitUrlResources = template.slice(start, end);

        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        expect(submitUrlResources).toContain("Type: AWS::Lambda::Url");
        expect(submitUrlResources).toContain("AuthType: NONE");
        expect(submitUrlResources).toContain("TargetFunctionArn: !Ref SubmitVerificationLambda");
        expect(submitUrlResources).toContain("Cors:");
        expect(submitUrlResources).toContain("- POST");
        expect(submitUrlResources).toContain("- content-type");
        expect(submitUrlResources).toContain('- "*"');
        expect(submitUrlResources).toContain("Action: lambda:InvokeFunctionUrl");
        expect(submitUrlResources).toContain("FunctionUrlAuthType: NONE");
        expect(submitUrlResources).toContain("InvokedViaFunctionUrl: true");
        expect(template).toContain(
            "SubmitVerificationFunctionUrlOutput:\n    Value: !GetAtt SubmitVerificationFunctionUrl.FunctionUrl",
        );
    });

    it("passes verifier kind through every runner control task", async () => {
        const template = await readTemplate();
        const runnerTaskCount =
            template.match(/"Resource": "\$\{RunnerControlLambda\.Arn\}"/g)?.length ?? 0;
        const verifierKindParameterCount =
            template.match(/"Parameters": \{[^}]*"verifier_kind\.\$": "\$\.verifier_kind"/g)
                ?.length ?? 0;

        expect(template).toContain('"verifier_kind.$": "$.verifier_kind"');
        expect(runnerTaskCount).toBeGreaterThan(0);
        expect(verifierKindParameterCount).toBe(runnerTaskCount);
        expect(template).toContain('"verifier_kind": "earthquake"');
        expect(template).toContain('"verifier_kind": "membership_identity"');
    });

    it("retries ArchiveSources on transient failure like the affected-cells proof step", async () => {
        const template = await readTemplate();

        const start = template.indexOf('"action": "archive_sources"');
        const next = template.indexOf('"RegisterAffectedCellsProof": {', start);

        expect(start).toBeGreaterThan(-1);
        expect(next).toBeGreaterThan(start);

        const archiveBlock = template.slice(start, next);
        expect(archiveBlock).toContain(
            '"Retry": [{ "ErrorEquals": ["States.ALL"], "IntervalSeconds": 5, "MaxAttempts": 3, "BackoffRate": 2.0 }]',
        );
    });

    it("routes affected proof registration after archive and supports registration-only retry starts", async () => {
        const template = await readTemplate();

        expect(template).toContain('"StartAt": "StartRouter"');
        expect(template).toContain(
            '{ "And": [\n                  { "Variable": "$.action", "IsPresent": true },\n                  { "Variable": "$.action", "StringEquals": "register_affected_cells_proof" }\n                ], "Next": "RegisterAffectedCellsProofRetry" }',
        );
        expect(template).toContain('"StringEquals": "register_affected_cells_proof"');
        expect(template).toContain('"Next": "RegisterAffectedCellsProofRetry"');
        expect(template).toContain('"ArchiveSources"');
        expect(template).toContain('"Next": "RegisterAffectedCellsProof"');
        expect(template).toContain('"RegisterAffectedCellsProof"');
        expect(template).toContain('"Next": "RelayerPreviewOrDryRun"');
        expect(template).toContain('"RegisterAffectedCellsProofRetry"');
        expect(template).toContain('"End": true');
        expect(template).toContain('"Next": "RestoreAffectedCellsProofRegistrationRetry"');
        expect(template).toContain('"RestoreAffectedCellsProofRegistrationRetry"');
        expect(template).toContain('"action": "restore_affected_cells_proof_registration_retry"');
        expect(template).toContain('"ProofRegistrationRetryComplete"');
        expect(template).toContain('"action": "register_affected_cells_proof"');
    });

    it("dispatches the shared run-sonari-verifier entry by verifier kind", async () => {
        const template = await readTemplate();
        const dispatcherStart = template.indexOf("cat >/opt/sonari/bin/run-sonari-verifier");
        const heredocBodyStart = template.indexOf("\n", dispatcherStart);
        const dispatcherEnd = template.indexOf("SONARI_VERIFIER_DISPATCH", heredocBodyStart);
        const dispatcher = template.slice(dispatcherStart, dispatcherEnd);

        expect(dispatcherStart).toBeGreaterThan(-1);
        expect(dispatcherEnd).toBeGreaterThan(dispatcherStart);

        // membership path selects the membership identity enclave wrapper.
        expect(dispatcher).toContain('"membership_identity"');
        expect(dispatcher).toContain(
            "$" +
                "{!SONARI_MEMBERSHIP_NITRO_ENCLAVE_PROCESS_COMMAND:-/opt/sonari/bin/run-membership-identity-enclave}",
        );

        // earthquake path remains the earthquake enclave wrapper, unchanged.
        expect(dispatcher).toContain(
            "$" +
                "{!SONARI_EARTHQUAKE_NITRO_ENCLAVE_PROCESS_COMMAND:-/opt/sonari/bin/run-earthquake-enclave}",
        );
    });

    it("waits and retries when shared runner capacity is leased by another workflow", async () => {
        const template = await readTemplate();
        const capacityChoiceCount = template.match(/"RunnerCapacityAvailable": \{/g)?.length ?? 0;
        const waitForLeaseCount =
            template.match(
                /"WaitForSharedRunnerLease": \{ "Type": "Wait", "Seconds": 60, "Next": "StartInstance" \}/g,
            )?.length ?? 0;

        expect(template).toContain('"$.capacity_busy"');
        expect(template).toContain('"IsPresent": true');
        expect(template).toContain('"BooleanEquals": true');
        expect(capacityChoiceCount).toBe(2);
        expect(waitForLeaseCount).toBe(2);
    });

    it("runs earthquake verifier through health check, attestation registration, and process_data", async () => {
        const template = await readTemplate();
        const start = template.indexOf("EarthquakeRunnerStateMachine:");
        const end = template.indexOf("MembershipRunnerStateMachine:");
        const earthquake = template.slice(start, end);
        const expectedActions = [
            '"action": "dispatch_health_check_command"',
            '"action": "read_health_check_result"',
            '"action": "dispatch_get_attestation_command"',
            '"action": "read_attestation_result"',
            '"action": "register_enclave_instance"',
            '"action": "dispatch_process_data_command"',
            '"action": "read_result"',
            '"action": "relayer_preview_or_dry_run"',
        ];

        expect(earthquake).toContain('"Next": "DispatchHealthCheckCommand"');
        for (const action of expectedActions) {
            expect(earthquake).toContain(action);
        }
        expect(earthquake).not.toContain('"action": "dispatch_tee_command"');
        for (let index = 1; index < expectedActions.length; index += 1) {
            const previousAction = expectedActions[index - 1];
            const currentAction = expectedActions[index];
            if (previousAction === undefined || currentAction === undefined) {
                throw new Error("expected action sequence was malformed");
            }
            expect(earthquake.indexOf(previousAction)).toBeLessThan(
                earthquake.indexOf(currentAction),
            );
        }
        expect(earthquake).toContain('"attestation.$": "$.attestation_result.attestation"');
        expect(earthquake).toContain(
            '"registration_metadata.$": "$.registration_result.registration_metadata"',
        );
    });

    it("runs membership verifier through attestation registration and process_data", async () => {
        const template = await readTemplate();
        const start = template.indexOf("MembershipRunnerStateMachine:");
        const end = template.indexOf("WatcherSchedule:", start);
        const membership = template.slice(start, end);
        const expectedActions = [
            '"action": "dispatch_get_attestation_command"',
            '"action": "read_attestation_result"',
            '"action": "register_enclave_instance"',
            '"action": "dispatch_process_data_command"',
            '"action": "read_result"',
            '"action": "dry_run_sui_submission"',
            '"action": "submit_sui_submission"',
            '"action": "apply_result"',
        ];

        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        expect(membership).toContain('"Next": "DispatchGetAttestationCommand"');
        expect(membership).not.toContain('"action": "dispatch_tee_command"');
        for (const action of expectedActions) {
            expect(membership).toContain(action);
        }
        for (let index = 1; index < expectedActions.length; index += 1) {
            const previousAction = expectedActions[index - 1];
            const currentAction = expectedActions[index];
            if (previousAction === undefined || currentAction === undefined) {
                throw new Error("expected action sequence was malformed");
            }
            expect(membership.indexOf(previousAction)).toBeLessThan(
                membership.indexOf(currentAction),
            );
        }
        expect(membership).toContain('"attestation.$": "$.attestation_result.attestation"');
        expect(membership).toContain(
            '"registration_metadata.$": "$.registration_result.registration_metadata"',
        );
        expect(membership).toContain('"Next": "DryRunSuiSubmission"');
        expect(membership).toContain('"StringEquals": "succeeded", "Next": "SubmitSuiSubmission"');
        expect(membership).toContain('"SubmitSuiSubmission"');
        expect(membership).toContain('"Default": "ApplyResult"');
        expect(membership).toContain('"action": "submit_sui_submission"');
    });

    it("keeps schedules disabled by default and uses that state for both schedules", async () => {
        const template = await readTemplate();
        const scheduleStateUsageCount = template.match(/State: !Ref ScheduleState/g)?.length ?? 0;

        expect(template).toContain("ScheduleState:");
        expect(template).toContain("Default: DISABLED");
        expect(template).toContain("- ENABLED");
        expect(template).toContain("- DISABLED");
        expect(scheduleStateUsageCount).toBe(2);
    });

    it("keeps only the earthquake Walrus blob-id CLI in the runner environment", async () => {
        const template = await readTemplate();
        const runnerLaunchTemplate = template.slice(
            template.indexOf("RunnerLaunchTemplate:"),
            template.indexOf("RunnerAutoScalingGroup:"),
        );

        expect(template).toContain("EarthquakeTeeEifS3Bucket:");
        expect(template).toContain("EarthquakeTeeEifS3Key:");
        expect(template).toContain("EarthquakeTeeEifSha256:");
        expect(template).toContain("Default: /opt/sonari/bin/run-earthquake-enclave");
        expect(template).toContain(
            "aws s3 cp 's3://$" + "{EarthquakeTeeEifS3Bucket}/$" + "{EarthquakeTeeEifS3Key}'",
        );
        expect(template).toContain("SONARI_EARTHQUAKE_ENCLAVE_WRAPPER");
        expect(template).toContain(
            'sed -i "s/^memory_mib:.*/memory_mib: $' + '{NitroEnclaveMemoryMiB}/"',
        );
        expect(template).toContain("systemctl restart nitro-enclaves-allocator.service");
        expect(template).toContain("source /opt/sonari/runner.env");
        expect(template).toContain("VSOCK-CONNECT:$SONARI_EARTHQUAKE_ENCLAVE_CID:7777");
        expect(template).toContain("VSOCK-CONNECT:$SONARI_EARTHQUAKE_ENCLAVE_CID:3000");
        expect(template).toContain("call_earthquake_enclave GET /health_check");
        expect(template).toContain("call_earthquake_enclave GET /get_attestation");
        expect(template).toContain("call_earthquake_enclave POST /process_data");
        expect(template).toContain("SONARI_WALRUS_CLI=/opt/sonari/tee-artifact/bin/walrus");
        expect(template).toContain("SONARI_EARTHQUAKE_EIF_PATH");
        expect(template).toContain("SONARI_EARTHQUAKE_NITRO_RUN_ENCLAVE_ARGS");
        expect(template).toContain("SONARI_EARTHQUAKE_EGRESS_PROXY_URL");
        expect(template).toContain("egress_proxy_url: $egress_proxy_url");
        expect(template).toContain(
            'exec "$' +
                '{!SONARI_EARTHQUAKE_NITRO_ENCLAVE_PROCESS_COMMAND:-/opt/sonari/bin/run-earthquake-enclave}"',
        );
        expect(runnerLaunchTemplate).not.toContain("WalrusConfigSecretArn:");
        expect(runnerLaunchTemplate).not.toContain("SuiWalletConfigSecretArn:");
        expect(runnerLaunchTemplate).not.toContain("SuiKeystoreSecretArn:");
        expect(runnerLaunchTemplate).not.toContain("WalrusAggregatorUrl:");
        expect(runnerLaunchTemplate).not.toContain("WalrusUploadRelayUrl:");
        expect(runnerLaunchTemplate).not.toContain("WalrusContext:");
        expect(runnerLaunchTemplate).not.toContain("SONARI_WALRUS_CONFIG");
        expect(runnerLaunchTemplate).not.toContain("SONARI_WALRUS_WALLET");
        expect(runnerLaunchTemplate).not.toContain("SONARI_WALRUS_CONTEXT");
        expect(runnerLaunchTemplate).not.toContain("SONARI_WALRUS_AGGREGATOR_URL");
        expect(runnerLaunchTemplate).not.toContain("SONARI_WALRUS_UPLOAD_RELAY");
    });

    it("allocates 4096 MiB to the Nitro enclave so large ShakeMap grids fit", async () => {
        const template = await readTemplate();

        // 128MiB grid を多重保持する処理ピークに耐えるだけのメモリを既定で割り当てる。
        // このパラメータは earthquake と membership の両 enclave で共有される。
        expect(template).toMatch(/NitroEnclaveMemoryMiB:\s*\n\s*Type: Number\s*\n\s*Default: 4096/);
    });

    it("adds a token-protected source archiver Lambda with isolated SDK private key secret", async () => {
        const template = await readTemplate();

        expect(template).toContain("SourceArchiverTokenSecretArn:");
        expect(template).toContain("SourceArchiverPrivateKeySecretArn:");
        expect(template).toContain("AffectedProofRegistrarUrl:");
        expect(template).toContain("AffectedProofRegistrarTokenSecretArn:");
        expect(template).toContain("HasAffectedProofRegistrarConfig:");
        expect(template).toContain("SourceArchiverSuiNetwork:");
        expect(template).toContain("SourceArchiverSuiRpcUrl:");
        expect(template).toContain("SourceArchiverWalrusUploadRelayUrl:");
        expect(template).toContain("SourceArchiverWalrusUploadRelayTipMaxMist:");
        expect(template).toContain("SourceArchiverWalrusEpochs:");
        expect(template).toContain("SourceArchiverWalrusDeletable:");
        expect(template).toContain("HasSourceArchiverConfig:");
        expect(template).toContain("SourceArchiverLambdaRole:");
        expect(template).toContain("SourceArchiverLambda:");
        expect(template).toContain("Handler: dist/src/source_archiver.sourceArchiverHandler");
        expect(template).toContain("SourceArchiverFunctionUrl:");
        expect(template).toContain("SourceArchiverFunctionUrlPermission:");
        expect(template).toContain("SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN:");
        expect(template).toContain("SUI_NETWORK:");
        expect(template).toContain("SUI_RPC_URL:");
        expect(template).toContain("WALRUS_UPLOAD_RELAY_URL:");
        expect(template).toContain("WALRUS_UPLOAD_RELAY_TIP_MAX_MIST:");
        expect(template).toContain("WALRUS_EPOCHS:");
        expect(template).toContain("WALRUS_DELETABLE:");
        expect(template).toContain("Default: https://fullnode.testnet.sui.io:443");
        expect(template).toContain("Default: https://upload-relay.testnet.walrus.space");
        expect(template).toContain("SourceArchiverLambdaName:");
        expect(template).toContain("SourceArchiverFunctionUrlOutput:");
        expect(template).toContain("Action: s3:GetObject");
        expect(template).toContain(
            "Resource: !Sub $" + "{RunnerResultBucket.Arn}/source-artifacts/*",
        );
        expect(template).toContain("- !Ref SourceArchiverTokenSecretArn");
        expect(template).toContain("- !Ref SourceArchiverPrivateKeySecretArn");
        expect(template).not.toContain("SourceArchiverWalrusEnvSecretArn:");
        expect(template).not.toContain("SourceArchiverWalrusLayerArn:");
        expect(template).not.toContain("SourceArchiverWalrusCliPath:");
        expect(template).not.toContain("SOURCE_ARCHIVER_WALRUS_ENV_SECRET_ARN:");
        expect(template).not.toContain("SOURCE_ARCHIVER_WALRUS_CLI:");

        const runnerRoleStart = template.indexOf("RunnerRole:");
        const watcherRoleStart = template.indexOf("WatcherLambdaRole:");
        const runnerRole = template.slice(runnerRoleStart, watcherRoleStart);
        expect(runnerRole).not.toContain("SourceArchiverPrivateKeySecretArn");
    });

    it("configures earthquake enclave egress through a parent CONNECT proxy and local bridge", async () => {
        const template = await readTemplate();

        expect(template).toContain("test -x /opt/sonari/tee-artifact/bin/vsock-tcp-bridge");
        expect(template).toContain("sonari-earthquake-egress-connect-proxy.service");
        expect(template).toContain("sonari-earthquake-egress-vsock-proxy.service");
        expect(template).toContain("earthquake.usgs.gov:443");
        expect(template).toContain("{address: 127.0.0.1, port: 18081}");
        expect(template).toContain("SONARI_EARTHQUAKE_EGRESS_PROXY_PORT=18080");
        expect(template).toContain("SONARI_EARTHQUAKE_EGRESS_PROXY_URL=http://127.0.0.1:18080");
        expect(template).not.toContain("walrus_aggregator_host");
        expect(template).not.toContain("walrus_upload_relay_host");
    });

    it("keeps the earthquake CONNECT proxy and vsock-proxy egress lines unchanged", async () => {
        const template = await readTemplate();

        // The earthquake egress path (CONNECT proxy on 18081, vsock-proxy 18080 ->
        // 127.0.0.1:18081, usgs.gov allowlist) must remain byte-for-byte stable so
        // STEP 2's World ID egress unification never perturbs the earthquake route.
        expect(template).toContain(
            "ExecStart=/opt/sonari/bin/sonari-earthquake-egress-connect-proxy --listen-port 18081 --allowlist-file /opt/sonari/earthquake-egress-allowlist",
        );
        expect(template).toContain("ExecStart=$vsock_proxy_path 18080 127.0.0.1 18081");
        expect(template).toContain(
            "printf '%s\\n' \"earthquake.usgs.gov:443\" >/opt/sonari/earthquake-egress-allowlist",
        );
        // Exactly one earthquake CONNECT proxy and one earthquake vsock proxy unit.
        expect(
            template.match(/sonari-earthquake-egress-connect-proxy\.service/g)?.length ?? 0,
        ).toBeGreaterThanOrEqual(1);
        expect(
            template.match(/ExecStart=\$vsock_proxy_path 18080 127\.0\.0\.1 18081/g)?.length ?? 0,
        ).toBe(1);
    });

    it("routes World ID egress through https plus the shared egress proxy, not a localhost http base", async () => {
        const template = await readTemplate();

        // The membership TEE pins the World ID API base to https://developer.world.org
        // (#128). The host must hand the canonical https base straight to the enclave
        // and steer the TCP connection through the egress proxy, exactly like the
        // earthquake egress model -- never a host-controlled http://127.0.0.1 base.
        expect(template).not.toContain("SONARI_WORLD_ID_API_BASE=http://127.0.0.1:8000");
        expect(template).not.toContain("http://127.0.0.1:8000");
        expect(template).toContain('world_id_api_base="https://developer.world.org"');
        expect(template).toContain('echo "SONARI_WORLD_ID_API_BASE=https://developer.world.org"');
        expect(template).not.toContain(
            "$" + "{WorldIdApiBase}\n            SONARI_WORLD_ID_API_BASE",
        );
        expect(template).not.toContain("printf 'SONARI_WORLD_ID_API_BASE=%q\\n'");
        // The canonical https base must keep its https scheme on the wire.
        expect(template).toContain("Default: https://developer.world.org");
        // World ID HTTPS traffic is forwarded through the same explicit egress proxy
        // as earthquake (http://127.0.0.1:18080), whose host-side allowlist gates the
        // destination -- the host never opens a separate localhost World ID tunnel.
        expect(template).toContain("SONARI_WORLD_ID_EGRESS_PROXY_URL=http://127.0.0.1:18080");
        // The World ID API host is appended to the shared egress allowlist so the
        // CONNECT proxy permits exactly the canonical World ID destination on 443.
        expect(template).toContain(
            "printf '%s\\n' \"$world_id_api_host:443\" >>/opt/sonari/earthquake-egress-allowlist",
        );
        // The legacy host-controlled localhost World ID tunnel (vsock-proxy 8000 ->
        // host:443) and its upstream-base env are gone; egress is unified on the proxy.
        expect(template).not.toContain("SONARI_WORLD_ID_UPSTREAM_API_BASE");
        expect(template).not.toContain("$vsock_proxy_path 8000 $world_id_api_host 443");
    });

    it("retains membership World ID, EIF, KMS attestation, and ciphertext configuration", async () => {
        const template = await readTemplate();

        expect(template).toContain("WorldIdAppId:");
        expect(template).toContain("WorldIdAction:");
        expect(template).toContain('AllowedPattern: "^sonari_membership_register_v[0-9]+$"');
        expect(template).toContain("WorldIdApiBase:");
        expect(template).toContain("Default: https://developer.world.org");
        expect(template).toContain("TeeEifS3Bucket:");
        expect(template).toContain("TeeEifS3Key:");
        expect(template).toContain("TeeEifSha256:");
        expect(template).toContain("SigningSeedCiphertextS3Bucket:");
        expect(template).toContain("SigningSeedCiphertextS3Key:");
        expect(template).toContain("SigningMaterialKmsKey:");
        expect(template).toContain(
            "RoleName: !Sub sonari-verifier-runner-$" + "{AWS::StackName}-runner",
        );
        expect(template).toContain("AllowNitroAttestedSigningMaterialDecrypt");
        expect(template).toContain("NitroEnclaveImageSha384:");
        expect(template).toContain("NitroEnclavePcr3:");
        expect(template).toContain("kms:RecipientAttestation:ImageSha384");
        expect(template).toContain("kms:RecipientAttestation:PCR3");
        expect(template).toContain("SONARI_WORLD_ID_APP_ID");
        expect(template).toContain("SONARI_WORLD_ID_ACTION");
        expect(template).toContain("SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE");
        expect(template).toContain("SONARI_SIGNING_MATERIAL_KMS_KEY_ID");
        expect(template).toContain("printf 'SONARI_MEMBERSHIP_IDENTITY_EIF_PATH=%q");
        expect(template).toContain("printf 'SONARI_NITRO_RUN_ENCLAVE_ARGS=%q");
        expect(template).not.toContain("SONARI_ENCLAVE_STDIO_BRIDGE");
        expect(template).not.toContain("SONARI_DEV_MEMBERSHIP_STDIO_BRIDGE");
        expect(template).not.toContain("SONARI_TEE_SIGNING_KEY_SEED=");
    });

    it("routes membership verifier through server bootstrap and VSOCK HTTP requests", async () => {
        const template = await readTemplate();
        const membershipWrapper = extractHeredoc(
            template,
            "cat >/opt/sonari/bin/run-membership-identity-enclave",
            "SONARI_ENCLAVE_WRAPPER",
        );

        expect(membershipWrapper).toContain("/opt/sonari/runner.env");
        expect(membershipWrapper).toContain(
            ': "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH" "$SONARI_NITRO_RUN_ENCLAVE_ARGS" "$SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID" "$SONARI_WORLD_ID_API_BASE" "$SONARI_WORLD_ID_EGRESS_PROXY_URL" "$SONARI_WORLD_ID_APP_ID" "$SONARI_WORLD_ID_ACTION"',
        );
        expect(membershipWrapper).toContain("m=/tmp/sm");
        expect(membershipWrapper).toContain("nitro-cli terminate-enclave --all");
        expect(membershipWrapper).toContain("rm -f /tmp/se");
        expect(membershipWrapper).toContain("nitro-cli run-enclave $args");
        expect(membershipWrapper).toContain(
            '--arg egress_proxy_url "$SONARI_WORLD_ID_EGRESS_PROXY_URL"',
        );
        expect(membershipWrapper).toContain("$egress_proxy_url");
        expect(membershipWrapper).toContain("VSOCK-CONNECT:$cid:7777");
        expect(membershipWrapper).toContain("VSOCK-CONNECT:$cid:3000");
        expect(membershipWrapper).toContain("GET /get_attestation HTTP/1.0");
        expect(membershipWrapper).toContain("POST /process_data HTTP/1.0");
        expect(membershipWrapper).not.toContain("SONARI_ENCLAVE_STDIO_BRIDGE");
        expect(membershipWrapper).not.toContain('exec "$SONARI_ENCLAVE_STDIO_BRIDGE"');
    });

    it("invalidates stale shared-runner enclave markers when switching verifier kinds", async () => {
        const template = await readTemplate();
        const earthquakeWrapper = extractHeredoc(
            template,
            "cat >/opt/sonari/bin/run-earthquake-enclave",
            "SONARI_EARTHQUAKE_ENCLAVE_WRAPPER",
        );
        const membershipWrapper = extractHeredoc(
            template,
            "cat >/opt/sonari/bin/run-membership-identity-enclave",
            "SONARI_ENCLAVE_WRAPPER",
        );

        expect(earthquakeWrapper).toContain("marker=/tmp/se");
        expect(earthquakeWrapper).toContain("nitro-cli terminate-enclave --all");
        expect(earthquakeWrapper).toContain("rm -f /tmp/sm");
        expect(membershipWrapper).toContain("m=/tmp/sm");
        expect(membershipWrapper).toContain("rm -f /tmp/se");
    });

    it("exports the membership enclave CID to runner.env from the shared NitroEnclaveCid", async () => {
        const template = await readTemplate();

        // The membership SSM commands (buildSsmShellCommand /
        // buildRunnerBootstrapReadinessShellCommand) require
        // SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID. The host must export it from the
        // shared NitroEnclaveCid parameter, exactly like the earthquake CID, since
        // both verifier kinds share one EC2 capacity pool and one enclave CID.
        expect(template).toContain(
            "SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID=$" + "{NitroEnclaveCid}",
        );
        // The earthquake CID export must stay byte-for-byte unchanged.
        expect(template).toContain("SONARI_EARTHQUAKE_ENCLAVE_CID=$" + "{NitroEnclaveCid}");
        // Both CID exports resolve from the same shared NitroEnclaveCid parameter so
        // the membership readiness/dispatch env checks and the earthquake wrapper agree.
        expect(
            template.match(/SONARI_EARTHQUAKE_ENCLAVE_CID=\$\{NitroEnclaveCid\}/g)?.length ?? 0,
        ).toBe(1);
        expect(
            template.match(/SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID=\$\{NitroEnclaveCid\}/g)
                ?.length ?? 0,
        ).toBe(1);
    });

    it("passes identity relayer env to RunnerControlLambda with namespace separation from earthquake", async () => {
        const template = await readTemplate();

        // Identity-specific Parameters
        expect(template).toContain("IdentityRelayerMode:");
        expect(template).toContain("SonariIdentityPackageId:");
        expect(template).toContain("SonariIdentityPauseStateId:");
        expect(template).toContain("SonariIdentityRegistryId:");
        expect(template).toContain("SonariMembershipRegistryId:");
        expect(template).toContain("SonariVerifierRegistryId:");
        expect(template).toContain("SonariSuiClockId:");

        // Identity-specific env vars in RunnerControlLambda Environment
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

        // Earthquake RELAYER_* namespace must remain unchanged
        expect(template).toContain("RELAYER_MODE: !Ref RelayerMode");
        expect(template).toContain("RELAYER_NETWORK: !Ref RelayerNetwork");
        expect(template).toContain("RELAYER_GRPC_URL: !Ref RelayerGrpcUrl");
        expect(template).toContain("RELAYER_SENDER_ADDRESS: !Ref RelayerSenderAddress");
        expect(template).toContain("RELAYER_SIGNER_SECRET_ARN: !Ref RelayerSignerSecretArn");
        expect(template).toContain("RELAYER_ALLOW_SUBMIT: !Ref RelayerAllowSubmit");
    });

    it("runs floor census after a successful earthquake relayer record", async () => {
        const template = await readTemplate();
        const start = template.indexOf("EarthquakeRunnerStateMachine:");
        const end = template.indexOf("MembershipRunnerStateMachine:");
        const earthquake = template.slice(start, end);

        expect(template).toContain("FloorCensusMode:");
        expect(template).toContain("AllowedValues: [disabled, submit]");
        expect(template).toContain("FloorCensusTarget:");
        expect(template).toContain("FloorCensusPauseState:");
        expect(template).toContain("FloorCensusCategoryPool:");
        expect(template).toContain("FloorCensusMainPool:");
        expect(template).toContain("FloorCensusJsonRpcUrl:");
        expect(template).toContain("FLOOR_CENSUS_MODE: !Ref FloorCensusMode");
        expect(template).toContain("FLOOR_CENSUS_TARGET: !Ref FloorCensusTarget");
        expect(template).toContain("FLOOR_CENSUS_PAUSE_STATE: !Ref FloorCensusPauseState");
        expect(template).toContain("FLOOR_CENSUS_CATEGORY_POOL: !Ref FloorCensusCategoryPool");
        expect(template).toContain("FLOOR_CENSUS_MAIN_POOL: !Ref FloorCensusMainPool");
        expect(template).toContain("FLOOR_CENSUS_JSON_RPC_URL: !Ref FloorCensusJsonRpcUrl");

        expect(earthquake).toContain('"Next": "RunFloorCensus"');
        expect(earthquake).toContain('"RunFloorCensus"');
        expect(earthquake).toContain('"action": "run_floor_census"');
        expect(earthquake.indexOf('"action": "record_relayer_success"')).toBeLessThan(
            earthquake.indexOf('"action": "run_floor_census"'),
        );
        expect(earthquake).toContain('"Next": "StopInstance"');
    });

    it("wires DynamoDB Streams event-driven membership trigger with DLQ", async () => {
        const template = await readTemplate();

        // VerificationJobsTable に Stream 有効化
        expect(template).toContain("StreamSpecification:");
        expect(template).toContain("StreamViewType: NEW_AND_OLD_IMAGES");

        // DLQ 用 SQS キュー
        expect(template).toContain("MembershipJobStreamDlq:");
        expect(template).toContain("Type: AWS::SQS::Queue");
        expect(template).toContain("MessageRetentionPeriod: 1209600");

        // 新 Lambda 用 IAM Role
        expect(template).toContain("MembershipJobStreamLambdaRole:");
        expect(template).toContain("dynamodb:DescribeStream");
        expect(template).toContain("dynamodb:GetRecords");
        expect(template).toContain("!GetAtt VerificationJobsTable.StreamArn");
        expect(template).toContain("sqs:SendMessage");

        // 新 Lambda
        expect(template).toContain("MembershipJobStreamLambda:");
        expect(template).toContain("Handler: dist/src/lambda.jobStreamHandler");

        // EventSourceMapping
        expect(template).toContain("MembershipJobStreamEventSourceMapping:");
        expect(template).toContain("Type: AWS::Lambda::EventSourceMapping");
        expect(template).toContain("EventSourceArn: !GetAtt VerificationJobsTable.StreamArn");
        expect(template).toContain("StartingPosition: LATEST");
        expect(template).toContain("BisectBatchOnFunctionError: true");
        expect(template).toContain("FilterCriteria:");
        expect(template).toContain('"status":{"S":["queued","retry"]}');

        // Outputs
        expect(template).toContain("MembershipJobStreamLambdaName:");
        expect(template).toContain("MembershipJobStreamDlqUrl:");

        // 非回帰: 既存リソースが残っていること
        expect(template).toContain("BatchVerifierLambda:");
        expect(template).toContain("BatchSchedule:");
        expect(template).toContain("Handler: dist/src/lambda.batchVerifierHandler");
        expect(template).toContain("SubmitVerificationLambda:");
    });

    it("exposes key unified stack outputs without leaking ciphertext object names", async () => {
        const template = await readTemplate();

        expect(template).toContain("EventsTableName:");
        expect(template).toContain("VerificationJobsTableName:");
        expect(template).toContain("RunnerLeaseTableName:");
        expect(template).toContain("EarthquakeRunnerStateMachineArn:");
        expect(template).toContain("MembershipRunnerStateMachineArn:");
        expect(template).toContain("RunnerAutoScalingGroupName:");
        expect(template).toContain("RunnerLaunchTemplateId:");
        expect(template).toContain("RunnerRoleArn:");
        expect(template).toContain("EarthquakeTeeEifS3KeyOutput:");
        expect(template).toContain("EarthquakeTeeEifSha256Output:");
        expect(template).toContain("WatcherScheduleName:");
        expect(template).toContain("BatchScheduleName:");
        expect(template).toContain("WatcherLambdaName:");
        expect(template).toContain("ManualWatcherLambdaName:");
        expect(template).toContain("SubmitVerificationLambdaName:");
        expect(template).toContain("BatchVerifierLambdaName:");
        expect(template).toContain("RunnerControlLambdaName:");
        expect(template).toContain("SourceArchiverLambdaName:");
        expect(template).toContain("SourceArchiverFunctionUrlOutput:");
        expect(template).not.toContain("SigningSeedCiphertextS3KeyOutput");
        expect(template).not.toContain("SigningSeedCiphertextS3BucketOutput");
    });

    it("defaults membership schedule to once per day and earthquake schedule to fixed JST times", async () => {
        const template = await readTemplate();

        // membership は 1 日 1 回が既定（MembershipScheduleExpression ブロックに紐付けて検証）
        expect(template).toMatch(
            /\n {2}MembershipScheduleExpression:\n {4}Type: String\n {4}Default: rate\(1 day\)\n/,
        );

        // earthquake は毎日 00:00 / 12:00（JST 固定時刻）が既定。
        // membership 側を誤って書き換えても検知できるよう ScheduleExpression ブロックに紐付ける
        expect(template).toMatch(
            /\n {2}ScheduleExpression:\n {4}Type: String\n {4}Default: cron\(0 0,12 \* \* \? \*\)\n/,
        );
        // 旧既定 rate(5 minutes) / rate(12 hours) が残っていないことを確認する
        expect(template).not.toContain("rate(5 minutes)");
        expect(template).not.toContain("rate(12 hours)");

        // 両 schedule の State 制御は共有 ScheduleState パラメータを参照する
        const scheduleStateUsageCount = template.match(/State: !Ref ScheduleState/g)?.length ?? 0;
        expect(scheduleStateUsageCount).toBe(2);
    });

    it("pins the earthquake watcher schedule to the Asia/Tokyo timezone only", async () => {
        const template = await readTemplate();

        // WatcherSchedule は cron を JST で解釈するためタイムゾーンを明示する
        expect(template).toMatch(
            /\n {2}WatcherSchedule:\n {4}Type: AWS::Scheduler::Schedule\n {4}Properties:\n {6}ScheduleExpression: !Ref ScheduleExpression\n {6}ScheduleExpressionTimezone: Asia\/Tokyo\n/,
        );
        // membership(BatchSchedule) には付けない。タイムゾーン指定は watcher の 1 箇所だけ
        const timezoneUsageCount =
            template.match(/ScheduleExpressionTimezone: Asia\/Tokyo/g)?.length ?? 0;
        expect(timezoneUsageCount).toBe(1);
    });

    it("delivers the World ID proof mode and Sui network to the membership enclave bootstrap", async () => {
        const template = await readTemplate();

        // CFN parameter carries the operator's proof mode choice with a safe
        // default so the committed template deploys with real World ID verification.
        expect(template).toContain("WorldIdProofMode:");
        // proof mode only allows real|dummy at deploy time and defaults to real.
        expect(template).toContain("      - real\n      - dummy");
        // runner.env exposes both values to the enclave wrapper, which sources it
        // before running the bootstrap jq. The `$' + `{` split keeps biome from
        // treating these CloudFormation substitutions as JS template literals.
        expect(template).toContain('echo "SONARI_WORLD_ID_PROOF_MODE=$' + '{WorldIdProofMode}"');
        expect(template).toContain('echo "RELAYER_NETWORK=$' + '{RelayerNetwork}"');
        // The bootstrap jq forwards both into the enclave config so the TEE-side
        // fail-closed gate can allow dummy only on testnet/devnet. The wrapper
        // sources runner.env first so bare $VAR references are safe here.
        expect(template).toContain('--arg network "$RELAYER_NETWORK"');
        expect(template).toContain('--arg proof_mode "$SONARI_WORLD_ID_PROOF_MODE"');
        expect(template).toContain('--arg world_id_action "$SONARI_WORLD_ID_ACTION"');
        // shorthand keys must appear in the jq output object
        expect(template).toContain(",$network,$proof_mode,$world_id_action}");
    });

    it("escapes bash parameter expansions so every Fn::Sub variable name stays valid", async () => {
        const template = await readTemplate();

        // CloudFormation Fn::Sub only accepts [A-Za-z0-9_.:] in a variable name.
        // Bash expansions inside the UserData !Sub (e.g. ${VAR:-default}) must be
        // written as ${!VAR:-default} so CloudFormation emits the literal ${...}
        // instead of resolving an invalid variable name. A bare ${VAR:-x} fails
        // CreateChangeSet with "variable names in Fn::Sub syntax must contain only
        // alphanumeric characters, underscores, periods, and colons".
        const invalidSubstitutions: string[] = [];
        for (const match of template.matchAll(/\$\{(!?)([^}]*)\}/g)) {
            const isEscaped = match[1] === "!";
            const variableName = match[2] ?? "";
            if (isEscaped) {
                continue;
            }
            if (!/^[A-Za-z0-9_.:]+$/.test(variableName)) {
                invalidSubstitutions.push(variableName);
            }
        }

        expect(invalidSubstitutions).toEqual([]);
        // The shared dispatcher selects the verifier kind via an escaped expansion
        // so CloudFormation does not treat "SONARI_VERIFIER_KIND:-earthquake" as a var.
        expect(template).toContain('case "$' + '{!SONARI_VERIFIER_KIND:-earthquake}" in');
    });

    it("keeps the rendered EC2 UserData within the 16384-byte limit", async () => {
        const template = await readTemplate();

        // EC2 LaunchTemplate UserData is limited to 16384 bytes after CloudFormation
        // resolves the Fn::Base64 !Sub block. Exceeding it fails the stack update with
        // InvalidUserData.Malformed (the shared runner pool keeps growing as verifier
        // kinds are added, so guard the budget here instead of at deploy time).
        const EC2_USER_DATA_LIMIT = 16384;

        // Representative byte lengths of the dev-deploy parameter values that the
        // UserData !Sub interpolates. Synthetic equal-length strings keep this test
        // free of real infra identifiers while tracking the rendered byte size.
        const representativeLength: Record<string, number> = {
            EarthquakeNitroEnclaveProcessCommand: 38,
            EarthquakeTeeEifS3Bucket: 58,
            EarthquakeTeeEifS3Key: 82,
            EarthquakeTeeEifSha256: 64,
            MembershipNitroEnclaveProcessCommand: 47,
            MembershipTeeArtifactS3Bucket: 58,
            MembershipTeeArtifactS3Key: 103,
            MembershipTeeArtifactSha256: 64,
            NitroEnclaveCid: 2,
            NitroEnclaveCpuCount: 1,
            NitroEnclaveMemoryMiB: 4,
            NitroEnclaveProcessCommand: 35,
            RelayerNetwork: 7,
            RunnerTokenSecretArn: 106,
            SigningMaterialKmsKey: 36,
            SigningSeedCiphertextS3Bucket: 58,
            SigningSeedCiphertextS3Key: 61,
            TeeArtifactS3Bucket: 58,
            TeeArtifactS3Key: 94,
            TeeArtifactSha256: 64,
            TeeEifS3Bucket: 58,
            TeeEifS3Key: 91,
            TeeEifSha256: 64,
            WorldIdAppId: 17,
            WorldIdAction: 29,
            WorldIdProofMode: 5,
        };

        // Extract the "Fn::Base64: !Sub |" block and de-indent it the way a YAML
        // literal block scalar does (strip the common leading indentation).
        const templateLines = template.split("\n");
        const startIndex = templateLines.findIndex((line) => line.includes("Fn::Base64: !Sub |"));
        expect(startIndex).toBeGreaterThan(-1);
        const baseIndent = templateLines[startIndex]?.match(/^ */)?.[0]?.length ?? 0;
        const blockLines: string[] = [];
        for (const line of templateLines.slice(startIndex + 1)) {
            if (line.trim() === "") {
                blockLines.push("");
                continue;
            }
            const indent = line.match(/^ */)?.[0]?.length ?? 0;
            if (indent <= baseIndent) {
                break;
            }
            blockLines.push(line);
        }
        const contentIndent = baseIndent + 2;
        const body = blockLines
            .map((line) =>
                line.length >= contentIndent ? line.slice(contentIndent) : line.trimStart(),
            )
            .join("\n");

        // Resolve substitutions: ${!X} stays a literal ${X} (bash expansion), and a
        // bare ${X} becomes a representative deploy value of the right byte length.
        const rendered = body.replace(
            /\$\{(!?)([^}]*)\}/g,
            (_full: string, escapeMarker: string, name: string): string => {
                if (escapeMarker === "!") {
                    return `\${${name}}`;
                }
                const length = representativeLength[name];
                if (length === undefined) {
                    throw new Error(`UserData references an unmapped Fn::Sub parameter: ${name}`);
                }
                return "x".repeat(length);
            },
        );

        expect(Buffer.byteLength(rendered, "utf8")).toBeLessThan(EC2_USER_DATA_LIMIT);
    });
});
