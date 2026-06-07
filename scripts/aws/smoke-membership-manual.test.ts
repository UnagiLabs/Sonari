import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AwsCli } from "./shared.js";
import { runSmokeMembershipManual } from "./smoke-membership-manual.js";

const STACK = "sonari-verifier-runner-dev";
const EXPECTED_ACCOUNT = "595103996064";
const STATE_MACHINE_ARN = "arn:aws:states:ap-northeast-1:595103996064:stateMachine:membership";
const MATCHED_EXECUTION_ARN =
    "arn:aws:states:ap-northeast-1:595103996064:execution:membership:membership-job-abc-1";
const FIXED_NOW_MS = 1_800_000_000_000;
const REQUEST_TEMPLATE = {
    registry_id: `0x${"22".repeat(32)}`,
    membership_id: `0x${"66".repeat(32)}`,
    owner: `0x${"77".repeat(32)}`,
    provider: "world_id",
    terms_version: 2,
    signed_statement_hash: `0x${"44".repeat(32)}`,
    world_id: {
        world_app_id: "app_staging_123",
        nullifier_hash: "12345678901234567890",
        merkle_root: "987654321",
        proof: "0xproof",
        verification_level: "orb",
        action: "sonari_membership_register_v1",
        signal_hash: `0x${"55".repeat(32)}`,
    },
} as const;

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirs.splice(0).map(async (directory) => {
            await import("node:fs/promises").then(({ rm }) =>
                rm(directory, { recursive: true, force: true }),
            );
        }),
    );
});

describe("AWS membership manual batch smoke script", () => {
    it("submits a uniqueized request, triggers batch, and tracks the matching execution", async () => {
        const cli = new RecordingAwsCli();
        const requestFile = await createRequestFile();

        const result = await runSmokeMembershipManual({
            aws: cli,
            stack: STACK,
            expectedAccount: EXPECTED_ACCOUNT,
            requestFile,
            now: () => FIXED_NOW_MS,
        });

        expect(result).toMatchObject({
            submitVerificationLambdaName: "submit-verification",
            batchVerifierLambdaName: "batch-verifier",
            stateMachineArn: STATE_MACHINE_ARN,
            runnerAutoScalingGroupName: "runner-asg",
            requestFile,
            submitResponse: {
                statusCode: 202,
                jobId: "job-abc",
                status: "queued",
                duplicate: false,
                txDigest: null,
            },
            workflowStarted: 1,
            job: {
                jobId: "job-abc",
                status: "completed",
                workflowExecutionName: "membership-job-abc-1",
                retryCount: 0,
                errorCode: null,
                errorMessage: null,
                txDigest: "tx-submit-abc",
            },
            matchedExecution: {
                executionArn: MATCHED_EXECUTION_ARN,
                status: "SUCCEEDED",
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
                        identityVerifiedAtMs: FIXED_NOW_MS,
                        identityExpiresAtMs: FIXED_NOW_MS + 1,
                        termsVersion: 1,
                        signedStatementHash: `0x${"44".repeat(32)}`,
                    },
                },
            },
            idleVerified: true,
        });
        expect(result.executions).toEqual([
            {
                executionArn: MATCHED_EXECUTION_ARN,
                name: "membership-job-abc-1",
                status: "SUCCEEDED",
            },
        ]);

        expect(cli.invokeFunctionNames).toEqual(["submit-verification", "batch-verifier"]);
        expect(cli.submitBodies).toHaveLength(1);
        expect(cli.submitBodies[0]).toMatchObject({
            world_id: {
                nullifier_hash: `${REQUEST_TEMPLATE.world_id.nullifier_hash}${FIXED_NOW_MS}`,
            },
        });
        expect(cli.lambdaPayloads).toEqual([
            {
                body: JSON.stringify({
                    ...REQUEST_TEMPLATE,
                    world_id: {
                        ...REQUEST_TEMPLATE.world_id,
                        nullifier_hash: `${REQUEST_TEMPLATE.world_id.nullifier_hash}${FIXED_NOW_MS}`,
                    },
                }),
            },
            { verifier_kind: "membership_identity" },
        ]);
        expect(cli.getItemKeys).toEqual([
            { job_id: { S: "job-abc" } },
            { job_id: { S: "job-abc" } },
        ]);
        expect(cli.operations.map((operation) => operation.label)).toEqual([
            "sts:get-caller-identity",
            "cloudformation:describe-stacks",
            "scheduler:get-schedule:watcher-schedule",
            "scheduler:get-schedule:batch-schedule",
            "lambda:invoke:submit-verification",
            "lambda:invoke:batch-verifier",
            "dynamodb:get-item",
            "dynamodb:get-item",
            "stepfunctions:list-executions",
            "stepfunctions:describe-execution",
            "stepfunctions:get-execution-history",
            "autoscaling:describe-auto-scaling-groups",
            "ec2:describe-instances",
        ]);
    });

    it("polls the idle assertion until the runner ASG finishes draining", async () => {
        const cli = new RecordingAwsCli({ asgBusyCalls: 2 });
        const requestFile = await createRequestFile();

        const result = await runSmokeMembershipManual({
            aws: cli,
            stack: STACK,
            expectedAccount: EXPECTED_ACCOUNT,
            requestFile,
            now: () => FIXED_NOW_MS,
            poll: { intervalMs: 1, timeoutMs: 5_000 },
        });

        expect(result.idleVerified).toBe(true);
        const asgDescribes = cli.operations.filter(
            (op) => op.label === "autoscaling:describe-auto-scaling-groups",
        );
        // Two draining reports, then idle: the smoke must have re-polled.
        expect(asgDescribes.length).toBeGreaterThanOrEqual(3);
    });

    it("fails closed when the TEE result never reaches the happy path", async () => {
        const requestFile = await createRequestFile();

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ teeStatus: "pending_source" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
                poll: { intervalMs: 1, timeoutMs: 5 },
            }),
        ).rejects.toThrow("did not become ready");
    });

    it("paginates execution history until registration metadata and TEE result are found", async () => {
        const cli = new RecordingAwsCli({ paginatedHistory: true });
        const requestFile = await createRequestFile();

        const result = await runSmokeMembershipManual({
            aws: cli,
            stack: STACK,
            expectedAccount: EXPECTED_ACCOUNT,
            requestFile,
            now: () => FIXED_NOW_MS,
        });

        expect(result.matchedExecution.registrationMetadata).toMatchObject({
            verifierConfigKey: 2,
        });
        expect(result.matchedExecution.teeResult).toMatchObject({
            status: "verified",
            payloadBcsHex: "0x010203",
        });
        expect(result.matchedExecution.suiSubmission).toMatchObject({
            status: "succeeded",
            txDigest: "tx-submit-abc",
        });
        expect(cli.historyNextTokens).toEqual([null, "page-2"]);
    });

    it("fails closed when submit returns duplicate=true", async () => {
        const requestFile = await createRequestFile();

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ submitDuplicate: true }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
            }),
        ).rejects.toThrow("duplicate=true");
    });

    it("fails closed when stack relayer network is mainnet", async () => {
        const requestFile = await createRequestFile();

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ relayerNetwork: "mainnet" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
            }),
        ).rejects.toThrow("RelayerNetwork to be testnet or devnet");
    });

    it("fails closed when stack proof mode or submit settings are not happy-path ready", async () => {
        const requestFile = await createRequestFile();

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ worldIdProofMode: "real" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
            }),
        ).rejects.toThrow("WorldIdProofMode=dummy");

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ identityRelayerMode: "dry_run" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
            }),
        ).rejects.toThrow("IdentityRelayerMode=submit");

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ relayerAllowSubmit: "false" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
            }),
        ).rejects.toThrow("RelayerAllowSubmit=true");
    });

    it("fails closed when no matching execution appears for the claimed job", async () => {
        const requestFile = await createRequestFile();

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ executionName: "someone-else" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
                poll: { intervalMs: 1, timeoutMs: 5 },
            }),
        ).rejects.toThrow("did not become ready");
    });

    it("fails closed when the execution or job does not reach the happy path terminal state", async () => {
        const requestFile = await createRequestFile();

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ executionStatus: "FAILED" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
            }),
        ).rejects.toThrow("did not succeed: FAILED");

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ jobStatus: "retry" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
            }),
        ).rejects.toThrow("did not complete: retry");
    });

    it("fails closed when execution history pagination does not advance", async () => {
        const requestFile = await createRequestFile();

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ stuckHistoryToken: true }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
            }),
        ).rejects.toThrow("Step Functions execution history pagination did not advance");
    });

    it("fails closed when the AWS account does not match", async () => {
        const requestFile = await createRequestFile();

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ account: "111111111111" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
            }),
        ).rejects.toThrow("AWS account mismatch");
    });

    it("fails closed when the batch schedule is not DISABLED", async () => {
        const requestFile = await createRequestFile();

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ scheduleState: "ENABLED" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
            }),
        ).rejects.toThrow("must be DISABLED");
    });

    it("fails closed when a required stack output is missing", async () => {
        const requestFile = await createRequestFile();

        await expect(
            runSmokeMembershipManual({
                aws: new RecordingAwsCli({ omitOutput: "SubmitVerificationLambdaName" }),
                stack: STACK,
                expectedAccount: EXPECTED_ACCOUNT,
                requestFile,
                now: () => FIXED_NOW_MS,
            }),
        ).rejects.toThrow("CloudFormation output SubmitVerificationLambdaName is required");
    });
});

type RecordingAwsCliOptions = {
    account?: string;
    scheduleState?: string;
    omitOutput?: string;
    functionError?: boolean;
    submitDuplicate?: boolean;
    submitStatusCode?: number;
    workflowStarted?: number;
    teeStatus?: "verified" | "pending_source";
    paginatedHistory?: boolean;
    stuckHistoryToken?: boolean;
    executionName?: string;
    executionStatus?: "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT";
    jobStatus?: "processing" | "completed" | "retry" | "failed";
    relayerNetwork?: "mainnet" | "testnet" | "devnet" | "";
    worldIdProofMode?: "real" | "dummy";
    identityRelayerMode?: "" | "dry_run" | "submit";
    relayerAllowSubmit?: "true" | "false";
    // Number of leading describe-auto-scaling-groups calls that report a still
    // draining instance before the ASG settles to idle. Models the EC2
    // termination lag after the runner workflow scales the ASG to 0.
    asgBusyCalls?: number;
};

class RecordingAwsCli implements AwsCli {
    readonly operations: Array<{ label: string; args: readonly string[] }> = [];
    readonly lambdaPayloads: unknown[] = [];
    readonly invokeFunctionNames: string[] = [];
    readonly submitBodies: unknown[] = [];
    readonly getItemKeys: unknown[] = [];
    readonly historyNextTokens: Array<string | null> = [];
    private asgDescribeCount = 0;

    constructor(private readonly options: RecordingAwsCliOptions = {}) {}

    async json(args: readonly string[]): Promise<unknown> {
        const label = this.label(args);
        this.operations.push({ label, args });

        switch (label) {
            case "sts:get-caller-identity":
                return { Account: this.options.account ?? EXPECTED_ACCOUNT };
            case "cloudformation:describe-stacks":
                return stackResponse(this.options);
            case "scheduler:get-schedule:watcher-schedule":
            case "scheduler:get-schedule:batch-schedule":
                return { State: this.options.scheduleState ?? "DISABLED" };
            case "lambda:invoke:submit-verification":
            case "lambda:invoke:batch-verifier": {
                const functionName = args[args.indexOf("--function-name") + 1] ?? "";
                this.invokeFunctionNames.push(functionName);
                const payload = JSON.parse(args[args.indexOf("--payload") + 1] ?? "{}") as unknown;
                this.lambdaPayloads.push(payload);
                if (label === "lambda:invoke:submit-verification" && isRecord(payload)) {
                    this.submitBodies.push(
                        typeof payload.body === "string" ? JSON.parse(payload.body) : payload.body,
                    );
                }
                const responsePath = args.at(-1);
                if (responsePath === undefined) {
                    throw new Error("lambda invoke response path missing");
                }
                if (label === "lambda:invoke:submit-verification") {
                    await writeFile(
                        responsePath,
                        JSON.stringify({
                            statusCode: this.options.submitStatusCode ?? 202,
                            body: JSON.stringify({
                                ok: true,
                                job_id: "job-abc",
                                status: "queued",
                                duplicate: this.options.submitDuplicate ?? false,
                            }),
                        }),
                    );
                } else {
                    await writeFile(
                        responsePath,
                        JSON.stringify({ workflow_started: this.options.workflowStarted ?? 1 }),
                    );
                }
                return this.options.functionError
                    ? { StatusCode: 200, FunctionError: "Unhandled" }
                    : { StatusCode: 200 };
            }
            case "stepfunctions:list-executions":
                return {
                    executions: [
                        {
                            executionArn: MATCHED_EXECUTION_ARN,
                            name: this.options.executionName ?? "membership-job-abc-1",
                            status: this.options.executionStatus ?? "SUCCEEDED",
                            startDate: "2026-06-05T00:00:00.000Z",
                        },
                    ],
                };
            case "stepfunctions:describe-execution":
                return {
                    executionArn: MATCHED_EXECUTION_ARN,
                    status: this.options.executionStatus ?? "SUCCEEDED",
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
                        status: { S: this.options.jobStatus ?? "completed" },
                        workflow_execution_name: { S: "membership-job-abc-1" },
                        retry_count: { N: "0" },
                        tx_digest: { S: "tx-submit-abc" },
                    },
                };
            }
            case "autoscaling:describe-auto-scaling-groups": {
                this.asgDescribeCount += 1;
                const draining = this.asgDescribeCount <= (this.options.asgBusyCalls ?? 0);
                return {
                    AutoScalingGroups: [
                        {
                            AutoScalingGroupName: "runner-asg",
                            DesiredCapacity: 0,
                            MaxSize: 1,
                            Instances: draining
                                ? [{ InstanceId: "i-draining", LifecycleState: "Terminating" }]
                                : [],
                        },
                    ],
                };
            }
            case "ec2:describe-instances":
                return { Reservations: [] };
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
            return `lambda:invoke:${args[args.indexOf("--function-name") + 1]}`;
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
        if (service === "autoscaling" && operation === "describe-auto-scaling-groups") {
            return "autoscaling:describe-auto-scaling-groups";
        }
        if (service === "ec2" && operation === "describe-instances") {
            return "ec2:describe-instances";
        }
        return `${service}:${operation}`;
    }
}

async function createRequestFile(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sonari-membership-smoke-"));
    tempDirs.push(directory);
    const file = path.join(directory, "dummy-world-id-request.json");
    await writeFile(file, `${JSON.stringify(REQUEST_TEMPLATE, null, 2)}\n`);
    return file;
}

function readArg(args: readonly string[], name: string): string | null {
    const index = args.indexOf(name);
    return index === -1 ? null : (args[index + 1] ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
            identityVerifiedAtMs: FIXED_NOW_MS,
            identityExpiresAtMs: FIXED_NOW_MS + 1,
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

function stackResponse(options: RecordingAwsCliOptions = {}): unknown {
    const outputs = [
        { OutputKey: "SubmitVerificationLambdaName", OutputValue: "submit-verification" },
        { OutputKey: "BatchVerifierLambdaName", OutputValue: "batch-verifier" },
        { OutputKey: "MembershipRunnerStateMachineArn", OutputValue: STATE_MACHINE_ARN },
        { OutputKey: "VerificationJobsTableName", OutputValue: "verification-jobs" },
        { OutputKey: "RunnerAutoScalingGroupName", OutputValue: "runner-asg" },
        { OutputKey: "WatcherScheduleName", OutputValue: "watcher-schedule" },
        { OutputKey: "BatchScheduleName", OutputValue: "batch-schedule" },
    ].filter((output) => output.OutputKey !== options.omitOutput);
    return {
        Stacks: [
            {
                StackName: STACK,
                StackStatus: "UPDATE_COMPLETE",
                Outputs: outputs,
                Parameters: [
                    {
                        ParameterKey: "RelayerNetwork",
                        ParameterValue: options.relayerNetwork ?? "testnet",
                    },
                    {
                        ParameterKey: "WorldIdProofMode",
                        ParameterValue: options.worldIdProofMode ?? "dummy",
                    },
                    {
                        ParameterKey: "IdentityRelayerMode",
                        ParameterValue: options.identityRelayerMode ?? "submit",
                    },
                    {
                        ParameterKey: "RelayerAllowSubmit",
                        ParameterValue: options.relayerAllowSubmit ?? "true",
                    },
                ],
            },
        ],
    };
}
