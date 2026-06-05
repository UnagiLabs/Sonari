import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { MEMBERSHIP_IDENTITY_VERIFIER_KIND } from "@sonari/verifier-contracts";
import {
    type AwsCli,
    assertExpectedAccount,
    assertSchedulesDisabled,
    DEFAULT_EXPECTED_ACCOUNT,
    DEFAULT_REGION,
    DEFAULT_STACK,
    describeStack,
    ExecFileAwsCli,
    isRecord,
    parseArgs,
    parseStackOutputs,
    readStringOption,
    requireOutput,
} from "./shared.js";

export type SmokeMembershipManualOptions = {
    aws?: AwsCli;
    stack?: string;
    expectedAccount?: string;
    region?: string;
    jobId?: string | undefined;
};

export type ExecutionSummary = {
    executionArn: string;
    name: string;
    status: string;
};

export type LatestExecutionSummary = {
    executionArn: string;
    status: string;
    verifierKind: string | null;
    jobId: string | null;
    registrationMetadata: RegistrationMetadataSummary | null;
    teeResult: TeeResultSummary | null;
};

export type JobSummary = {
    jobId: string;
    status: string;
    workflowExecutionName: string | null;
    retryCount: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    txDigest: string | null;
};

export type RegistrationMetadataSummary = {
    verifierConfigKey: number;
    verifierConfigVersion: number | null;
    enclaveInstancePublicKey: string;
};

export type TeeResultSummary =
    | {
          status: "verified";
          payloadBcsHex: string;
          signature: string;
          publicKey: string;
      }
    | {
          status: string;
          errorCode: string | null;
      };

export type SmokeMembershipManualResult = {
    batchVerifierLambdaName: string;
    stateMachineArn: string;
    workflowStarted: number;
    executions: ExecutionSummary[];
    latestExecution: LatestExecutionSummary | null;
    job: JobSummary | null;
};

const MAX_EXECUTIONS = 5;

/**
 * Manually trigger the membership identity batch verifier and observe its effects.
 *
 * This mirrors the production batch path: the batch lambda claims queued/retry jobs
 * and starts a Step Functions execution per job. The `verifier_kind` lives inside the
 * execution input (set by the runner workflow starter), not in the lambda payload, so
 * this script invokes the lambda and then reads the latest execution input to confirm
 * `verifier_kind=membership_identity`.
 */
export async function runSmokeMembershipManual(
    options: SmokeMembershipManualOptions = {},
): Promise<SmokeMembershipManualResult> {
    const aws = options.aws ?? new ExecFileAwsCli(options.region ?? DEFAULT_REGION);
    const stack = options.stack ?? DEFAULT_STACK;
    const expectedAccount = options.expectedAccount ?? DEFAULT_EXPECTED_ACCOUNT;

    await assertExpectedAccount(aws, expectedAccount);
    const outputs = parseStackOutputs(await describeStack(aws, stack));
    await assertSchedulesDisabled(aws, outputs);

    const batchVerifierLambdaName = requireOutput(outputs, "BatchVerifierLambdaName");
    const stateMachineArn = requireOutput(outputs, "MembershipRunnerStateMachineArn");

    const workflowStarted = await invokeBatchVerifier(aws, batchVerifierLambdaName);
    const executions = await listExecutions(aws, stateMachineArn);
    const latest = executions[0];
    const latestExecution =
        latest === undefined ? null : await describeLatestExecution(aws, latest.executionArn);
    const job =
        options.jobId === undefined
            ? null
            : await readJob(
                  aws,
                  requireOutput(outputs, "VerificationJobsTableName"),
                  options.jobId,
              );

    return {
        batchVerifierLambdaName,
        stateMachineArn,
        workflowStarted,
        executions,
        latestExecution,
        job,
    };
}

async function invokeBatchVerifier(aws: AwsCli, functionName: string): Promise<number> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "sonari-membership-batch-"));
    try {
        const responsePath = path.join(tempDir, "batch-response.json");
        const invokeResult = await aws.json([
            "lambda",
            "invoke",
            "--function-name",
            functionName,
            "--payload",
            JSON.stringify({ verifier_kind: MEMBERSHIP_IDENTITY_VERIFIER_KIND }),
            "--cli-binary-format",
            "raw-in-base64-out",
            responsePath,
        ]);
        if (isRecord(invokeResult) && typeof invokeResult.FunctionError === "string") {
            throw new Error(
                `BatchVerifier Lambda invocation failed: ${invokeResult.FunctionError}`,
            );
        }
        return readWorkflowStarted(JSON.parse(await readFile(responsePath, "utf8")) as unknown);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

function readWorkflowStarted(value: unknown): number {
    if (isRecord(value) && typeof value.errorMessage === "string") {
        throw new Error(`BatchVerifier Lambda invocation failed: ${value.errorMessage}`);
    }
    if (!isRecord(value) || typeof value.workflow_started !== "number") {
        throw new Error("BatchVerifier Lambda response did not include workflow_started");
    }
    return value.workflow_started;
}

async function listExecutions(aws: AwsCli, stateMachineArn: string): Promise<ExecutionSummary[]> {
    const response = await aws.json([
        "stepfunctions",
        "list-executions",
        "--state-machine-arn",
        stateMachineArn,
        "--max-results",
        String(MAX_EXECUTIONS),
    ]);
    if (!isRecord(response) || !Array.isArray(response.executions)) {
        return [];
    }
    return response.executions.filter(isRecord).map((execution) => ({
        executionArn: requireString(execution.executionArn, "execution.executionArn"),
        name: requireString(execution.name, "execution.name"),
        status: requireString(execution.status, "execution.status"),
    }));
}

async function describeLatestExecution(
    aws: AwsCli,
    executionArn: string,
): Promise<LatestExecutionSummary> {
    const response = await aws.json([
        "stepfunctions",
        "describe-execution",
        "--execution-arn",
        executionArn,
    ]);
    const inputText =
        isRecord(response) && typeof response.input === "string" ? response.input : null;
    const parsedInput = inputText === null ? null : safeJsonParse(inputText);
    const evidence = await readLatestExecutionEvidence(aws, executionArn);
    return {
        executionArn,
        status: isRecord(response) ? requireString(response.status, "execution.status") : "unknown",
        verifierKind: readRecordString(parsedInput, "verifier_kind"),
        jobId: readRecordString(parsedInput, "job_id"),
        registrationMetadata: evidence.registrationMetadata,
        teeResult: evidence.teeResult,
    };
}

async function readLatestExecutionEvidence(
    aws: AwsCli,
    executionArn: string,
): Promise<{
    registrationMetadata: RegistrationMetadataSummary | null;
    teeResult: TeeResultSummary | null;
}> {
    let nextToken: string | undefined;
    let registrationMetadata: RegistrationMetadataSummary | null = null;
    let teeResult: TeeResultSummary | null = null;
    for (let page = 0; page < 25; page += 1) {
        const args = [
            "stepfunctions",
            "get-execution-history",
            "--execution-arn",
            executionArn,
            "--max-results",
            "100",
        ];
        if (nextToken !== undefined) {
            args.push("--next-token", nextToken);
        }
        const response = await aws.json(args);
        const events = isRecord(response) && Array.isArray(response.events) ? response.events : [];
        registrationMetadata ??= readRegistrationMetadata(
            readStateOutput(events, "RegisterEnclaveInstance"),
        );
        teeResult ??= readTeeResult(readStateOutput(events, "ReadResult"));
        if (registrationMetadata !== null && teeResult !== null) {
            return { registrationMetadata, teeResult };
        }
        const responseNextToken = readRecordString(response, "nextToken");
        if (responseNextToken === null) {
            return { registrationMetadata, teeResult };
        }
        if (responseNextToken === nextToken) {
            throw new Error("Step Functions execution history pagination did not advance");
        }
        nextToken = responseNextToken;
    }
    throw new Error("Step Functions execution history pagination exceeded 25 pages");
}

async function readJob(aws: AwsCli, tableName: string, jobId: string): Promise<JobSummary | null> {
    const response = await aws.json([
        "dynamodb",
        "get-item",
        "--table-name",
        tableName,
        "--key",
        JSON.stringify({ job_id: { S: jobId } }),
    ]);
    const item = isRecord(response) && isRecord(response.Item) ? response.Item : null;
    if (item === null) {
        return null;
    }
    return {
        jobId,
        status: readDynamoString(item, "status") ?? "unknown",
        workflowExecutionName: readDynamoString(item, "workflow_execution_name"),
        retryCount: readDynamoNumber(item, "retry_count"),
        errorCode: readDynamoString(item, "error_code"),
        errorMessage: readDynamoString(item, "error_message"),
        txDigest: readDynamoString(item, "tx_digest"),
    };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true) {
        process.stdout.write(
            "Usage: pnpm aws:smoke:membership-manual -- [--stack <name>] [--expected-account <id>] [--region <region>] [--job-id <id>]\n",
        );
        return;
    }
    const result = await runSmokeMembershipManual({
        stack: readStringOption(args, "stack", DEFAULT_STACK),
        expectedAccount: readStringOption(args, "expected-account", DEFAULT_EXPECTED_ACCOUNT),
        region: readStringOption(args, "region", DEFAULT_REGION),
        jobId: readOptionalStringOption(args, "job-id"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function readOptionalStringOption(
    options: Record<string, string | boolean>,
    key: string,
): string | undefined {
    const value = options[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readRecordString(value: unknown, key: string): string | null {
    if (!isRecord(value)) {
        return null;
    }
    const nested = value[key];
    return typeof nested === "string" && nested.length > 0 ? nested : null;
}

function readRecordNumber(value: unknown, key: string): number | null {
    if (!isRecord(value)) {
        return null;
    }
    const nested = value[key];
    return typeof nested === "number" && Number.isSafeInteger(nested) ? nested : null;
}

function readStateOutput(events: unknown[], stateName: string): unknown {
    for (const event of events) {
        if (!isRecord(event) || event.type !== "TaskStateExited") {
            continue;
        }
        const details = event.stateExitedEventDetails;
        if (
            !isRecord(details) ||
            details.name !== stateName ||
            typeof details.output !== "string"
        ) {
            continue;
        }
        return safeJsonParse(details.output);
    }
    return null;
}

function readRegistrationMetadata(output: unknown): RegistrationMetadataSummary | null {
    if (!isRecord(output) || !isRecord(output.registration_result)) {
        return null;
    }
    const metadata = output.registration_result.registration_metadata;
    if (!isRecord(metadata)) {
        return null;
    }
    const verifierConfigKey = readRecordNumber(metadata, "verifier_config_key");
    const enclaveInstancePublicKey = readRecordString(metadata, "enclave_instance_public_key");
    if (verifierConfigKey === null || enclaveInstancePublicKey === null) {
        return null;
    }
    return {
        verifierConfigKey,
        verifierConfigVersion: readRecordNumber(metadata, "verifier_config_version"),
        enclaveInstancePublicKey,
    };
}

function readTeeResult(output: unknown): TeeResultSummary | null {
    if (!isRecord(output) || !isRecord(output.result)) {
        return null;
    }
    const result = output.result;
    const status = readRecordString(result, "status");
    if (status === null) {
        return null;
    }
    if (status === "verified") {
        const payloadBcsHex = readRecordString(result, "payload_bcs_hex");
        const signature = readRecordString(result, "signature");
        const publicKey = readRecordString(result, "public_key");
        if (payloadBcsHex === null || signature === null || publicKey === null) {
            throw new Error(
                "verified membership TEE result requires payload_bcs_hex, signature, and public_key",
            );
        }
        return { status, payloadBcsHex, signature, publicKey };
    }
    if ("signature" in result || "public_key" in result) {
        throw new Error("non-verified membership TEE result must not include signature fields");
    }
    return {
        status,
        errorCode: readRecordString(result, "error_code"),
    };
}

function readDynamoString(item: Record<string, unknown>, key: string): string | null {
    const value = item[key];
    if (!isRecord(value)) {
        return null;
    }
    return typeof value.S === "string" && value.S.length > 0 ? value.S : null;
}

function readDynamoNumber(item: Record<string, unknown>, key: string): number | null {
    const value = item[key];
    if (!isRecord(value) || typeof value.N !== "string") {
        return null;
    }
    const parsed = Number(value.N);
    return Number.isFinite(parsed) ? parsed : null;
}

function safeJsonParse(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Expected ${label} to be a non-empty string`);
    }
    return value;
}

if (process.argv[1]?.endsWith("smoke-membership-manual.ts")) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
