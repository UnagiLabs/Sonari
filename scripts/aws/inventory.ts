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
    listPendingOrRunningAsgEc2Instances,
    parseArgs,
    parseStackOutputs,
    readStringOption,
    requireOutput,
} from "./shared.js";

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true) {
        process.stdout.write(
            "Usage: pnpm aws:inventory -- [--stack <name>] [--expected-account <id>] [--region <region>]\n",
        );
        return;
    }
    const stack = readStringOption(args, "stack", DEFAULT_STACK);
    const expectedAccount = readStringOption(args, "expected-account", DEFAULT_EXPECTED_ACCOUNT);
    const region = readStringOption(args, "region", DEFAULT_REGION);
    const aws = new ExecFileAwsCli(region);

    const account = await assertExpectedAccount(aws, expectedAccount);
    const stackResponse = await describeStack(aws, stack);
    const outputs = parseStackOutputs(stackResponse);
    const asgName = requireOutput(outputs, "RunnerAutoScalingGroupName");
    const watcherSchedule = requireOutput(outputs, "WatcherScheduleName");
    const batchSchedule = requireOutput(outputs, "BatchScheduleName");

    process.stdout.write(
        `${JSON.stringify(
            {
                account,
                region,
                stack,
                outputs,
                asg: await describeAsg(aws, asgName),
                pending_or_running_asg_ec2: await listPendingOrRunningAsgEc2Instances(aws, asgName),
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
