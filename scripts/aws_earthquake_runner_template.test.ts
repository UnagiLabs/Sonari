import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const templatePath = path.join(process.cwd(), "infra/aws/earthquake-runner/template.yaml");

describe("AWS earthquake runner CloudFormation template", () => {
    it("does not expose a public HTTP runner surface", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).not.toContain("AWS::ElasticLoadBalancingV2::LoadBalancer");
        expect(template).not.toContain("AWS::ElasticLoadBalancingV2::Listener");
        expect(template).not.toContain("AWS::ElasticLoadBalancingV2::TargetGroup");
        expect(template).not.toContain("sonari-earthquake-runner.service");
        expect(template).not.toContain("ToPort: 8789");
    });

    it("makes runner secret files readable by ec2-user only", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain(
            "chown ec2-user:ec2-user /opt/sonari/runner-token /opt/sonari/tee-signing-key /opt/sonari/walrus-client-config.yaml /opt/sonari/sui_config.yaml /opt/sonari/sui.keystore",
        );
        expect(template).toContain(
            "chmod 0400 /opt/sonari/runner-token /opt/sonari/tee-signing-key /opt/sonari/walrus-client-config.yaml /opt/sonari/sui_config.yaml /opt/sonari/sui.keystore",
        );
    });

    it("injects production runner command and Walrus aggregator configuration", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("NitroEnclaveProcessCommand:");
        expect(template).toContain("Default: /opt/sonari/tee-artifact/bin/tee production");
        expect(template).toContain(
            "Command that reads WorkerToTeeRequest JSON from stdin and writes TeeCoreResult JSON to stdout.",
        );
        expect(template).toContain("WalrusAggregatorUrl:");
        expect(template).toContain("nitro_enclave_process_command=$(cat <<'SONARI_COMMAND'");
        expect(template).toContain(`$${"{NitroEnclaveProcessCommand}"}`);
        expect(template).toContain(
            "printf 'NITRO_ENCLAVE_PROCESS_COMMAND=%q\\n' \"$nitro_enclave_process_command\"",
        );
        expect(template).toContain(
            "printf 'SONARI_WALRUS_AGGREGATOR_URL=%q\\n' \"$walrus_aggregator_url\"",
        );
        expect(template).not.toContain(
            `NITRO_ENCLAVE_PROCESS_COMMAND='$${"{NitroEnclaveProcessCommand}"}'`,
        );
        expect(template).not.toContain(
            `NITRO_ENCLAVE_PROCESS_COMMAND=$${"{NitroEnclaveProcessCommand}"}`,
        );
    });

    it("requires a checksum-pinned S3 TEE artifact for development bootstrap", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("TeeArtifactS3Bucket:");
        expect(template).toContain("TeeArtifactS3Key:");
        expect(template).toContain("TeeArtifactSha256:");
        expect(template).toContain("SHA-256 hex digest for the development TEE artifact tar.gz.");
        expect(template).toContain("aws s3 cp");
        expect(template).toContain(`s3://$${"{TeeArtifactS3Bucket}"}/$${"{TeeArtifactS3Key}"}`);
        expect(template).toContain(
            `printf '%s  %s\\n' '$${"{TeeArtifactSha256}"}' "$tee_artifact_archive" | sha256sum -c -`,
        );
        expect(template).toContain('tar -xzf "$tee_artifact_archive" -C /opt/sonari/tee-artifact');
        expect(template).toContain("test -x /opt/sonari/tee-artifact/bin/tee");
        expect(template).toContain("test -x /opt/sonari/tee-artifact/bin/walrus");
    });

    it("places Sui wallet files and exports Walrus CLI runtime configuration", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("SuiWalletConfigSecretArn:");
        expect(template).toContain("SuiKeystoreSecretArn:");
        expect(template).toContain("WalrusContext:");
        expect(template).toContain("Default: testnet");
        expect(template).toContain(
            `aws secretsmanager get-secret-value --secret-id '$${"{WalrusConfigSecretArn}"}' --query SecretString --output text > /opt/sonari/walrus-client-config.yaml`,
        );
        expect(template).toContain(
            `aws secretsmanager get-secret-value --secret-id '$${"{SuiWalletConfigSecretArn}"}' --query SecretString --output text > /opt/sonari/sui_config.yaml`,
        );
        expect(template).toContain(
            `aws secretsmanager get-secret-value --secret-id '$${"{SuiKeystoreSecretArn}"}' --query SecretString --output text > /opt/sonari/sui.keystore`,
        );
        expect(template).toContain('echo "SONARI_WALRUS_CLI=/opt/sonari/tee-artifact/bin/walrus"');
        expect(template).toContain(
            'echo "SONARI_WALRUS_CONFIG=/opt/sonari/walrus-client-config.yaml"',
        );
        expect(template).toContain('echo "SONARI_WALRUS_WALLET=/opt/sonari/sui_config.yaml"');
        expect(template).toContain("walrus_context=$(cat <<'SONARI_WALRUS_CONTEXT'");
        expect(template).toContain(`$${"{WalrusContext}"}`);
        expect(template).toContain("printf 'SONARI_WALRUS_CONTEXT=%q\\n' \"$walrus_context\"");
        expect(template).not.toContain('echo "SONARI_WALRUS_CONTEXT=testnet"');
        expect(template).toContain('echo "SONARI_WALRUS_EPOCHS=2"');
    });

    it("allows the runner instance role to read exactly the configured TEE artifact object", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("Action: s3:GetObject");
        expect(template).toContain(
            `Resource: !Sub arn:$${"{AWS::Partition}"}:s3:::$${"{TeeArtifactS3Bucket}"}/$${"{TeeArtifactS3Key}"}`,
        );
    });

    it("marks runner bootstrap completion only after required files and allocator are ready", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("systemctl is-active --quiet nitro-enclaves-allocator.service");
        expect(template).toContain("touch /opt/sonari/bootstrap-complete");
        expect(template.indexOf("touch /opt/sonari/bootstrap-complete")).toBeGreaterThan(
            template.indexOf("chmod 0400 /opt/sonari/runner.env"),
        );
        expect(template.indexOf("touch /opt/sonari/bootstrap-complete")).toBeGreaterThan(
            template.indexOf("test -x /opt/sonari/tee-artifact/bin/tee"),
        );
    });

    it("keeps EC2 capacity at zero until the Step Functions workflow starts a job", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain('MinSize: "0"');
        expect(template).toContain('MaxSize: "1"');
        expect(template).toContain('DesiredCapacity: "0"');
    });

    it("exposes deployment metadata and resource names as stack outputs", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("GitCommitSha:");
        expect(template).toContain("Default: unknown");
        expect(template).toContain("Description: Git commit SHA deployed by this stack update.");

        expect(template).toContain("DeployedGitCommitSha:");
        expect(template).toContain("Value: !Ref GitCommitSha");
        expect(template).toContain("LambdaCodeS3KeyOutput:");
        expect(template).toContain("Value: !Ref LambdaCodeS3Key");
        expect(template).toContain("TeeArtifactS3KeyOutput:");
        expect(template).toContain("Value: !Ref TeeArtifactS3Key");
        expect(template).toContain("TeeArtifactSha256Output:");
        expect(template).toContain("Value: !Ref TeeArtifactSha256");
        expect(template).toContain("RunnerAutoScalingGroupName:");
        expect(template).toContain("Value: !Ref RunnerAutoScalingGroup");
        expect(template).toContain("WatcherScheduleName:");
        expect(template).toContain("Value: !Ref WatcherSchedule");
        expect(template).toContain("WatcherLambdaName:");
        expect(template).toContain("Value: !Ref WatcherLambda");
        expect(template).toContain("ManualWatcherLambdaName:");
        expect(template).toContain("Value: !Ref ManualWatcherLambda");
        expect(template).toContain("RunnerControlLambdaName:");
        expect(template).toContain("Value: !Ref RunnerControlLambda");

        expect(template).toContain("S3Bucket: !Ref LambdaCodeS3Bucket");
        expect(template).toContain("S3Key: !Ref LambdaCodeS3Key");
    });

    it("defines AWS-only orchestration resources", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("AWS::DynamoDB::Table");
        expect(template).toContain("AWS::S3::Bucket");
        expect(template).toContain("AWS::Lambda::Function");
        expect(template).toContain("AWS::StepFunctions::StateMachine");
        expect(template).toContain("AWS::Scheduler::Schedule");
        expect(template).toContain("AWS::Lambda::Url");
        expect(template).toContain("ssm:SendCommand");
        expect(template).toContain("autoscaling:SetDesiredCapacity");
    });

    it("grants both permissions required for public Lambda Function URL invocation", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("ManualWatcherFunctionUrlPermission:");
        expect(template).toContain("Action: lambda:InvokeFunctionUrl");
        expect(template).toContain("FunctionUrlAuthType: NONE");
        expect(template).toContain("ManualWatcherFunctionInvokeUrlPermission:");
        expect(template).toContain("Action: lambda:InvokeFunction");
        expect(template).toContain("InvokedViaFunctionUrl: true");
    });

    it("points Lambda handlers at the TypeScript dist/src emit layout", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain("Handler: dist/src/lambda.scheduledHandler");
        expect(template).toContain("Handler: dist/src/lambda.manualHandler");
        expect(template).toContain("Handler: dist/src/runner_workflow.handler");
        expect(template).not.toContain("Handler: dist/lambda.scheduledHandler");
        expect(template).not.toContain("Handler: dist/lambda.manualHandler");
        expect(template).not.toContain("Handler: dist/runner_workflow.handler");
    });

    it("retries transient PollCommand Lambda or SSM lookup failures before failing the workflow", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain('"PollCommand": {');
        expect(template).toContain(
            '"Retry": [{ "ErrorEquals": ["States.ALL"], "IntervalSeconds": 5, "MaxAttempts": 3, "BackoffRate": 2.0 }]',
        );
    });

    it("retries FindReadyInstance long enough for cold bootstrap readiness", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain('"FindReadyInstance": {');
        expect(template).toContain(
            '"Retry": [{ "ErrorEquals": ["States.ALL"], "IntervalSeconds": 30, "MaxAttempts": 20, "BackoffRate": 1.0 }]',
        );
    });

    it("retries and records failure when StartInstance cannot scale runner capacity", async () => {
        const template = await readFile(templatePath, "utf8");
        const startInstanceBlock = template.slice(
            template.indexOf('"StartInstance": {'),
            template.indexOf('"WaitForInstance": {'),
        );

        expect(startInstanceBlock).toContain(
            '"Retry": [{ "ErrorEquals": ["States.ALL"], "IntervalSeconds": 30, "MaxAttempts": 3, "BackoffRate": 2.0 }]',
        );
        expect(startInstanceBlock).toContain(
            '"Catch": [{ "ErrorEquals": ["States.ALL"], "ResultPath": "$.error", "Next": "MarkFailed" }]',
        );
    });

    it("retries runner cleanup and fails explicitly when StopInstance cannot complete", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain('"StopInstance": {');
        expect(template).toContain(
            '"Retry": [{ "ErrorEquals": ["States.ALL"], "IntervalSeconds": 30, "MaxAttempts": 8, "BackoffRate": 2.0 }]',
        );
        expect(template).toContain(
            '"Catch": [{ "ErrorEquals": ["States.ALL"], "ResultPath": "$.stop_error", "Next": "StopInstanceFailed" }]',
        );
        expect(template).toContain('"StopInstanceFailed": {');
        expect(template).toContain('"Type": "Fail"');
        expect(template).toContain('"Error": "StopInstanceFailed"');
        expect(template).toContain('"Cause": "Runner cleanup failed after retrying StopInstance"');
    });

    it("times out SSM command polling after 30 minutes", async () => {
        const template = await readFile(templatePath, "utf8");

        expect(template).toContain('"command_poll_count": 0');
        expect(template).toContain('"command_poll_count.$": "$.command_poll_count"');
        expect(template).toContain(
            '{ "Variable": "$.command_poll_count", "NumericGreaterThanEquals": 60, "Next": "MarkCommandPollingTimedOut" }',
        );
        expect(template).toContain('"error_code": "AWS_RUNNER_TIMEOUT"');
        expect(template).toContain('"message": "SSM command polling exceeded 30 minutes"');
    });

    it("passes the workflow attempt to every runner control task", async () => {
        const template = await readFile(templatePath, "utf8");
        const runnerTaskCount =
            template.match(/"Resource": "\$\{RunnerControlLambda\.Arn\}"/g)?.length ?? 0;
        const attemptParameterCount =
            template.match(/"Parameters": \{[^}]*"attempt\.\$": "\$\.attempt"/g)?.length ?? 0;

        expect(runnerTaskCount).toBeGreaterThan(0);
        expect(attemptParameterCount).toBe(runnerTaskCount);
    });
});
