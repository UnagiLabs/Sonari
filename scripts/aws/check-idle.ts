import process from "node:process";
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
    readStringOption,
    requireOutput,
} from "./shared.js";

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true) {
        process.stdout.write(
            "Usage: pnpm aws:check-idle -- [--stack <name>] [--expected-account <id>] [--region <region>]\n",
        );
        return;
    }
    const stack = readStringOption(args, "stack", DEFAULT_STACK);
    const expectedAccount = readStringOption(args, "expected-account", DEFAULT_EXPECTED_ACCOUNT);
    const region = readStringOption(args, "region", DEFAULT_REGION);
    const aws = new ExecFileAwsCli(region);

    await assertExpectedAccount(aws, expectedAccount);
    const outputs = parseStackOutputs(await describeStack(aws, stack));
    await assertAsgIdle(aws, requireOutput(outputs, "RunnerAutoScalingGroupName"));
    await assertSchedulesDisabled(aws, outputs);
    process.stdout.write("AWS dev runner is idle: ASG desired 0, EC2 empty, schedules DISABLED\n");
}

main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
