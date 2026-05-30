import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const templatePath = path.join(process.cwd(), "infra/aws/membership-identity-runner/template.yaml");

describe("AWS membership identity runner CloudFormation template", () => {
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
        expect(template).toContain("Default: /opt/sonari/bin/run-membership-identity-enclave");
        expect(template).toContain("/opt/sonari/bin/run-membership-identity-enclave");
        expect(template).toContain("printf 'SONARI_NITRO_RUN_ENCLAVE_ARGS=%q");
        expect(template).toContain('[[ "$world_id_app_id" == app_staging_* ]]');
        expect(template).toContain("SONARI_DEV_MEMBERSHIP_STDIO_BRIDGE");
        expect(template).toContain(
            "SONARI_ENCLAVE_STDIO_BRIDGE=/usr/local/bin/sonari-enclave-stdio",
        );
        expect(template).toContain("test -x /usr/local/bin/sonari-enclave-stdio");
        expect(template).toContain(
            "GroupDescription: Sonari membership identity runner with SSM-only control plane",
        );
        expect(template).not.toContain("SecurityGroupIngress:");
    });

    it("treats World ID values as runtime config and never injects a plaintext signing seed", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("WorldIdAppId:");
        expect(template).toContain("WorldIdApiBase:");
        expect(template).toContain("Default: https://developer.world.org");
        expect(template).toContain("SONARI_WORLD_ID_APP_ID");
        expect(template).toContain("SONARI_WORLD_ID_API_BASE");
        expect(template).toContain("SigningSeedCiphertextS3Bucket:");
        expect(template).toContain("SigningSeedCiphertextS3Key:");
        expect(template).toContain("SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE");
        expect(template).toContain("SONARI_SIGNING_MATERIAL_KMS_KEY_ID");
        expect(template).not.toContain("TeeSigningKeySecretArn");
        expect(template).not.toContain("SONARI_TEE_SIGNING_KEY_SEED=");
        expect(template).not.toContain("SONARI_TEE_SIGNING_KEY_SEED_FILE");
        expect(template).not.toContain("secretsmanager:GetSecretValue");
        expect(template).not.toContain("aws kms decrypt");
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
});
