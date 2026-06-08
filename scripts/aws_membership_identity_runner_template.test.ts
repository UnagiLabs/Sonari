import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const templatePath = path.join(process.cwd(), "infra/aws/membership-identity-runner/template.yaml");

describe("AWS membership identity runner CloudFormation template", () => {
    const legacyLocalWorldIdBase = "SONARI_WORLD_ID_API_BASE=http://127.0.0.1:" + "8000";

    it("defines the verification job queue and Lambda workflow entrypoints", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("VerificationJobsTable:");
        expect(template).toContain(`TableName: !Sub $${"{AWS::StackName}"}-verification_jobs`);
        expect(template).toContain("AttributeName: job_id");
        expect(template).toContain("KeyType: HASH");
        expect(template).toContain("SubmitVerificationLambda:");
        expect(template).toContain("Handler: dist/src/lambda.submitVerificationHandler");
        expect(template).toContain("BatchVerifierLambda:");
        expect(template).toContain("Handler: dist/src/lambda.batchVerifierHandler");
        expect(template).toContain("VERIFICATION_JOBS_TABLE_NAME: !Ref VerificationJobsTable");
        expect(template).toContain("RUNNER_STATE_MACHINE_ARN: !Ref RunnerStateMachine");
    });

    it("does not expose a public HTTP runner surface", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).not.toContain("AWS::ElasticLoadBalancingV2::LoadBalancer");
        expect(template).not.toContain("AWS::ElasticLoadBalancingV2::Listener");
        expect(template).not.toContain("AWS::ElasticLoadBalancingV2::TargetGroup");
        expect(template).not.toContain("AWS::Lambda::Url");
        expect(template).not.toContain("AWS::ApiGateway");
        expect(template).not.toContain("AWS::ApiGatewayV2");
        expect(template).not.toContain("FunctionUrlAuthType: NONE");
        expect(template).not.toContain("CidrIp: 0.0.0.0/0\n          FromPort");
    });

    it("keeps EC2 Nitro runner capacity private and at zero until workflow demand", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("RunnerLaunchTemplate:");
        expect(template).toContain("EnclaveOptions:");
        expect(template).toContain("Enabled: true");
        expect(template).toContain("MetadataOptions:");
        expect(template).toContain("HttpTokens: required");
        expect(template).toContain("RunnerAutoScalingGroup:");
        expect(template).toContain('MinSize: "0"');
        expect(template).toContain('MaxSize: "1"');
        expect(template).toContain('DesiredCapacity: "0"');
        expect(template).toContain("TeeEifS3Bucket:");
        expect(template).toContain("TeeEifS3Key:");
        expect(template).toContain("TeeEifSha256:");
        expect(template).toContain("NitroEnclaveCpuCount:");
        expect(template).toContain("NitroEnclaveMemoryMiB:");
        expect(template).toContain("NitroEnclaveCid:");
        expect(template).toContain(
            'sed -i "s/^memory_mib:.*/memory_mib: $' + '{NitroEnclaveMemoryMiB}/"',
        );
        expect(template).toContain("systemctl restart nitro-enclaves-allocator.service");
        expect(template).toContain("dnf install -y awscli amazon-ssm-agent libstdc++ python3");
        expect(template).toContain("yum install -y awscli amazon-ssm-agent libstdc++ python3");
        expect(template).toContain(
            "grep -Fq '{address: 127.0.0.1, port: 18081}' /etc/nitro_enclaves/vsock-proxy.yaml",
        );
        expect(template).toContain(
            "printf '%s\\n' '- {address: 127.0.0.1, port: 18081}' >>/etc/nitro_enclaves/vsock-proxy.yaml",
        );
        expect(template).toContain("Default: /opt/sonari/bin/run-membership-identity-enclave");
        expect(template).toContain("/opt/sonari/bin/run-membership-identity-enclave");
        expect(template).toContain("printf 'SONARI_NITRO_RUN_ENCLAVE_ARGS=%q");
        expect(template).not.toContain("SONARI_DEV_MEMBERSHIP_STDIO_BRIDGE");
        expect(template).not.toContain("sonari-enclave-stdio");
        expect(template).not.toContain("Sonari dev fixture World ID proxy placeholder");
        // VSOCK server mode: runner.env exposes the enclave CID and the wrapper
        // routes stdin actions to the enclave over VSOCK instead of an stdio bridge.
        expect(template).toContain("SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID");
        expect(template).toContain("/get_attestation");
        expect(template).toContain("/process_data");
        expect(template).toContain('--arg egress_proxy_url "$SONARI_WORLD_ID_EGRESS_PROXY_URL"');
        expect(template).toContain("egress_proxy_url: $egress_proxy_url");
        expect(template).toContain("VSOCK-CONNECT");
        expect(template).toContain(
            "GroupDescription: Sonari membership identity runner with SSM-only control plane",
        );
        expect(template).not.toContain("SecurityGroupIngress:");
    });

    it("treats World ID values as runtime config without requiring host signing material at runtime", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("WorldIdAppId:");
        expect(template).toContain("WorldIdApiBase:");
        expect(template).toContain("Default: https://developer.world.org");
        expect(template).toContain("SONARI_WORLD_ID_APP_ID");
        expect(template).toContain('echo "SONARI_WORLD_ID_API_BASE=https://developer.world.org"');
        expect(template).toContain("SONARI_WORLD_ID_EGRESS_PROXY_URL=http://127.0.0.1:18080");
        expect(template).not.toContain(legacyLocalWorldIdBase);
        expect(template).toContain("SigningSeedCiphertextS3Bucket:");
        expect(template).toContain("SigningSeedCiphertextS3Key:");
        expect(template).toContain("SigningMaterialKmsKey:");
        expect(template).not.toContain(
            'echo "SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE=/opt/sonari/signing-seed.ciphertext"',
        );
        expect(template).not.toContain('echo "SONARI_SIGNING_MATERIAL_KMS_KEY_ID=');
        expect(template).not.toContain("TeeSigningKeySecretArn");
        expect(template).not.toContain("SONARI_TEE_SIGNING_KEY_SEED=");
        expect(template).not.toContain("SONARI_TEE_SIGNING_KEY_SEED_FILE");
        expect(template).not.toContain("aws kms decrypt");
    });

    it("defines World ID v4 rp_id and environment parameters for operator deploy configuration", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("WorldIdRpId:");
        expect(template).toContain("WorldIdEnvironment:");
        expect(template).toContain("      - production\n      - staging");
        expect(template).toContain("Default: production");
    });

    it("wires rp_id and environment into runner.env and enclave bootstrap replacing the legacy app_id key", async () => {
        const template = await readFile(templatePath, "utf8");

        // runner.env must output both rp_id and environment lines
        expect(template).toContain("printf 'SONARI_WORLD_ID_RP_ID=%q");
        expect(template).toContain('echo "SONARI_WORLD_ID_ENVIRONMENT=$' + '{WorldIdEnvironment}"');
        // bootstrap jq must use rp_id (not app_id) as the canonical key
        expect(template).toContain('--arg world_id_rp_id "$SONARI_WORLD_ID_RP_ID"');
        expect(template).toContain(
            '--arg world_id_environment "$' + '{SONARI_WORLD_ID_ENVIRONMENT:-}"',
        );
        expect(template).toContain("world_id_rp_id: $world_id_rp_id");
        expect(template).toContain("world_id_environment: $world_id_environment");
        // enclave wrapper must require rp_id at runtime
        expect(template).toContain("$" + "{SONARI_WORLD_ID_RP_ID:?");
        // bootstrap JSON must NOT contain both app_id and rp_id (serde alias collision)
        expect(template).not.toContain("world_id_app_id: $world_id_app_id");
    });

    it("delivers the World ID proof mode and Sui network to the enclave bootstrap for the fail-closed dummy gate", async () => {
        const template = await readFile(templatePath, "utf8");

        // CFN parameters carry the operator's proof mode / network choice with safe
        // defaults so the committed template deploys as real World ID verification.
        expect(template).toContain("WorldIdProofMode:");
        expect(template).toContain("RelayerNetwork:");
        // proof mode only allows real|dummy at deploy time and defaults to real.
        expect(template).toContain("      - real\n      - dummy");
        // runner.env exposes both values to the enclave wrapper, which sources it
        // before running the bootstrap jq. The `$' + '{` split keeps biome from
        // treating these CloudFormation substitutions as JS template literals.
        expect(template).toContain('echo "SONARI_WORLD_ID_PROOF_MODE=$' + '{WorldIdProofMode}"');
        expect(template).toContain('echo "RELAYER_NETWORK=$' + '{RelayerNetwork}"');
        // The bootstrap jq forwards both into the enclave config so the TEE-side
        // fail-closed gate can allow dummy only on testnet/devnet.
        expect(template).toContain('--arg proof_mode "$' + '{SONARI_WORLD_ID_PROOF_MODE:-}"');
        expect(template).toContain('--arg network "$' + '{RELAYER_NETWORK:-}"');
        expect(template).toContain("proof_mode: $proof_mode");
        expect(template).toContain("network: $network");
    });

    it("gates KMS decrypt of signing material on Nitro attestation measurements", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("SigningMaterialKmsKey:");
        expect(template).toContain("DenyUnattestedSigningMaterialDecrypt");
        expect(template).toContain("AllowNitroAttestedSigningMaterialDecrypt");
        expect(template).toContain("NitroEnclaveImageSha384:");
        expect(template).toContain("NitroEnclavePcr3:");
        expect(template).toContain("kms:RecipientAttestation:ImageSha384");
        expect(template).toContain("kms:RecipientAttestation:PCR3");
        expect(template).toContain("kms:Decrypt");
        expect(template).toContain("Resource: !GetAtt SigningMaterialKmsKey.Arn");
        expect(template).toContain("Action: s3:GetObject");
        expect(template).toContain(
            `Resource: !Sub arn:$${"{AWS::Partition}"}:s3:::$${"{SigningSeedCiphertextS3Bucket}"}/$${"{SigningSeedCiphertextS3Key}"}`,
        );
    });

    it("uses least-privilege orchestration roles and safe stack outputs", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("BatchSchedule:");
        expect(template).toContain("AWS::Scheduler::Schedule");
        expect(template).toContain("State: !Ref ScheduleState");
        expect(template).toContain("states:StartExecution");
        expect(template).toContain("autoscaling:SetDesiredCapacity");
        expect(template).toContain("ssm:SendCommand");
        expect(template).toContain("SubmitVerificationLambdaName:");
        expect(template).toContain("BatchVerifierLambdaName:");
        expect(template).toContain("RunnerAutoScalingGroupName:");
        expect(template).toContain("SigningMaterialKmsKeyId:");
        expect(template).toContain("TeeEifS3KeyOutput:");
        expect(template).toContain("TeeEifSha256Output:");
        expect(template).not.toContain("SigningSeedCiphertextS3KeyOutput");
        expect(template).not.toContain("SigningSeedCiphertextS3BucketOutput");
    });

    it("passes membership verifier kind through every runner control task", async () => {
        const template = await readFile(templatePath, "utf8");
        const runnerTaskCount =
            template.match(/"Resource": "\$\{RunnerControlLambda\.Arn\}"/g)?.length ?? 0;
        const verifierKindParameterCount =
            template.match(/"Parameters": \{[^}]*"verifier_kind\.\$": "\$\.verifier_kind"/g)
                ?.length ?? 0;

        expect(template).toContain('"verifier_kind.$": "$.verifier_kind"');
        expect(runnerTaskCount).toBeGreaterThan(0);
        expect(verifierKindParameterCount).toBe(runnerTaskCount);
    });

    it("wires the attestation -> register -> process_data -> dry-run submission flow in the state machine", async () => {
        const template = await readFile(templatePath, "utf8");
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

        // FindReadyInstance now hands off to the attestation/register chain, not the legacy
        // single-shot dispatch_tee_command path.
        expect(template).toContain('"Next": "DispatchGetAttestationCommand"');
        expect(template).not.toContain('"action": "dispatch_tee_command"');

        // attestation -> register(config_key=2) -> process_data(registration_metadata) wiring.
        for (const action of expectedActions) {
            expect(template).toContain(action);
        }
        for (let index = 1; index < expectedActions.length; index += 1) {
            const previousAction = expectedActions[index - 1];
            const currentAction = expectedActions[index];
            if (previousAction === undefined || currentAction === undefined) {
                throw new Error("expected action sequence was malformed");
            }
            expect(template.indexOf(previousAction)).toBeLessThan(template.indexOf(currentAction));
        }
        expect(template).toContain('"attestation.$": "$.attestation_result.attestation"');
        expect(template).toContain(
            '"registration_metadata.$": "$.registration_result.registration_metadata"',
        );
        expect(template).toContain('"Next": "DryRunSuiSubmission"');
        expect(template).toContain('"Next": "SubmitSuiSubmission"');
        expect(template).toContain('"Default": "ApplyResult"');
        expect(template).toContain('"Next": "StopInstance"');
    });

    it("selects World ID API base host from WorldIdEnvironment parameter at deploy time", async () => {
        const template = await readFile(templatePath, "utf8");

        // case block must branch on WorldIdEnvironment
        expect(template).toContain('case "$' + '{WorldIdEnvironment}" in');
        // staging branch must point to the staging host
        expect(template).toContain('world_id_api_base="https://staging-developer.worldcoin.org"');
        // production / default branch must point to the production host
        expect(template).toContain('world_id_api_base="https://developer.world.org"');
        // host extraction and allowlist write must be preserved
        expect(template).toContain('"$world_id_api_host:443"');
        expect(template).toContain("world-id-egress-allowlist");
    });

    it("rejects mainnet + staging combination fail-closed in UserData", async () => {
        const template = await readFile(templatePath, "utf8");

        // The host-side guard must check the two-axis condition before the enclave starts.
        expect(template).toContain(
            '[ "$' +
                '{RelayerNetwork}" = "mainnet" ] && [ "$' +
                '{WorldIdEnvironment}" = "staging" ]',
        );
        expect(template).toContain("is not allowed on RelayerNetwork=mainnet (fail-closed)");
    });

    it("passes membership identity dry-run object IDs to RunnerControlLambda", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("SonariIdentityPauseStateId:");
        expect(template).toContain("SonariIdentityRegistryId:");
        expect(template).toContain("SonariMembershipRegistryId:");
        expect(template).toContain("SonariSuiClockId:");
        expect(template).toContain("RelayerSenderAddress:");
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
        expect(template).toContain("RELAYER_SENDER_ADDRESS: !Ref RelayerSenderAddress");
    });
});
