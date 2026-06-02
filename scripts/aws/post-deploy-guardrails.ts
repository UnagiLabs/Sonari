import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import {
    assertAsgIdle,
    assertExpectedAccount,
    assertSchedulesDisabled,
    DEFAULT_EXPECTED_ACCOUNT,
    DEFAULT_REGION,
    DEFAULT_STACK,
    describeStack,
    ExecFileAwsCli,
    parseArgs,
    parseStackOutputs,
    parseStackParameters,
    readStringOption,
    requireOutput,
} from "./shared.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true) {
        process.stdout.write(
            "Usage: pnpm aws:post-deploy-guardrails -- [--stack <name>] [--expected-account <id>] [--region <region>] [--commit <sha>]\n",
        );
        return;
    }
    const stack = readStringOption(args, "stack", DEFAULT_STACK);
    const expectedAccount = readStringOption(args, "expected-account", DEFAULT_EXPECTED_ACCOUNT);
    const region = readStringOption(args, "region", DEFAULT_REGION);
    const expectedCommit = readStringOption(args, "commit", await gitHeadCommit());
    const aws = new ExecFileAwsCli(region);

    await assertExpectedAccount(aws, expectedAccount);
    const stackResponse = await describeStack(aws, stack);
    const outputs = parseStackOutputs(stackResponse);
    const parameters = parseStackParameters(stackResponse);

    if (outputs.DeployedGitCommitSha !== expectedCommit) {
        throw new Error(
            `DeployedGitCommitSha mismatch: expected ${expectedCommit}, got ${outputs.DeployedGitCommitSha ?? "<missing>"}`,
        );
    }

    await assertAsgIdle(aws, requireOutput(outputs, "RunnerAutoScalingGroupName"));
    await assertSchedulesDisabled(aws, outputs);
    await assertS3ObjectExists(aws, parameters.LambdaCodeS3Bucket, outputs.LambdaCodeS3KeyOutput);
    await assertS3ObjectExists(aws, parameters.TeeArtifactS3Bucket, outputs.TeeArtifactS3KeyOutput);
    await assertS3ObjectExists(
        aws,
        parameters.EarthquakeTeeEifS3Bucket,
        outputs.EarthquakeTeeEifS3KeyOutput,
    );
    await assertS3ObjectExists(
        aws,
        parameters.MembershipTeeArtifactS3Bucket,
        outputs.MembershipTeeArtifactS3KeyOutput,
    );
    await assertS3ObjectExists(aws, parameters.TeeEifS3Bucket, outputs.TeeEifS3KeyOutput);

    const lambdaCode = await aws.json([
        "lambda",
        "get-function",
        "--function-name",
        requireOutput(outputs, "RunnerControlLambdaName"),
    ]);

    process.stdout.write(
        `${JSON.stringify(
            {
                commit: expectedCommit,
                artifact_keys: {
                    lambda: outputs.LambdaCodeS3KeyOutput,
                    earthquake_tee: outputs.TeeArtifactS3KeyOutput,
                    earthquake_eif: outputs.EarthquakeTeeEifS3KeyOutput,
                    membership_tee: outputs.MembershipTeeArtifactS3KeyOutput,
                    membership_eif: outputs.TeeEifS3KeyOutput,
                },
                lambda_code: lambdaCode,
                idle: true,
                schedules_disabled: true,
            },
            null,
            2,
        )}\n`,
    );
}

async function assertS3ObjectExists(
    aws: ExecFileAwsCli,
    bucket: string | undefined,
    key: string | undefined,
): Promise<void> {
    if (bucket === undefined || key === undefined) {
        throw new Error("S3 artifact bucket and key are required");
    }
    await aws.json(["s3api", "head-object", "--bucket", bucket, "--key", key]);
}

async function gitHeadCommit(): Promise<string> {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
    return stdout.trim();
}

main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
