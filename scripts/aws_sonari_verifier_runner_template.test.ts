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
        expect(template).toContain("BatchVerifierLambda:");
        expect(template).toContain("BatchSchedule:");
        expect(template).toContain("Handler: dist/src/lambda.submitVerificationHandler");
        expect(template).toContain("Handler: dist/src/lambda.batchVerifierHandler");

        expect(template).toContain("RunnerControlLambda:");
        expect(template).toContain("Handler: dist/src/runner_workflow.handler");
        expect(template).toContain("RUNNER_LEASE_TABLE_NAME: !Ref RunnerLeaseTable");
        expect(template).toContain("!GetAtt RunnerLeaseTable.Arn");
        expect(template).toContain(
            "EARTHQUAKE_NITRO_ENCLAVE_PROCESS_COMMAND: !Ref EarthquakeNitroEnclaveProcessCommand",
        );
        expect(template).toContain(
            "MEMBERSHIP_NITRO_ENCLAVE_PROCESS_COMMAND: !Ref MembershipNitroEnclaveProcessCommand",
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

    it("keeps schedules disabled by default and uses that state for both schedules", async () => {
        const template = await readTemplate();
        const scheduleStateUsageCount = template.match(/State: !Ref ScheduleState/g)?.length ?? 0;

        expect(template).toContain("ScheduleState:");
        expect(template).toContain("Default: DISABLED");
        expect(template).toContain("- ENABLED");
        expect(template).toContain("- DISABLED");
        expect(scheduleStateUsageCount).toBe(2);
    });

    it("retains earthquake Walrus parameters and runner environment", async () => {
        const template = await readTemplate();

        expect(template).toContain("WalrusConfigSecretArn:");
        expect(template).toContain("SuiWalletConfigSecretArn:");
        expect(template).toContain("SuiKeystoreSecretArn:");
        expect(template).toContain("WalrusAggregatorUrl:");
        expect(template).toContain("WalrusContext:");
        expect(template).toContain("SONARI_WALRUS_CLI=/opt/sonari/tee-artifact/bin/walrus");
        expect(template).toContain("SONARI_WALRUS_CONFIG=/opt/sonari/walrus-client-config.yaml");
        expect(template).toContain("SONARI_WALRUS_WALLET=/opt/sonari/sui_config.yaml");
        expect(template).toContain("SONARI_WALRUS_CONTEXT");
        expect(template).toContain("SONARI_WALRUS_AGGREGATOR_URL");
    });

    it("retains membership World ID, EIF, KMS attestation, and ciphertext configuration", async () => {
        const template = await readTemplate();

        expect(template).toContain("WorldIdAppId:");
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
        expect(template).toContain("SONARI_SIGNING_MATERIAL_CIPHERTEXT_FILE");
        expect(template).toContain("SONARI_SIGNING_MATERIAL_KMS_KEY_ID");
        expect(template).toContain("printf 'SONARI_MEMBERSHIP_IDENTITY_EIF_PATH=%q");
        expect(template).toContain("printf 'SONARI_NITRO_RUN_ENCLAVE_ARGS=%q");
        expect(template).toContain('[[ "$world_id_app_id" == app_staging_* ]]');
        expect(template).toContain("SONARI_DEV_MEMBERSHIP_STDIO_BRIDGE");
        expect(template).toContain("Sonari dev fixture World ID proxy placeholder");
        expect(template).not.toContain("SONARI_TEE_SIGNING_KEY_SEED=");
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
        expect(template).toContain("WatcherScheduleName:");
        expect(template).toContain("BatchScheduleName:");
        expect(template).toContain("WatcherLambdaName:");
        expect(template).toContain("ManualWatcherLambdaName:");
        expect(template).toContain("SubmitVerificationLambdaName:");
        expect(template).toContain("BatchVerifierLambdaName:");
        expect(template).toContain("RunnerControlLambdaName:");
        expect(template).not.toContain("SigningSeedCiphertextS3KeyOutput");
        expect(template).not.toContain("SigningSeedCiphertextS3BucketOutput");
    });
});
