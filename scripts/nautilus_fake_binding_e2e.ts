import { pathToFileURL } from "node:url";
import {
    enqueueDueEvents,
    FINALIZATION_WINDOW_MS,
    HOUR_MS,
    InMemoryStateRepository,
    PROCESSING_STALE_AFTER_MS,
    type RunnerJobQueue,
    type RunnerQueueJob,
    scanCandidates,
    type UsgsEarthquakeCandidate,
} from "../nautilus_disaster_oracle/watcher/src/index.js";

const baseNow = 1_800_000_000_000;

export interface FakeBindingCaseOutput {
    name: string;
    status: string | null;
    error_code: string | null;
    recovered?: number;
}

export interface FakeBindingE2eOutput {
    scope: string;
    cases: FakeBindingCaseOutput[];
}

export async function runFakeBindingOracleE2e(): Promise<FakeBindingE2eOutput> {
    return {
        scope: "fake-binding queue injection, stale recovery, and deadline exceeded",
        cases: [
            await ignoredSmall(),
            await ignoredSmallToNew(),
            await queueSendFailure(),
            await staleQueuedRecovery(),
            await staleProcessingRecovery(),
            await deadlineExceededRejected(),
        ],
    };
}

async function ignoredSmall(): Promise<FakeBindingCaseOutput> {
    const repository = new InMemoryStateRepository();
    await scanCandidates(repository, [candidate("us7000small", { magnitude: 5.4 })], baseNow);
    await enqueueDueEvents(repository, new RecordingQueue(), baseNow);
    return rowOutput("ignored_small", await repository.get("us7000small"));
}

async function ignoredSmallToNew(): Promise<FakeBindingCaseOutput> {
    const repository = new InMemoryStateRepository();
    await scanCandidates(repository, [candidate("us7000promote", { magnitude: 5.4 })], baseNow);
    await scanCandidates(
        repository,
        [candidate("us7000promote", { magnitude: 5.5 })],
        baseNow + 1_000,
    );
    await enqueueDueEvents(repository, new RecordingQueue(), baseNow + 1_000);
    return rowOutput("ignored_small_to_new", await repository.get("us7000promote"));
}

async function queueSendFailure(): Promise<FakeBindingCaseOutput> {
    const repository = new InMemoryStateRepository();
    await scanCandidates(repository, [candidate("us7000queuefail")], baseNow);
    await enqueueDueEvents(repository, new FailingQueue(new Error("queue send failed")), baseNow);
    return rowOutput("queue_send_failure", await repository.get("us7000queuefail"));
}

async function staleQueuedRecovery(): Promise<FakeBindingCaseOutput> {
    const repository = new InMemoryStateRepository();
    const queuedAtMs = baseNow - PROCESSING_STALE_AFTER_MS - 1;
    await scanCandidates(repository, [candidate("us7000stalequeued")], baseNow);
    await repository.enqueueRunnerJob("us7000stalequeued", 1, "us7000stalequeued:1", queuedAtMs);
    const summary = await enqueueDueEvents(repository, new RecordingQueue(), baseNow);
    return {
        ...rowOutput("stale_queued_recovery", await repository.get("us7000stalequeued")),
        recovered: summary.recovered,
    };
}

async function staleProcessingRecovery(): Promise<FakeBindingCaseOutput> {
    const repository = new InMemoryStateRepository();
    const staleAtMs = baseNow - PROCESSING_STALE_AFTER_MS - 1;
    await scanCandidates(repository, [candidate("us7000staleprocessing")], baseNow);
    const job = await repository.enqueueRunnerJob(
        "us7000staleprocessing",
        1,
        "us7000staleprocessing:1",
        baseNow,
    );
    if (job === null) {
        throw new Error("expected stale processing job");
    }
    await repository.claimQueuedForProcessing(job, staleAtMs, baseNow + 30_000);
    const summary = await enqueueDueEvents(repository, new RecordingQueue(), baseNow);
    return {
        ...rowOutput("stale_processing_recovery", await repository.get("us7000staleprocessing")),
        recovered: summary.recovered,
    };
}

async function deadlineExceededRejected(): Promise<FakeBindingCaseOutput> {
    const repository = new InMemoryStateRepository();
    const sourceEventId = "us7000deadline";
    await scanCandidates(
        repository,
        [candidate(sourceEventId, { occurred_at_ms: baseNow - FINALIZATION_WINDOW_MS - 1 })],
        baseNow,
    );
    await repository.applyRunnerResult(
        sourceEventId,
        {
            status: "pending_source",
            source_event_id: sourceEventId,
            error_code: "SHAKEMAP_PRODUCT_MISSING",
        },
        baseNow,
    );
    await enqueueDueEvents(repository, new RecordingQueue(), baseNow);
    return rowOutput("deadline_exceeded_rejected", await repository.get(sourceEventId));
}

function candidate(
    source_event_id: string,
    patch: Partial<UsgsEarthquakeCandidate> = {},
): UsgsEarthquakeCandidate {
    return {
        source_event_id,
        occurred_at_ms: baseNow - 25 * HOUR_MS,
        source_updated_at_ms: baseNow - HOUR_MS,
        magnitude: 6,
        summary_mmi: null,
        alert: null,
        tsunami: false,
        ...patch,
    };
}

function rowOutput(
    name: string,
    row: Awaited<ReturnType<InMemoryStateRepository["get"]>>,
): FakeBindingCaseOutput {
    return {
        name,
        status: row?.status ?? null,
        error_code: row?.error_code ?? null,
    };
}

class RecordingQueue implements RunnerJobQueue {
    readonly messages: RunnerQueueJob[] = [];

    async send(message: RunnerQueueJob): Promise<void> {
        this.messages.push(message);
    }
}

class FailingQueue implements RunnerJobQueue {
    constructor(private readonly error: Error) {}

    async send(_message: RunnerQueueJob): Promise<void> {
        throw this.error;
    }
}

async function main(): Promise<void> {
    const output = await runFakeBindingOracleE2e();
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
