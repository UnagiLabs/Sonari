import process from "node:process";
import {
    assertExpectedAccount,
    DEFAULT_EXPECTED_ACCOUNT,
    DEFAULT_REGION,
    DEFAULT_STACK,
    describeAsg,
    describeStack,
    ExecFileAwsCli,
    getScheduleState,
    parseArgs,
    parseStackOutputs,
    readStringOption,
    requireOutput,
} from "./shared.js";

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true) {
        process.stdout.write(
            "Usage: pnpm aws:preflight -- [--stack <name>] [--expected-account <id>] [--region <region>] [--allow-non-dev-stack]\n",
        );
        return;
    }
    const stack = readStringOption(args, "stack", DEFAULT_STACK);
    const expectedAccount = readStringOption(args, "expected-account", DEFAULT_EXPECTED_ACCOUNT);
    const region = readStringOption(args, "region", DEFAULT_REGION);

    if (args["allow-non-dev-stack"] !== true && !stack.endsWith("-dev")) {
        throw new Error("preflight defaults to dev stacks; pass --allow-non-dev-stack explicitly");
    }

    const aws = new ExecFileAwsCli(region);
    const account = await assertExpectedAccount(aws, expectedAccount);
    const stackResponse = await describeStack(aws, stack);
    const outputs = parseStackOutputs(stackResponse);
    const asg = await describeAsg(aws, requireOutput(outputs, "RunnerAutoScalingGroupName"));
    const watcherSchedule = requireOutput(outputs, "WatcherScheduleName");
    const batchSchedule = requireOutput(outputs, "BatchScheduleName");

    process.stdout.write(
        `${JSON.stringify(
            {
                account,
                region,
                stack,
                deployed_commit: outputs.DeployedGitCommitSha ?? null,
                asg,
                schedules: {
                    [watcherSchedule]: await getScheduleState(aws, watcherSchedule),
                    [batchSchedule]: await getScheduleState(aws, batchSchedule),
                },
            },
            null,
            2,
        )}\n`,
    );
}

main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
