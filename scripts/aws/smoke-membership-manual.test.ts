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
                status: "RUNNING",
                verifierKind: "membership_identity",
                jobId: "job-abc",
                registrationMetadata: {
                    verifierConfigKey: 2,
                    verifierConfigVersion: 1,
                    enclaveInstancePublicKey: `0x${"cc".repeat(32)}`,
                },
                teeResult: {
                    status: "verified",
                    payloadBcsHex: "0x010203",
                    signature: `0x${"11".repeat(64)}`,
                    publicKey: `0x${"22".repeat(32)}`,
                },
                suiSubmission: {
                    status: "succeeded",
                    txDigest: "tx-submit-abc",
                    readback: {
                        objectId: `0x${"55".repeat(32)}`,
                        identityVerified: true,
                        identityProviderMask: 2,
                        identityVerifiedAtMs: 1_800_000_000_000,
                        identityExpiresAtMs: 1_800_000_000_001,
                        termsVersion: 1,
                        signedStatementHash: `0x${"44".repeat(32)}`,
                    },
                },
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
            "stepfunctions:get-execution-history",
        ]);
        expect(operations).not.toContain("dynamodb:get-item");
    });

    it("summarizes non-verified TEE results without signature fields", async () => {
        const result = await runSmokeMembershipManual({
            aws: new RecordingAwsCli({ teeStatus: "pending_source" }),
            stack: STACK,
            expectedAccount: EXPECTED_ACCOUNT,
        });

        expect(result.latestExecution?.teeResult).toEqual({
            status: "pending_source",
            errorCode: "WORLD_ID_API_UNAVAILABLE",
        });
        expect(JSON.stringify(result.latestExecution?.teeResult)).not.toContain("signature");
        expect(JSON.stringify(result.latestExecution?.teeResult)).not.toContain("publicKey");
    });

    it("paginates execution history until registration metadata and TEE result are found", async () => {
        const cli = new RecordingAwsCli({ paginatedHistory: true });

        const result = await runSmokeMembershipManual({
            aws: cli,
            stack: STACK,
            expectedAccount: EXPECTED_ACCOUNT,
        });

        expect(result.latestExecution?.registrationMetadata).toMatchObject({
            verifierConfigKey: 2,
        });
        expect(result.latestExecution?.teeResult).toMatchObject({
            status: "verified",
            payloadBcsHex: "0x010203",
        });
        expect(result.latestExecution?.suiSubmission).toMatchObject({
            status: "succeeded",
            txDigest: "tx-submit-abc",
        });
        expect(cli.historyNextTokens).toEqual([null, "page-2"]);
    });

    it("fails closed when execution history pagination does not advance", async () => {
        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ stuckHistoryToken: true }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
            }),
        ).rejects.toThrow("Step Functions execution history pagination did not advance");
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
            errorCode: "WORLD_ID_API_UNAVAILABLE",
            errorMessage: "waiting for World ID",
            txDigest: "tee-result:abc123",
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
    teeStatus?: "verified" | "pending_source";
    paginatedHistory?: boolean;
    stuckHistoryToken?: boolean;
};

class RecordingAwsCli implements AwsCli {
    readonly operations: Array<{ label: string; args: readonly string[] }> = [];
    readonly lambdaPayloads: unknown[] = [];
    readonly invokeFunctionNames: string[] = [];
    readonly getItemKeys: unknown[] = [];
    readonly historyNextTokens: Array<string | null> = [];

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
            case "stepfunctions:get-execution-history":
                return this.executionHistory(args);
            case "dynamodb:get-item": {
                const key = args[args.indexOf("--key") + 1];
                this.getItemKeys.push(JSON.parse(key ?? "{}") as unknown);
                return {
                    Item: {
                        job_id: { S: "job-abc" },
                        status: { S: "processing" },
                        workflow_execution_name: { S: "membership-exec-1" },
                        retry_count: { N: "0" },
                        error_code: { S: "WORLD_ID_API_UNAVAILABLE" },
                        error_message: { S: "waiting for World ID" },
                        tx_digest: { S: "tee-result:abc123" },
                    },
                };
            }
            default:
                throw new Error(`unexpected AWS call: ${label}`);
        }
    }

    private executionHistory(args: readonly string[]): unknown {
        const nextToken = readArg(args, "--next-token");
        this.historyNextTokens.push(nextToken);
        if (this.options.stuckHistoryToken === true) {
            return { events: [], nextToken: "same-token" };
        }
        if (this.options.paginatedHistory !== true) {
            return executionHistory(this.options.teeStatus ?? "verified");
        }
        if (nextToken === null) {
            return { events: fillerHistoryEvents(), nextToken: "page-2" };
        }
        return executionHistory(this.options.teeStatus ?? "verified");
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
        if (service === "stepfunctions" && operation === "get-execution-history") {
            return "stepfunctions:get-execution-history";
        }
        if (service === "dynamodb" && operation === "get-item") {
            return "dynamodb:get-item";
        }
        return `${service}:${operation}`;
    }
}

function readArg(args: readonly string[], name: string): string | null {
    const index = args.indexOf(name);
    return index === -1 ? null : (args[index + 1] ?? null);
}

function fillerHistoryEvents(): unknown[] {
    return Array.from({ length: 100 }, (_, index) => ({
        type: "TaskStateExited",
        stateExitedEventDetails: {
            name: `Filler${index}`,
            output: "{}",
        },
    }));
}

function executionHistory(teeStatus: "verified" | "pending_source"): unknown {
    const registrationOutput = {
        registration_result: {
            registration_metadata: {
                verifier_config_key: 2,
                verifier_config_version: 1,
                enclave_instance_public_key: `0x${"cc".repeat(32)}`,
            },
        },
    };
    const result =
        teeStatus === "verified"
            ? {
                  status: "verified",
                  payload_bcs_hex: "0x010203",
                  signature: `0x${"11".repeat(64)}`,
                  public_key: `0x${"22".repeat(32)}`,
              }
            : {
                  status: "pending_source",
                  error_code: "WORLD_ID_API_UNAVAILABLE",
              };
    const submitOutput = {
        sui_submission: "succeeded",
        tx_digest: "tx-submit-abc",
        readback: {
            objectId: `0x${"55".repeat(32)}`,
            identityVerified: true,
            identityProviderMask: 2,
            identityVerifiedAtMs: 1_800_000_000_000,
            identityExpiresAtMs: 1_800_000_000_001,
            termsVersion: 1,
            signedStatementHash: `0x${"44".repeat(32)}`,
        },
    };
    return {
        events: [
            {
                type: "TaskStateExited",
                stateExitedEventDetails: {
                    name: "RegisterEnclaveInstance",
                    output: JSON.stringify(registrationOutput),
                },
            },
            {
                type: "TaskStateExited",
                stateExitedEventDetails: {
                    name: "ReadResult",
                    output: JSON.stringify({ result }),
                },
            },
            ...(teeStatus === "verified"
                ? [
                      {
                          type: "TaskStateExited",
                          stateExitedEventDetails: {
                              name: "SubmitSuiSubmission",
                              output: JSON.stringify(submitOutput),
                          },
                      },
                  ]
                : []),
        ],
    };
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
