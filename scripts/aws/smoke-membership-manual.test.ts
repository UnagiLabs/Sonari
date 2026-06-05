import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AwsCli } from "./shared.js";
import { runSmokeMembershipManual } from "./smoke-membership-manual.js";

const STACK = "sonari-verifier-runner-dev";
const EXPECTED_ACCOUNT = "595103996064";
const STATE_MACHINE_ARN = "arn:aws:states:ap-northeast-1:595103996064:stateMachine:membership";
const LATEST_EXECUTION_ARN =
    "arn:aws:states:ap-northeast-1:595103996064:execution:membership:membership-exec-1";

describe("AWS membership manual batch smoke script", () => {
    it("invokes the batch lambda, lists executions, and reads the latest execution input", async () => {
        const cli = new RecordingAwsCli();

        const result = await runSmokeMembershipManual({
            aws: cli,
            stack: STACK,
            expectedAccount: EXPECTED_ACCOUNT,
        });

        expect(result).toMatchObject({
            batchVerifierLambdaName: "batch-verifier",
            stateMachineArn: STATE_MACHINE_ARN,
            workflowStarted: 2,
            latestExecution: {
                executionArn: LATEST_EXECUTION_ARN,
                verifierKind: "membership_identity",
                jobId: "job-abc",
            },
            job: null,
        });
        expect(result.executions).toEqual([
            { executionArn: LATEST_EXECUTION_ARN, name: "membership-exec-1", status: "RUNNING" },
        ]);

        const operations = cli.operations.map((operation) => operation.label);
        expect(operations).toEqual([
            "sts:get-caller-identity",
            "cloudformation:describe-stacks",
            "scheduler:get-schedule:watcher-schedule",
            "scheduler:get-schedule:batch-schedule",
            "lambda:invoke",
            "stepfunctions:list-executions",
            "stepfunctions:describe-execution",
        ]);
        expect(operations).not.toContain("dynamodb:get-item");
    });

    it("invokes the batch lambda with the membership_identity verifier_kind payload", async () => {
        const cli = new RecordingAwsCli();

        await runSmokeMembershipManual({
            aws: cli,
            stack: STACK,
            expectedAccount: EXPECTED_ACCOUNT,
        });

        expect(cli.invokeFunctionNames).toEqual(["batch-verifier"]);
        expect(cli.lambdaPayloads).toEqual([{ verifier_kind: "membership_identity" }]);
    });

    it("reads the target job status when a job id is given", async () => {
        const cli = new RecordingAwsCli();

        const result = await runSmokeMembershipManual({
            aws: cli,
            stack: STACK,
            expectedAccount: EXPECTED_ACCOUNT,
            jobId: "job-abc",
        });

        expect(result.job).toEqual({
            jobId: "job-abc",
            status: "processing",
            workflowExecutionName: "membership-exec-1",
            retryCount: 0,
        });
        expect(cli.getItemKeys).toEqual([{ job_id: { S: "job-abc" } }]);
        expect(cli.operations.map((operation) => operation.label)).toContain("dynamodb:get-item");
    });

    it("skips describe-execution when no executions exist yet", async () => {
        const cli = new RecordingAwsCli({ executionsEmpty: true });

        const result = await runSmokeMembershipManual({
            aws: cli,
            stack: STACK,
            expectedAccount: EXPECTED_ACCOUNT,
        });

        expect(result.executions).toEqual([]);
        expect(result.latestExecution).toBeNull();
        expect(cli.operations.map((operation) => operation.label)).not.toContain(
            "stepfunctions:describe-execution",
        );
    });

    it("fails closed when the AWS account does not match", async () => {
        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ account: "111111111111" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
            }),
        ).rejects.toThrow("AWS account mismatch");
    });

    it("fails closed when the batch schedule is not DISABLED", async () => {
        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ scheduleState: "ENABLED" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
            }),
        ).rejects.toThrow("must be DISABLED");
    });

    it("fails closed when a required stack output is missing", async () => {
        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ omitOutput: "BatchVerifierLambdaName" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
            }),
        ).rejects.toThrow("CloudFormation output BatchVerifierLambdaName is required");
    });

    it("fails closed when the batch lambda reports a FunctionError", async () => {
        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ functionError: true }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
            }),
        ).rejects.toThrow("BatchVerifier Lambda invocation failed");
    });
});

type RecordingAwsCliOptions = {
    account?: string;
    scheduleState?: string;
    omitOutput?: string;
    functionError?: boolean;
    executionsEmpty?: boolean;
    workflowStarted?: number;
};

class RecordingAwsCli implements AwsCli {
    readonly operations: Array<{ label: string; args: readonly string[] }> = [];
    readonly lambdaPayloads: unknown[] = [];
    readonly invokeFunctionNames: string[] = [];
    readonly getItemKeys: unknown[] = [];

    constructor(private readonly options: RecordingAwsCliOptions = {}) {}

    async json(args: readonly string[]): Promise<unknown> {
        const label = this.label(args);
        this.operations.push({ label, args });

        switch (label) {
            case "sts:get-caller-identity":
                return { Account: this.options.account ?? "595103996064" };
            case "cloudformation:describe-stacks":
                return stackResponse(this.options.omitOutput);
            case "scheduler:get-schedule:watcher-schedule":
            case "scheduler:get-schedule:batch-schedule":
                return { State: this.options.scheduleState ?? "DISABLED" };
            case "lambda:invoke": {
                this.invokeFunctionNames.push(args[args.indexOf("--function-name") + 1] ?? "");
                const payload = args[args.indexOf("--payload") + 1];
                this.lambdaPayloads.push(JSON.parse(payload ?? "{}") as unknown);
                const responsePath = args.at(-1);
                if (responsePath === undefined) {
                    throw new Error("lambda invoke response path missing");
                }
                await writeFile(
                    responsePath,
                    JSON.stringify({ workflow_started: this.options.workflowStarted ?? 2 }),
                );
                return this.options.functionError
                    ? { StatusCode: 200, FunctionError: "Unhandled" }
                    : { StatusCode: 200 };
            }
            case "stepfunctions:list-executions":
                return this.options.executionsEmpty === true
                    ? { executions: [] }
                    : {
                          executions: [
                              {
                                  executionArn: LATEST_EXECUTION_ARN,
                                  name: "membership-exec-1",
                                  status: "RUNNING",
                                  startDate: "2026-06-05T00:00:00.000Z",
                              },
                          ],
                      };
            case "stepfunctions:describe-execution":
                return {
                    executionArn: LATEST_EXECUTION_ARN,
                    status: "RUNNING",
                    input: JSON.stringify({
                        verifier_kind: "membership_identity",
                        job_id: "job-abc",
                        attempt: 1,
                    }),
                };
            case "dynamodb:get-item": {
                const key = args[args.indexOf("--key") + 1];
                this.getItemKeys.push(JSON.parse(key ?? "{}") as unknown);
                return {
                    Item: {
                        job_id: { S: "job-abc" },
                        status: { S: "processing" },
                        workflow_execution_name: { S: "membership-exec-1" },
                        retry_count: { N: "0" },
                    },
                };
            }
            default:
                throw new Error(`unexpected AWS call: ${label}`);
        }
    }

    private label(args: readonly string[]): string {
        const service = args[0];
        const operation = args[1];
        if (service === "sts" && operation === "get-caller-identity") {
            return "sts:get-caller-identity";
        }
        if (service === "cloudformation" && operation === "describe-stacks") {
            return "cloudformation:describe-stacks";
        }
        if (service === "scheduler" && operation === "get-schedule") {
            return `scheduler:get-schedule:${args[args.indexOf("--name") + 1]}`;
        }
        if (service === "lambda" && operation === "invoke") {
            return "lambda:invoke";
        }
        if (service === "stepfunctions" && operation === "list-executions") {
            return "stepfunctions:list-executions";
        }
        if (service === "stepfunctions" && operation === "describe-execution") {
            return "stepfunctions:describe-execution";
        }
        if (service === "dynamodb" && operation === "get-item") {
            return "dynamodb:get-item";
        }
        return `${service}:${operation}`;
    }
}

function stackResponse(omitOutput?: string): unknown {
    const outputs = [
        { OutputKey: "BatchVerifierLambdaName", OutputValue: "batch-verifier" },
        { OutputKey: "MembershipRunnerStateMachineArn", OutputValue: STATE_MACHINE_ARN },
        { OutputKey: "VerificationJobsTableName", OutputValue: "verification-jobs" },
        { OutputKey: "WatcherScheduleName", OutputValue: "watcher-schedule" },
        { OutputKey: "BatchScheduleName", OutputValue: "batch-schedule" },
    ].filter((output) => output.OutputKey !== omitOutput);
    return {
        Stacks: [
            {
                StackName: STACK,
                StackStatus: "UPDATE_COMPLETE",
                Outputs: outputs,
            },
        ],
    };
}
