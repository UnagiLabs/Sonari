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
