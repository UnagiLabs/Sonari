import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    ScanCommand,
    UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { IdentityProvider } from "@sonari/membership-verifier-shared";
import { MEMBERSHIP_IDENTITY_VERIFIER_KIND } from "@sonari/verifier-contracts";

export type { IdentityProvider } from "@sonari/membership-verifier-shared";

export const DEFAULT_RETRY_BACKOFF_MS = 15 * 60 * 1000;

export type VerificationJobStatus = "queued" | "processing" | "retry" | "failed" | "completed";

export interface WorldIdProofRequest {
    readonly world_app_id: string;
    readonly nullifier_hash: string;
    readonly merkle_root: string;
    readonly proof: string;
    readonly verification_level: string;
    readonly action: string;
    readonly signal_hash: string;
}

export interface IdentityVerifyRequest {
    readonly registry_id: string;
    readonly membership_id: string;
    readonly owner: string;
    readonly provider: IdentityProvider;
    readonly issued_at_ms?: number;
    readonly validity_ms?: number;
    readonly terms_version: number;
    readonly signed_statement_hash: string;
    readonly world_id?: WorldIdProofRequest;
}

export interface VerificationJobRow {
    readonly job_id: string;
    readonly request_hash: string;
    readonly request_json: string;
    readonly status: VerificationJobStatus;
    readonly retry_count: number;
    readonly next_retry_at_ms: number | null;
    readonly error_code: string | null;
    readonly error_message: string | null;
    readonly workflow_execution_name: string | null;
    readonly workflow_started_at_ms: number | null;
    readonly tx_digest: string | null;
    readonly sui_dry_run_result_json: string | null;
    readonly sui_dry_run_completed_at_ms: number | null;
    readonly created_at_ms: number;
    readonly updated_at_ms: number;
    readonly completed_at_ms: number | null;
}

export interface UpsertVerificationJobResult {
    readonly row: VerificationJobRow;
    readonly duplicate: boolean;
}

export interface DueVerificationJob {
    readonly jobId: string;
    readonly attempt: number;
    readonly executionName: string;
}

export interface VerificationJobRepository {
    upsertRequest(
        request: IdentityVerifyRequest,
        nowMs: number,
    ): Promise<UpsertVerificationJobResult>;
    get(jobId: string): Promise<VerificationJobRow | null>;
    all(): Promise<VerificationJobRow[]>;
    claimNextDue(nowMs: number): Promise<DueVerificationJob | null>;
    markRetry(
        jobId: string,
        nowMs: number,
        nextRetryAtMs: number,
        message: string,
    ): Promise<boolean>;
    markFailed(jobId: string, nowMs: number, errorCode: string, message?: string): Promise<boolean>;
    markSuiDryRunSucceeded(jobId: string, nowMs: number, resultJson: string): Promise<boolean>;
    markCompleted(jobId: string, nowMs: number, txDigest: string): Promise<boolean>;
}

export interface SubmitVerificationLambdaEvent {
    readonly body?: string | null;
}

export interface LambdaHttpResponse {
    readonly statusCode: number;
    readonly headers?: Record<string, string>;
    readonly body: string;
}

export interface SubmitVerificationHandlerOptions {
    readonly repository: VerificationJobRepository;
    readonly now?: () => number;
    readonly expectedRegistryId?: string;
}

export function createSubmitVerificationHandler(options: SubmitVerificationHandlerOptions) {
    return async function submitVerificationHandler(
        event: SubmitVerificationLambdaEvent,
    ): Promise<LambdaHttpResponse> {
        const parsed = parseJsonBody(event.body);
        const request = parseIdentityVerifyRequest(parsed);
        if (!request.ok) {
            return jsonResponse(400, { ok: false, message: request.message });
        }
        const registryMatch = validateExpectedRegistryId(
            request.value.registry_id,
            options.expectedRegistryId,
        );
        if (!registryMatch.ok) {
            return jsonResponse(400, { ok: false, message: registryMatch.message });
        }

        const result = await options.repository.upsertRequest(
            request.value,
            options.now?.() ?? Date.now(),
        );
        const body: Record<string, unknown> = {
            ok: true,
            job_id: result.row.job_id,
            status: result.row.status,
            duplicate: result.duplicate,
        };
        if (result.row.tx_digest !== null) {
            body.tx_digest = result.row.tx_digest;
        }

        return jsonResponse(result.duplicate ? 200 : 202, body);
    };
}

export interface WorkflowStarter {
    start(input: { jobId: string; executionName: string; attempt: number }): Promise<void>;
}

export interface StepFunctionsClientLike {
    send(command: StartExecutionCommand): Promise<unknown>;
}

export class StepFunctionsWorkflowStarter implements WorkflowStarter {
    private readonly client: StepFunctionsClientLike;

    constructor(
        private readonly stateMachineArn: string,
        client?: StepFunctionsClientLike,
    ) {
        this.client = client ?? new SFNClient({});
    }

    async start(input: { jobId: string; executionName: string; attempt: number }): Promise<void> {
        await this.client.send(
            new StartExecutionCommand({
                stateMachineArn: this.stateMachineArn,
                name: input.executionName,
                input: JSON.stringify({
                    verifier_kind: MEMBERSHIP_IDENTITY_VERIFIER_KIND,
                    job_id: input.jobId,
                    attempt: input.attempt,
                }),
            }),
        );
    }
}

export interface BatchVerifierHandlerOptions {
    readonly repository: VerificationJobRepository;
    readonly workflow: WorkflowStarter;
    readonly now?: () => number;
}

export interface BatchVerifierHandlerResult {
    readonly workflow_started: number;
}

export function createBatchVerifierHandler(options: BatchVerifierHandlerOptions) {
    return async function batchVerifierHandler(): Promise<BatchVerifierHandlerResult> {
        const nowMs = options.now?.() ?? Date.now();
        let workflowStarted = 0;
        for (;;) {
            const job = await options.repository.claimNextDue(nowMs);
            if (job === null) {
                break;
            }
            workflowStarted += await processOneJob(options, nowMs, job);
        }
        return { workflow_started: workflowStarted };
    };
}

async function processOneJob(
    options: BatchVerifierHandlerOptions,
    nowMs: number,
    job: DueVerificationJob,
): Promise<number> {
    try {
        await options.workflow.start({
            jobId: job.jobId,
            executionName: job.executionName,
            attempt: job.attempt,
        });
        return 1;
    } catch (error) {
        await options.repository.markRetry(
            job.jobId,
            nowMs,
            nowMs + DEFAULT_RETRY_BACKOFF_MS,
            error instanceof Error ? error.message : String(error),
        );
        return 0;
    }
}

export class InMemoryVerificationJobRepository implements VerificationJobRepository {
    private readonly rowsByJobId = new Map<string, VerificationJobRow>();
    private readonly jobIdByRequestHash = new Map<string, string>();

    async upsertRequest(
        request: IdentityVerifyRequest,
        nowMs: number,
    ): Promise<UpsertVerificationJobResult> {
        const requestJson = stableStringify(request);
        const requestHash = sha256Hex(requestJson);
        const existingJobId = this.jobIdByRequestHash.get(requestHash);
        if (existingJobId !== undefined) {
            const existing = this.rowsByJobId.get(existingJobId);
            if (existing !== undefined) {
                return { row: cloneRow(existing), duplicate: true };
            }
        }

        const jobId = membershipJobId(requestHash);
        const row: VerificationJobRow = {
            job_id: jobId,
            request_hash: requestHash,
            request_json: requestJson,
            status: "queued",
            retry_count: 0,
            next_retry_at_ms: null,
            error_code: null,
            error_message: null,
            workflow_execution_name: null,
            workflow_started_at_ms: null,
            tx_digest: null,
            sui_dry_run_result_json: null,
            sui_dry_run_completed_at_ms: null,
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
            completed_at_ms: null,
        };
        this.rowsByJobId.set(jobId, row);
        this.jobIdByRequestHash.set(requestHash, jobId);
        return { row: cloneRow(row), duplicate: false };
    }

    async get(jobId: string): Promise<VerificationJobRow | null> {
        const row = this.rowsByJobId.get(jobId);
        return row === undefined ? null : cloneRow(row);
    }

    async all(): Promise<VerificationJobRow[]> {
        return [...this.rowsByJobId.values()]
            .sort((left, right) => left.created_at_ms - right.created_at_ms)
            .map(cloneRow);
    }

    async claimNextDue(nowMs: number): Promise<DueVerificationJob | null> {
        const row = [...this.rowsByJobId.values()]
            .filter((candidate) => isDue(candidate, nowMs))
            .sort((left, right) => left.updated_at_ms - right.updated_at_ms)[0];
        if (row === undefined) {
            return null;
        }

        const attempt = row.retry_count + 1;
        const executionName = workflowExecutionName(row.job_id, attempt);
        const updated: VerificationJobRow = {
            ...row,
            status: "processing",
            workflow_execution_name: executionName,
            workflow_started_at_ms: nowMs,
            updated_at_ms: nowMs,
        };
        this.rowsByJobId.set(row.job_id, updated);
        return { jobId: row.job_id, attempt, executionName };
    }

    async markRetry(
        jobId: string,
        nowMs: number,
        nextRetryAtMs: number,
        message: string,
    ): Promise<boolean> {
        const row = this.rowsByJobId.get(jobId);
        if (row === undefined || row.status === "completed" || row.status === "failed") {
            return false;
        }
        this.rowsByJobId.set(jobId, {
            ...row,
            status: "retry",
            retry_count: row.retry_count + 1,
            next_retry_at_ms: nextRetryAtMs,
            error_code: null,
            error_message: message,
            workflow_execution_name: null,
            workflow_started_at_ms: null,
            updated_at_ms: nowMs,
        });
        return true;
    }

    async markFailed(
        jobId: string,
        nowMs: number,
        errorCode: string,
        message?: string,
    ): Promise<boolean> {
        const row = this.rowsByJobId.get(jobId);
        if (row === undefined || row.status === "completed") {
            return false;
        }
        this.rowsByJobId.set(jobId, {
            ...row,
            status: "failed",
            next_retry_at_ms: null,
            error_code: errorCode,
            error_message: message ?? null,
            updated_at_ms: nowMs,
        });
        return true;
    }

    async markSuiDryRunSucceeded(
        jobId: string,
        nowMs: number,
        resultJson: string,
    ): Promise<boolean> {
        const row = this.rowsByJobId.get(jobId);
        if (row === undefined || row.status !== "processing") {
            return false;
        }
        this.rowsByJobId.set(jobId, {
            ...row,
            sui_dry_run_result_json: resultJson,
            sui_dry_run_completed_at_ms: nowMs,
            updated_at_ms: nowMs,
        });
        return true;
    }

    async markCompleted(jobId: string, nowMs: number, txDigest: string): Promise<boolean> {
        const row = this.rowsByJobId.get(jobId);
        if (row === undefined) {
            return false;
        }
        this.rowsByJobId.set(jobId, {
            ...row,
            status: "completed",
            next_retry_at_ms: null,
            error_code: null,
            error_message: null,
            tx_digest: row.tx_digest ?? txDigest,
            updated_at_ms: nowMs,
            completed_at_ms: row.completed_at_ms ?? nowMs,
        });
        return true;
    }
}

export interface DynamoDbDocumentClientLike {
    send(command: unknown): Promise<unknown>;
}

export class DynamoDbVerificationJobRepository implements VerificationJobRepository {
    private readonly documentClient: DynamoDbDocumentClientLike;

    constructor(
        readonly tableName: string,
        client?: DynamoDbDocumentClientLike,
    ) {
        this.documentClient = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
    }

    async upsertRequest(
        request: IdentityVerifyRequest,
        nowMs: number,
    ): Promise<UpsertVerificationJobResult> {
        const requestJson = stableStringify(request);
        const requestHash = sha256Hex(requestJson);
        const jobId = membershipJobId(requestHash);
        const existing = await this.get(jobId);
        if (existing !== null) {
            return { row: existing, duplicate: true };
        }

        const row: VerificationJobRow = {
            job_id: jobId,
            request_hash: requestHash,
            request_json: requestJson,
            status: "queued",
            retry_count: 0,
            next_retry_at_ms: null,
            error_code: null,
            error_message: null,
            workflow_execution_name: null,
            workflow_started_at_ms: null,
            tx_digest: null,
            sui_dry_run_result_json: null,
            sui_dry_run_completed_at_ms: null,
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
            completed_at_ms: null,
        };

        try {
            await this.documentClient.send(
                new PutCommand({
                    TableName: this.tableName,
                    Item: row,
                    ConditionExpression: "attribute_not_exists(job_id)",
                }),
            );
        } catch (error) {
            if (!isConditionalCheckFailed(error)) {
                throw error;
            }
            const existing = await this.get(jobId);
            if (existing !== null) {
                return { row: existing, duplicate: true };
            }
            throw error;
        }
        return { row, duplicate: false };
    }

    async get(jobId: string): Promise<VerificationJobRow | null> {
        const result = (await this.documentClient.send(
            new GetCommand({
                TableName: this.tableName,
                Key: { job_id: jobId },
            }),
        )) as { Item?: unknown };
        return parseStoredRow(result.Item);
    }

    async all(): Promise<VerificationJobRow[]> {
        const result = (await this.documentClient.send(
            new ScanCommand({ TableName: this.tableName }),
        )) as { Items?: unknown[] };
        return (result.Items ?? []).map((item) => {
            const row = parseStoredRow(item);
            if (row === null) {
                throw new Error("verification_jobs row is malformed");
            }
            return row;
        });
    }

    async claimNextDue(nowMs: number): Promise<DueVerificationJob | null> {
        const due = (await this.all())
            .filter((row) => isDue(row, nowMs))
            .sort((left, right) => left.updated_at_ms - right.updated_at_ms)[0];
        if (due === undefined) {
            return null;
        }

        const attempt = due.retry_count + 1;
        const executionName = workflowExecutionName(due.job_id, attempt);
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { job_id: due.job_id },
                    ConditionExpression:
                        "#status IN (:queued, :retry) AND retry_count = :retry_count",
                    UpdateExpression:
                        "SET #status = :processing, workflow_execution_name = :execution_name, workflow_started_at_ms = :now_ms, updated_at_ms = :now_ms",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                        ":queued": "queued",
                        ":retry": "retry",
                        ":processing": "processing",
                        ":retry_count": due.retry_count,
                        ":execution_name": executionName,
                        ":now_ms": nowMs,
                    },
                }),
            );
        } catch (error) {
            if (isConditionalCheckFailed(error)) {
                return null;
            }
            throw error;
        }
        return { jobId: due.job_id, attempt, executionName };
    }

    async markRetry(
        jobId: string,
        nowMs: number,
        nextRetryAtMs: number,
        message: string,
    ): Promise<boolean> {
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { job_id: jobId },
                    ConditionExpression:
                        "attribute_exists(job_id) AND #status <> :completed AND #status <> :failed",
                    UpdateExpression:
                        "SET #status = :retry, retry_count = retry_count + :one, next_retry_at_ms = :next_retry_at_ms, error_code = :null_value, error_message = :message, workflow_execution_name = :null_value, workflow_started_at_ms = :null_value, updated_at_ms = :now_ms",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                        ":retry": "retry",
                        ":one": 1,
                        ":next_retry_at_ms": nextRetryAtMs,
                        ":null_value": null,
                        ":message": message,
                        ":now_ms": nowMs,
                        ":completed": "completed",
                        ":failed": "failed",
                    },
                }),
            );
        } catch (error) {
            if (isConditionalCheckFailed(error)) {
                return false;
            }
            throw error;
        }
        return true;
    }

    async markFailed(
        jobId: string,
        nowMs: number,
        errorCode: string,
        message?: string,
    ): Promise<boolean> {
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { job_id: jobId },
                    ConditionExpression: "attribute_exists(job_id) AND #status <> :completed",
                    UpdateExpression:
                        "SET #status = :failed, next_retry_at_ms = :null_value, error_code = :error_code, error_message = :message, updated_at_ms = :now_ms",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                        ":failed": "failed",
                        ":completed": "completed",
                        ":null_value": null,
                        ":error_code": errorCode,
                        ":message": message ?? null,
                        ":now_ms": nowMs,
                    },
                }),
            );
        } catch (error) {
            if (isConditionalCheckFailed(error)) {
                return false;
            }
            throw error;
        }
        return true;
    }

    async markSuiDryRunSucceeded(
        jobId: string,
        nowMs: number,
        resultJson: string,
    ): Promise<boolean> {
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { job_id: jobId },
                    ConditionExpression: "attribute_exists(job_id) AND #status = :processing",
                    UpdateExpression:
                        "SET sui_dry_run_result_json = :result_json, sui_dry_run_completed_at_ms = :now_ms, updated_at_ms = :now_ms",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                        ":processing": "processing",
                        ":result_json": resultJson,
                        ":now_ms": nowMs,
                    },
                }),
            );
        } catch (error) {
            if (isConditionalCheckFailed(error)) {
                return false;
            }
            throw error;
        }
        return true;
    }

    async markCompleted(jobId: string, nowMs: number, txDigest: string): Promise<boolean> {
        try {
            await this.documentClient.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { job_id: jobId },
                    ConditionExpression: "attribute_exists(job_id)",
                    UpdateExpression:
                        "SET #status = :completed, next_retry_at_ms = :null_value, error_code = :null_value, error_message = :null_value, tx_digest = if_not_exists(tx_digest, :tx_digest), updated_at_ms = :now_ms, completed_at_ms = if_not_exists(completed_at_ms, :now_ms)",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                        ":completed": "completed",
                        ":null_value": null,
                        ":tx_digest": txDigest,
                        ":now_ms": nowMs,
                    },
                }),
            );
        } catch (error) {
            if (isConditionalCheckFailed(error)) {
                return false;
            }
            throw error;
        }
        return true;
    }
}

export function parseIdentityVerifyRequest(input: unknown): ParseResult<IdentityVerifyRequest> {
    if (!isRecord(input)) {
        return parseError("request body must be an object");
    }
    const unexpectedTopLevel = unexpectedKey(input, [
        "registry_id",
        "membership_id",
        "owner",
        "provider",
        "issued_at_ms",
        "validity_ms",
        "terms_version",
        "signed_statement_hash",
        "world_id",
    ]);
    if (unexpectedTopLevel !== undefined) {
        return parseError(`unexpected request field: ${unexpectedTopLevel}`);
    }

    const provider = parseProvider(input.provider);
    if (!provider.ok) {
        return provider;
    }

    const registryId = parseHex32(input.registry_id, "registry_id");
    if (!registryId.ok) {
        return registryId;
    }
    const membershipId = parseHex32(input.membership_id, "membership_id");
    if (!membershipId.ok) {
        return membershipId;
    }
    const owner = parseHex32(input.owner, "owner");
    if (!owner.ok) {
        return owner;
    }
    const termsVersion = parseU64(input.terms_version, "terms_version");
    if (!termsVersion.ok) {
        return termsVersion;
    }
    const signedStatementHash = parseHex32(input.signed_statement_hash, "signed_statement_hash");
    if (!signedStatementHash.ok) {
        return signedStatementHash;
    }
    const issuedAtMs = parseOptionalU64(input.issued_at_ms, "issued_at_ms");
    if (!issuedAtMs.ok) {
        return issuedAtMs;
    }
    const validityMs = parseOptionalU64(input.validity_ms, "validity_ms");
    if (!validityMs.ok) {
        return validityMs;
    }
    const worldId = parseOptionalWorldId(input.world_id);
    if (!worldId.ok) {
        return worldId;
    }
    if (provider.value === "world_id" && worldId.value === undefined) {
        return parseError("world_id proof is required for World ID provider");
    }

    return parseOk({
        registry_id: registryId.value,
        membership_id: membershipId.value,
        owner: owner.value,
        provider: provider.value,
        ...(issuedAtMs.value === undefined ? {} : { issued_at_ms: issuedAtMs.value }),
        ...(validityMs.value === undefined ? {} : { validity_ms: validityMs.value }),
        terms_version: termsVersion.value,
        signed_statement_hash: signedStatementHash.value,
        ...(worldId.value === undefined ? {} : { world_id: worldId.value }),
    });
}

function parseOptionalWorldId(input: unknown): ParseResult<WorldIdProofRequest | undefined> {
    if (input === undefined) {
        return parseOk(undefined);
    }
    if (!isRecord(input)) {
        return parseError("world_id must be an object");
    }
    const unexpectedWorldId = unexpectedKey(input, [
        "world_app_id",
        "nullifier_hash",
        "merkle_root",
        "proof",
        "verification_level",
        "action",
        "signal_hash",
    ]);
    if (unexpectedWorldId !== undefined) {
        return parseError(`unexpected world_id field: ${unexpectedWorldId}`);
    }
    const worldAppId = parseNonEmptyString(input.world_app_id, "world_id.world_app_id");
    if (!worldAppId.ok) {
        return worldAppId;
    }
    const nullifierHash = parseNonEmptyString(input.nullifier_hash, "world_id.nullifier_hash");
    if (!nullifierHash.ok) {
        return nullifierHash;
    }
    const merkleRoot = parseNonEmptyString(input.merkle_root, "world_id.merkle_root");
    if (!merkleRoot.ok) {
        return merkleRoot;
    }
    const proof = parseNonEmptyString(input.proof, "world_id.proof");
    if (!proof.ok) {
        return proof;
    }
    const verificationLevel = parseNonEmptyString(
        input.verification_level,
        "world_id.verification_level",
    );
    if (!verificationLevel.ok) {
        return verificationLevel;
    }
    const action = parseNonEmptyString(input.action, "world_id.action");
    if (!action.ok) {
        return action;
    }
    const signalHash = parseHex32(input.signal_hash, "world_id.signal_hash");
    if (!signalHash.ok) {
        return signalHash;
    }

    return parseOk({
        world_app_id: worldAppId.value,
        nullifier_hash: nullifierHash.value,
        merkle_root: merkleRoot.value,
        proof: proof.value,
        verification_level: verificationLevel.value,
        action: action.value,
        signal_hash: signalHash.value,
    });
}

type ParseResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly message: string };

function parseOk<T>(value: T): ParseResult<T> {
    return { ok: true, value };
}

function parseError(message: string): ParseResult<never> {
    return { ok: false, message };
}

function parseJsonBody(body: string | null | undefined): unknown {
    if (body === undefined || body === null || body.length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(body) as unknown;
    } catch {
        return undefined;
    }
}

function parseProvider(value: unknown): ParseResult<IdentityProvider> {
    if (value === "kyc" || value === "world_id") {
        return parseOk(value);
    }
    return parseError("provider must be kyc or world_id");
}

function parseHex32(value: unknown, field: string): ParseResult<string> {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        return parseError(`${field} must be a 32-byte 0x-prefixed hex string`);
    }
    return parseOk(value.toLowerCase());
}

function validateExpectedRegistryId(
    requestRegistryId: string,
    expectedRegistryId: string | undefined,
): ParseResult<undefined> {
    if (expectedRegistryId === undefined) {
        return parseOk(undefined);
    }
    const expected = parseHex32(expectedRegistryId, "configured identity registry");
    if (!expected.ok) {
        return parseError("configured identity registry must be a 32-byte 0x-prefixed hex string");
    }
    if (requestRegistryId !== expected.value) {
        return parseError("registry_id does not match configured identity registry");
    }
    return parseOk(undefined);
}

function parseOptionalU64(value: unknown, field: string): ParseResult<number | undefined> {
    if (value === undefined) {
        return parseOk(undefined);
    }
    return parseU64(value, field);
}

function parseU64(value: unknown, field: string): ParseResult<number> {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        return parseError(`${field} must be a safe unsigned integer`);
    }
    return parseOk(value);
}

function parseNonEmptyString(value: unknown, field: string): ParseResult<string> {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
        return parseError(`${field} must be a non-empty string without NUL`);
    }
    return parseOk(value);
}

function unexpectedKey(input: Record<string, unknown>, allowed: string[]): string | undefined {
    const allowedSet = new Set(allowed);
    return Object.keys(input).find((key) => !allowedSet.has(key));
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): LambdaHttpResponse {
    return {
        statusCode,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    };
}

function isDue(row: VerificationJobRow, nowMs: number): boolean {
    if (row.status === "queued") {
        return true;
    }
    return row.status === "retry" && row.next_retry_at_ms !== null && row.next_retry_at_ms <= nowMs;
}

function workflowExecutionName(jobId: string, attempt: number): string {
    return `membership-${jobId}-${attempt}`;
}

function membershipJobId(requestHash: string): string {
    return requestHash.slice(0, 32);
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function cloneRow(row: VerificationJobRow): VerificationJobRow {
    return { ...row };
}

function stableStringify(value: unknown): string {
    return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortJson);
    }
    if (!isRecord(value)) {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, entryValue]) => entryValue !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, sortJson(entryValue)]),
    );
}

function parseStoredRow(input: unknown): VerificationJobRow | null {
    if (!isRecord(input)) {
        return null;
    }
    if (
        typeof input.job_id !== "string" ||
        typeof input.request_hash !== "string" ||
        typeof input.request_json !== "string" ||
        !isVerificationJobStatus(input.status) ||
        typeof input.retry_count !== "number" ||
        typeof input.created_at_ms !== "number" ||
        typeof input.updated_at_ms !== "number"
    ) {
        return null;
    }
    return {
        job_id: input.job_id,
        request_hash: input.request_hash,
        request_json: input.request_json,
        status: input.status,
        retry_count: input.retry_count,
        next_retry_at_ms: nullableNumber(input.next_retry_at_ms),
        error_code: nullableString(input.error_code),
        error_message: nullableString(input.error_message),
        workflow_execution_name: nullableString(input.workflow_execution_name),
        workflow_started_at_ms: nullableNumber(input.workflow_started_at_ms),
        tx_digest: nullableString(input.tx_digest),
        sui_dry_run_result_json: nullableString(input.sui_dry_run_result_json),
        sui_dry_run_completed_at_ms: nullableNumber(input.sui_dry_run_completed_at_ms),
        created_at_ms: input.created_at_ms,
        updated_at_ms: input.updated_at_ms,
        completed_at_ms: nullableNumber(input.completed_at_ms),
    };
}

function isConditionalCheckFailed(error: unknown): boolean {
    return isRecord(error) && error.name === "ConditionalCheckFailedException";
}

function isVerificationJobStatus(input: unknown): input is VerificationJobStatus {
    return (
        input === "queued" ||
        input === "processing" ||
        input === "retry" ||
        input === "failed" ||
        input === "completed"
    );
}

function nullableString(input: unknown): string | null {
    return typeof input === "string" ? input : null;
}

function nullableNumber(input: unknown): number | null {
    return typeof input === "number" ? input : null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
