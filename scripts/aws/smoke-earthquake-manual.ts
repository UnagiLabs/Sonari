import process from "node:process";
import {
    assertExpectedAccount,
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

const DEFAULT_SOURCE_EVENT_ID = "us6000m0xl";

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true) {
        process.stdout.write(
            "Usage: pnpm aws:smoke:earthquake-manual -- [--stack <name>] [--expected-account <id>] [--region <region>] [--source-event-id <id>] [--token <token>]\n",
        );
        return;
    }
    const stack = readStringOption(args, "stack", DEFAULT_STACK);
    const expectedAccount = readStringOption(args, "expected-account", DEFAULT_EXPECTED_ACCOUNT);
    const region = readStringOption(args, "region", DEFAULT_REGION);
    const sourceEventId = readStringOption(args, "source-event-id", DEFAULT_SOURCE_EVENT_ID);
    const token = readStringOption(args, "token", process.env.MANUAL_SUBMIT_TOKEN ?? "");
    if (token.length === 0) {
        throw new Error("MANUAL_SUBMIT_TOKEN or --token is required for manual watcher smoke");
    }

    const aws = new ExecFileAwsCli(region);
    await assertExpectedAccount(aws, expectedAccount);
    const outputs = parseStackOutputs(await describeStack(aws, stack));
    const manualLambda = requireOutput(outputs, "ManualWatcherLambdaName");
    const functionUrl = await getFunctionUrl(aws, manualLambda);

    process.stderr.write(
        "Relayer submit behavior depends on the deployed stack RelayerMode/RelayerTarget configuration.\n",
    );
    const response = await fetch(functionUrl, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({ source_event_id: sourceEventId }),
    });
    const body = await response.text();
    if (!response.ok) {
        throw new Error(`Manual watcher returned HTTP ${response.status}: ${body}`);
    }

    const executions = await aws.json([
        "stepfunctions",
        "list-executions",
        "--state-machine-arn",
        requireOutput(outputs, "EarthquakeRunnerStateMachineArn"),
        "--max-results",
        "5",
    ]);
    const row = await aws.json([
        "dynamodb",
        "get-item",
        "--table-name",
        requireOutput(outputs, "EventsTableName"),
        "--key",
        JSON.stringify({ source_event_id: { S: sourceEventId } }),
    ]);
    const item = isRecord(row) && isRecord(row.Item) ? row.Item : {};
    const sourceArchiveSummary = {
        source_archive_status: readDynamoString(item, "source_archive_status"),
        source_archive_error_code: readDynamoString(item, "source_archive_error_code"),
        relayer_status: readDynamoString(item, "relayer_status"),
        relayer_mode: readDynamoString(item, "relayer_mode"),
        relayer_digest: readDynamoString(item, "relayer_digest"),
        disaster_event_object_id: readDynamoString(item, "disaster_event_object_id"),
    };

    process.stdout.write(
        `${JSON.stringify(
            {
                manual_response: JSON.parse(body) as unknown,
                source_archive_summary: sourceArchiveSummary,
                executions,
                row,
            },
            null,
            2,
        )}\n`,
    );
}

async function getFunctionUrl(aws: ExecFileAwsCli, functionName: string): Promise<string> {
    const response = await aws.json([
        "lambda",
        "get-function-url-config",
        "--function-name",
        functionName,
    ]);
    if (!isRecord(response) || typeof response.FunctionUrl !== "string") {
        throw new Error(`Unable to read Lambda function URL for ${functionName}`);
    }
    return response.FunctionUrl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDynamoString(item: Record<string, unknown>, key: string): string | null {
    const value = item[key];
    if (!isRecord(value)) {
        return null;
    }
    const stringValue = value.S;
    return typeof stringValue === "string" && stringValue.length > 0 ? stringValue : null;
}

main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
