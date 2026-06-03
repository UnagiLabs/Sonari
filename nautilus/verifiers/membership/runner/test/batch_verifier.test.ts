import { describe, expect, it } from "vitest";
import {
    createBatchVerifierHandler,
    InMemoryVerificationJobRepository,
    StepFunctionsWorkflowStarter,
    type WorkflowStarter,
} from "../src/index.js";
import { validRequest } from "./fixtures.js";

const baseNowMs = 1_800_000_000_000;

describe("BatchVerifier Lambda", () => {
    it("starts no Step Functions workflow when there are no due jobs", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new RecordingWorkflowStarter();
        const handler = createBatchVerifierHandler({
            repository,
            workflow,
            now: () => baseNowMs,
        });

        await expect(handler()).resolves.toEqual({ workflow_started: 0 });
        expect(workflow.starts).toEqual([]);
    });

    it("starts one workflow for one queued job", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new RecordingWorkflowStarter();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        const handler = createBatchVerifierHandler({
            repository,
            workflow,
            now: () => baseNowMs + 1,
        });

        await expect(handler()).resolves.toEqual({ workflow_started: 1 });
        expect(workflow.starts).toEqual([
            {
                jobId: job.row.job_id,
                executionName: `membership-${job.row.job_id}-1`,
                attempt: 1,
            },
        ]);
        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "processing",
            workflow_execution_name: `membership-${job.row.job_id}-1`,
            workflow_started_at_ms: baseNowMs + 1,
        });
    });

    it("attaches membership_identity verifier kind to Step Functions input", async () => {
        const commands: unknown[] = [];
        const starter = new StepFunctionsWorkflowStarter("arn:aws:states:runner", {
            async send(command: unknown): Promise<void> {
                commands.push(command);
            },
        });

        await starter.start({
            jobId: "membership-job-1",
            executionName: "membership-membership-job-1-1",
            attempt: 1,
        });

        expect(commands).toHaveLength(1);
        expect(readCommandInput(commands[0])).toMatchObject({
            stateMachineArn: "arn:aws:states:runner",
            name: "membership-membership-job-1-1",
        });
        expect(JSON.parse(String(readCommandInput(commands[0]).input))).toEqual({
            verifier_kind: "membership_identity",
            job_id: "membership-job-1",
            attempt: 1,
        });
    });

    it("does not start failed or completed jobs", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new RecordingWorkflowStarter();
        const failed = await repository.upsertRequest(validRequest(), baseNowMs);
        const completed = await repository.upsertRequest(
            {
                ...validRequest(),
                signed_statement_hash: `0x${"66".repeat(32)}`,
            },
            baseNowMs,
        );
        await repository.markFailed(
            failed.row.job_id,
            baseNowMs + 1,
            "WORLD_ID_VERIFICATION_FAILED",
        );
        await repository.markCompleted(completed.row.job_id, baseNowMs + 1, "9TX");
        const handler = createBatchVerifierHandler({
            repository,
            workflow,
            now: () => baseNowMs + 2,
        });

        await expect(handler()).resolves.toEqual({ workflow_started: 0 });
        expect(workflow.starts).toEqual([]);
    });

    it("starts due retry jobs and ignores retry jobs before next_retry_at_ms", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new RecordingWorkflowStarter();
        const dueRetry = await repository.upsertRequest(validRequest(), baseNowMs);
        const futureRetry = await repository.upsertRequest(
            {
                ...validRequest(),
                signed_statement_hash: `0x${"77".repeat(32)}`,
            },
            baseNowMs,
        );
        await repository.markRetry(dueRetry.row.job_id, baseNowMs + 1, baseNowMs + 10, "try later");
        await repository.markRetry(
            futureRetry.row.job_id,
            baseNowMs + 1,
            baseNowMs + 10_000,
            "try later",
        );
        const handler = createBatchVerifierHandler({
            repository,
            workflow,
            now: () => baseNowMs + 10,
        });

        await expect(handler()).resolves.toEqual({ workflow_started: 1 });
        expect(workflow.starts).toEqual([
            {
                jobId: dueRetry.row.job_id,
                executionName: `membership-${dueRetry.row.job_id}-2`,
                attempt: 2,
            },
        ]);
        await expect(repository.get(dueRetry.row.job_id)).resolves.toMatchObject({
            status: "processing",
            retry_count: 1,
        });
        await expect(repository.get(futureRetry.row.job_id)).resolves.toMatchObject({
            status: "retry",
            retry_count: 1,
        });
    });

    it("moves a claimed job to retry when Step Functions start fails", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job = await repository.upsertRequest(validRequest(), baseNowMs);
        const handler = createBatchVerifierHandler({
            repository,
            workflow: new FailingWorkflowStarter(),
            now: () => baseNowMs + 1,
        });

        await expect(handler()).resolves.toEqual({ workflow_started: 0 });
        await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
            status: "retry",
            retry_count: 1,
            next_retry_at_ms: baseNowMs + 15 * 60 * 1000 + 1,
            error_message: "Step Functions unavailable",
        });
    });

    it("drains all due jobs in a single handler invocation", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new RecordingWorkflowStarter();
        const job1 = await repository.upsertRequest(validRequest(), baseNowMs);
        const job2 = await repository.upsertRequest(
            {
                ...validRequest(),
                signed_statement_hash: `0x${"aa".repeat(32)}`,
            },
            baseNowMs,
        );
        const job3 = await repository.upsertRequest(
            {
                ...validRequest(),
                signed_statement_hash: `0x${"bb".repeat(32)}`,
            },
            baseNowMs,
        );
        const handler = createBatchVerifierHandler({
            repository,
            workflow,
            now: () => baseNowMs + 1,
        });

        await expect(handler()).resolves.toEqual({ workflow_started: 3 });
        expect(workflow.starts).toHaveLength(3);
        const startedIds = workflow.starts.map((s) => s.jobId).sort();
        expect(startedIds).toEqual([job1.row.job_id, job2.row.job_id, job3.row.job_id].sort());
        for (const job of [job1, job2, job3]) {
            await expect(repository.get(job.row.job_id)).resolves.toMatchObject({
                status: "processing",
            });
        }
    });

    it("per-job isolation: one failing job does not prevent remaining jobs from being processed", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const job1 = await repository.upsertRequest(validRequest(), baseNowMs);
        const job2 = await repository.upsertRequest(
            {
                ...validRequest(),
                signed_statement_hash: `0x${"cc".repeat(32)}`,
            },
            baseNowMs,
        );
        const job3 = await repository.upsertRequest(
            {
                ...validRequest(),
                signed_statement_hash: `0x${"dd".repeat(32)}`,
            },
            baseNowMs,
        );

        // Make the workflow fail for job1 only
        const partiallyFailingWorkflow = new PartiallyFailingWorkflowStarter([job1.row.job_id]);
        const handler = createBatchVerifierHandler({
            repository,
            workflow: partiallyFailingWorkflow,
            now: () => baseNowMs + 1,
        });

        await expect(handler()).resolves.toEqual({ workflow_started: 2 });
        // Failed job should be in retry status
        await expect(repository.get(job1.row.job_id)).resolves.toMatchObject({
            status: "retry",
            retry_count: 1,
            next_retry_at_ms: baseNowMs + 15 * 60 * 1000 + 1,
        });
        // Remaining jobs should be processing
        await expect(repository.get(job2.row.job_id)).resolves.toMatchObject({
            status: "processing",
        });
        await expect(repository.get(job3.row.job_id)).resolves.toMatchObject({
            status: "processing",
        });
    });

    it("drains queued and due retry jobs together in a single invocation", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const workflow = new RecordingWorkflowStarter();
        const queued = await repository.upsertRequest(validRequest(), baseNowMs);
        const dueRetry = await repository.upsertRequest(
            {
                ...validRequest(),
                signed_statement_hash: `0x${"ee".repeat(32)}`,
            },
            baseNowMs,
        );
        const futureRetry = await repository.upsertRequest(
            {
                ...validRequest(),
                signed_statement_hash: `0x${"ff".repeat(32)}`,
            },
            baseNowMs,
        );
        await repository.markRetry(dueRetry.row.job_id, baseNowMs + 1, baseNowMs + 10, "try later");
        await repository.markRetry(
            futureRetry.row.job_id,
            baseNowMs + 1,
            baseNowMs + 10_000,
            "try later",
        );
        const handler = createBatchVerifierHandler({
            repository,
            workflow,
            now: () => baseNowMs + 10,
        });

        // Should process queued + dueRetry (2 jobs), but not futureRetry
        await expect(handler()).resolves.toEqual({ workflow_started: 2 });
        expect(workflow.starts).toHaveLength(2);
        const startedIds = workflow.starts.map((s) => s.jobId).sort();
        expect(startedIds).toEqual([queued.row.job_id, dueRetry.row.job_id].sort());
        await expect(repository.get(futureRetry.row.job_id)).resolves.toMatchObject({
            status: "retry",
            retry_count: 1,
        });
    });
});

class RecordingWorkflowStarter implements WorkflowStarter {
    readonly starts: Array<{ jobId: string; executionName: string; attempt: number }> = [];

    async start(input: { jobId: string; executionName: string; attempt: number }): Promise<void> {
        this.starts.push(input);
    }
}

class FailingWorkflowStarter implements WorkflowStarter {
    async start(): Promise<void> {
        throw new Error("Step Functions unavailable");
    }
}

class PartiallyFailingWorkflowStarter implements WorkflowStarter {
    constructor(private readonly failingJobIds: string[]) {}

    async start(input: { jobId: string; executionName: string; attempt: number }): Promise<void> {
        if (this.failingJobIds.includes(input.jobId)) {
            throw new Error("Step Functions unavailable for this job");
        }
    }
}

function readCommandInput(command: unknown): Record<string, unknown> {
    if (
        typeof command === "object" &&
        command !== null &&
        "input" in command &&
        typeof command.input === "object" &&
        command.input !== null
    ) {
        return command.input as Record<string, unknown>;
    }
    throw new Error("missing command input");
}
