import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
    type AwsCli,
    assertAsgIdle,
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
    parseStackParameters,
    readStringOption,
    requireOutput,
    waitFor,
} from "./shared.js";

const DEFAULT_REQUEST_FILE =
    ".local/sonari-dev/membership-identity-fixture/dummy-world-id-request.json";
const MAX_EXECUTIONS = 20;
const POLL = {
    intervalMs: 5_000,
    // The membership runner cold-boots an EC2 Nitro Enclave and walks through
    // readiness, attestation, registration, process_data, dry-run, submit and
    // readback. The Step Functions fixed waits alone sum to ~2 minutes, and a
    // cold boot pushes the end-to-end happy path to ~3 minutes, so the terminal
    // wait must allow well beyond that for the smoke to go green unattended.
    timeoutMs: 600_000,
};

export type SmokeMembershipManualOptions = {
    aws?: AwsCli;
    stack?: string;
    expectedAccount?: string;
    region?: string;
    requestFile?: string;
    now?: () => number;
    poll?: {
        intervalMs: number;
        timeoutMs: number;
    };
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
    suiSubmission: SuiSubmissionSummary | null;
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

export type SuiSubmissionSummary = {
    status: string;
    txDigest: string | null;
    readback: SuiMembershipPassReadbackSummary | null;
};

export type SuiMembershipPassReadbackSummary = {
    objectId: string;
    identityVerified: boolean;
    identityProviderMask: number;
    identityVerifiedAtMs: number;
    identityExpiresAtMs: number;
    termsVersion: number;
    signedStatementHash: string;
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

export type SubmitVerificationSummary = {
    statusCode: number;
    jobId: string;
    status: string;
    duplicate: boolean;
    txDigest: string | null;
};

export type SmokeMembershipManualResult = {
    submitVerificationLambdaName: string;
    batchVerifierLambdaName: string;
    stateMachineArn: string;
    runnerAutoScalingGroupName: string;
    requestFile: string;
    submitResponse: SubmitVerificationSummary;
    workflowStarted: number;
    executions: ExecutionSummary[];
    matchedExecution: LatestExecutionSummary;
    job: JobSummary;
    idleVerified: true;
};

/**
 * Submit a dummy World ID request through the public membership entrypoint,
 * then trigger the manual batch and follow the exact job/execution it created.
 */
export async function runSmokeMembershipManual(
    options: SmokeMembershipManualOptions = {},
): Promise<SmokeMembershipManualResult> {
    const aws = options.aws ?? new ExecFileAwsCli(options.region ?? DEFAULT_REGION);
    const stack = options.stack ?? DEFAULT_STACK;
    const expectedAccount = options.expectedAccount ?? DEFAULT_EXPECTED_ACCOUNT;
    const requestFile = resolveRequestFile(options.requestFile ?? DEFAULT_REQUEST_FILE);
    const now = options.now ?? Date.now;
    const poll = options.poll ?? POLL;

    await assertExpectedAccount(aws, expectedAccount);
    const stackDescription = await describeStack(aws, stack);
    const outputs = parseStackOutputs(stackDescription);
    const parameters = parseStackParameters(stackDescription);
    assertHappyPathPreflight(parameters);
    await assertSchedulesDisabled(aws, outputs);

    const submitVerificationLambdaName = requireOutput(outputs, "SubmitVerificationLambdaName");
    const batchVerifierLambdaName = requireOutput(outputs, "BatchVerifierLambdaName");
    const stateMachineArn = requireOutput(outputs, "MembershipRunnerStateMachineArn");
    const tableName = requireOutput(outputs, "VerificationJobsTableName");
    const runnerAutoScalingGroupName = requireOutput(outputs, "RunnerAutoScalingGroupName");

    const rawRequest = JSON.parse(await readFile(requestFile, "utf8")) as unknown;
    const request = uniqueizeDummyWorldIdRequest(rawRequest, now());
    const submitResponse = await invokeSubmitVerification(
        aws,
        submitVerificationLambdaName,
        request,
    );
    if (submitResponse.duplicate) {
        throw new Error(
            "SubmitVerification Lambda returned duplicate=true for a uniqueized smoke request",
        );
    }

    const workflowStarted = await invokeBatchVerifier(aws, batchVerifierLambdaName);
    await waitFor(`verification job ${submitResponse.jobId}`, poll, async () => {
        const current = await readJob(aws, tableName, submitResponse.jobId);
        if (current === null || current.workflowExecutionName === null) {
            return null;
        }
        return current;
    });

    const terminal = await waitFor(
        `membership smoke happy path ${submitResponse.jobId}`,
        poll,
        async () => {
            const currentJob = await readJob(aws, tableName, submitResponse.jobId);
            if (currentJob === null) {
                return null;
            }
            if (currentJob.status === "failed" || currentJob.status === "retry") {
                throw new Error(
                    `verification job ${submitResponse.jobId} did not complete: ${currentJob.status}`,
                );
            }
            if (currentJob.workflowExecutionName === null) {
                return null;
            }
            const executions = await listExecutions(aws, stateMachineArn);
            const execution = executions.find(
                (candidate) => candidate.name === currentJob.workflowExecutionName,
            );
            if (execution === undefined) {
                return null;
            }
            const matchedExecution = await describeExecution(aws, execution.executionArn);
            if (matchedExecution.status === "FAILED" || matchedExecution.status === "TIMED_OUT") {
                throw new Error(
                    `Step Functions execution ${execution.name} did not succeed: ${matchedExecution.status}`,
                );
            }
            if (matchedExecution.status !== "SUCCEEDED") {
                return null;
            }
            if (
                currentJob.status !== "completed" ||
                currentJob.txDigest === null ||
                matchedExecution.suiSubmission?.status !== "succeeded" ||
                matchedExecution.suiSubmission.txDigest === null ||
                matchedExecution.suiSubmission.readback?.identityVerified !== true
            ) {
                return null;
            }
            return { currentJob, executions, matchedExecution };
        },
    );
    // The runner workflow's StopInstance step sets the ASG desired capacity to 0
    // as its final action, but the EC2 instance keeps draining for a short while
    // after the execution reaches SUCCEEDED. Poll the idle assertion so the smoke
    // tolerates that termination lag instead of failing on a transient instance.
    await waitFor(`runner ASG ${runnerAutoScalingGroupName} idle`, poll, async () => {
        try {
            await assertAsgIdle(aws, runnerAutoScalingGroupName);
            return true;
        } catch {
            return null;
        }
    });

    return {
        submitVerificationLambdaName,
        batchVerifierLambdaName,
        stateMachineArn,
        runnerAutoScalingGroupName,
        requestFile,
        submitResponse,
        workflowStarted,
        executions: terminal.executions,
        matchedExecution: terminal.matchedExecution,
        job: terminal.currentJob,
        idleVerified: true,
    };
}

function assertHappyPathPreflight(parameters: Record<string, string>): void {
    const relayerNetwork = parameters.RelayerNetwork ?? "";
    const worldIdProofMode = parameters.WorldIdProofMode ?? "real";
    const identityRelayerMode = parameters.IdentityRelayerMode ?? "";
    const relayerAllowSubmit = parameters.RelayerAllowSubmit ?? "false";

    if (worldIdProofMode !== "dummy") {
        throw new Error("membership smoke requires WorldIdProofMode=dummy");
    }
    if (relayerNetwork !== "testnet" && relayerNetwork !== "devnet") {
        throw new Error("membership smoke requires RelayerNetwork to be testnet or devnet");
    }
    if (identityRelayerMode !== "submit") {
        throw new Error("membership smoke requires IdentityRelayerMode=submit");
    }
    if (relayerAllowSubmit !== "true") {
        throw new Error("membership smoke requires RelayerAllowSubmit=true");
    }
}

async function invokeSubmitVerification(
    aws: AwsCli,
    functionName: string,
    request: unknown,
): Promise<SubmitVerificationSummary> {
    const response = await invokeLambdaJson(aws, functionName, {
        body: JSON.stringify(request),
    });
    if (
        !isRecord(response) ||
        typeof response.statusCode !== "number" ||
        typeof response.body !== "string"
    ) {
        throw new Error("SubmitVerification Lambda response did not include statusCode/body");
    }
    const body = safeJsonParse(response.body);
    if (response.statusCode >= 400) {
        const message =
            isRecord(body) && typeof body.message === "string" ? body.message : response.body;
        throw new Error(`SubmitVerification Lambda rejected request: ${message}`);
    }
    if (
        !isRecord(body) ||
        typeof body.job_id !== "string" ||
        typeof body.status !== "string" ||
        typeof body.duplicate !== "boolean"
    ) {
        throw new Error(
            "SubmitVerification Lambda response body did not include job_id/status/duplicate",
        );
    }
    return {
        statusCode: response.statusCode,
        jobId: body.job_id,
        status: body.status,
        duplicate: body.duplicate,
        txDigest: typeof body.tx_digest === "string" ? body.tx_digest : null,
    };
}

async function invokeBatchVerifier(aws: AwsCli, functionName: string): Promise<number> {
    const response = await invokeLambdaJson(aws, functionName, {
        verifier_kind: "membership_identity",
    });
    if (isRecord(response) && typeof response.errorMessage === "string") {
        throw new Error(`BatchVerifier Lambda invocation failed: ${response.errorMessage}`);
    }
    if (!isRecord(response) || typeof response.workflow_started !== "number") {
        throw new Error("BatchVerifier Lambda response did not include workflow_started");
    }
    return response.workflow_started;
}

async function invokeLambdaJson(
    aws: AwsCli,
    functionName: string,
    payload: unknown,
): Promise<unknown> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "sonari-membership-lambda-"));
    try {
        const responsePath = path.join(tempDir, "response.json");
        const invokeResult = await aws.json([
            "lambda",
            "invoke",
            "--function-name",
            functionName,
            "--payload",
            JSON.stringify(payload),
            "--cli-binary-format",
            "raw-in-base64-out",
            responsePath,
        ]);
        if (isRecord(invokeResult) && typeof invokeResult.FunctionError === "string") {
            throw new Error(`${functionName} invocation failed: ${invokeResult.FunctionError}`);
        }
        return JSON.parse(await readFile(responsePath, "utf8")) as unknown;
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
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

async function describeExecution(
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
    const evidence = await readExecutionEvidence(aws, executionArn);
    return {
        executionArn,
        status: isRecord(response) ? requireString(response.status, "execution.status") : "unknown",
        verifierKind: readRecordString(parsedInput, "verifier_kind"),
        jobId: readRecordString(parsedInput, "job_id"),
        registrationMetadata: evidence.registrationMetadata,
        teeResult: evidence.teeResult,
        suiSubmission: evidence.suiSubmission,
    };
}

async function readExecutionEvidence(
    aws: AwsCli,
    executionArn: string,
): Promise<{
    registrationMetadata: RegistrationMetadataSummary | null;
    teeResult: TeeResultSummary | null;
    suiSubmission: SuiSubmissionSummary | null;
}> {
    let nextToken: string | undefined;
    let registrationMetadata: RegistrationMetadataSummary | null = null;
    let teeResult: TeeResultSummary | null = null;
    let suiSubmission: SuiSubmissionSummary | null = null;
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
        suiSubmission ??= readSuiSubmission(readStateOutput(events, "SubmitSuiSubmission"));
        if (registrationMetadata !== null && teeResult !== null && suiSubmission !== null) {
            return { registrationMetadata, teeResult, suiSubmission };
        }
        const responseNextToken = readRecordString(response, "nextToken");
        if (responseNextToken === null) {
            return { registrationMetadata, teeResult, suiSubmission };
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
            "Usage: pnpm aws:smoke:membership-manual -- [--stack <name>] [--expected-account <id>] [--region <region>] [--request-file <path>]\n",
        );
        return;
    }
    const result = await runSmokeMembershipManual({
        stack: readStringOption(args, "stack", DEFAULT_STACK),
        expectedAccount: readStringOption(args, "expected-account", DEFAULT_EXPECTED_ACCOUNT),
        region: readStringOption(args, "region", DEFAULT_REGION),
        requestFile: readStringOption(args, "request-file", DEFAULT_REQUEST_FILE),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function resolveRequestFile(inputPath: string): string {
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function uniqueizeDummyWorldIdRequest(input: unknown, nowMs: number): unknown {
    if (
        !isRecord(input) ||
        !isRecord(input.world_id) ||
        typeof input.world_id.nullifier_hash !== "string"
    ) {
        throw new Error("dummy World ID request must include world_id.nullifier_hash");
    }
    return {
        ...input,
        // The enclave duplicate-key check requires the nullifier to be a decimal or
        // 0x-prefixed hex string, so keep the uniqueizing suffix numeric (no separator).
        world_id: {
            ...input.world_id,
            nullifier_hash: `${input.world_id.nullifier_hash}${nowMs}`,
        },
    };
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

function readRecordBoolean(value: unknown, key: string): boolean | null {
    if (!isRecord(value)) {
        return null;
    }
    const nested = value[key];
    return typeof nested === "boolean" ? nested : null;
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

function readSuiSubmission(output: unknown): SuiSubmissionSummary | null {
    if (!isRecord(output)) {
        return null;
    }
    const status = readRecordString(output, "sui_submission");
    if (status === null) {
        return null;
    }
    return {
        status,
        txDigest: readRecordString(output, "tx_digest"),
        readback: readSuiMembershipPassReadback(output.readback),
    };
}

function readSuiMembershipPassReadback(input: unknown): SuiMembershipPassReadbackSummary | null {
    if (!isRecord(input)) {
        return null;
    }
    const objectId = readRecordString(input, "objectId");
    const identityVerified = readRecordBoolean(input, "identityVerified");
    const identityProviderMask = readRecordNumber(input, "identityProviderMask");
    const identityVerifiedAtMs = readRecordNumber(input, "identityVerifiedAtMs");
    const identityExpiresAtMs = readRecordNumber(input, "identityExpiresAtMs");
    const termsVersion = readRecordNumber(input, "termsVersion");
    const signedStatementHash = readRecordString(input, "signedStatementHash");
    if (
        objectId === null ||
        identityVerified === null ||
        identityProviderMask === null ||
        identityVerifiedAtMs === null ||
        identityExpiresAtMs === null ||
        termsVersion === null ||
        signedStatementHash === null
    ) {
        return null;
    }
    return {
        objectId,
        identityVerified,
        identityProviderMask,
        identityVerifiedAtMs,
        identityExpiresAtMs,
        termsVersion,
        signedStatementHash,
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
