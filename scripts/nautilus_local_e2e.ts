import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
    buildRelayerRequestPreview,
    type RelayerRequestPreview,
    type RelayerResult,
} from "../nautilus_disaster_oracle/relayer/src/index.js";
import type {
    OracleErrorCode,
    SignedFinalizedPayload,
    TeeCoreResult,
    WorkerToTeeRequest,
} from "../nautilus_disaster_oracle/shared/src/index.js";
import {
    HOUR_MS,
    InMemoryStateRepository,
    type ProcessSummary,
    processDueEvents,
    scanCandidates,
    type UsgsEarthquakeCandidate,
} from "../nautilus_disaster_oracle/watcher/src/index.js";
import type { EarthquakeEventRow } from "../nautilus_disaster_oracle/watcher/src/state.js";
import type {
    RunnerAdapter,
    RunnerContext,
} from "../nautilus_disaster_oracle/watcher/src/trigger_tee.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CASE_ID = "usgs/finalized_minimal";
const DEFAULT_FIXTURES_DIR = "nautilus_disaster_oracle/fixtures";
const DEFAULT_TARGET = "0x123::disaster_oracle::submit_payload_v1";
const DEFAULT_REGISTRY = "0x456";

export const E2E_FIXTURE_CASES = [
    "usgs/finalized_minimal",
    "usgs/pending_source_no_shakemap",
    "usgs/pending_mmi_empty_grid",
    "usgs/rejected_cancelled_shakemap",
    "usgs/rejected_no_affected_cells",
] as const;

export type E2eFixtureCase = (typeof E2E_FIXTURE_CASES)[number];

export interface LocalOracleE2eOptions {
    caseId?: string;
    fixturesDir?: string;
    target?: string;
    registry?: string;
    nowMs?: number;
}

export type LocalOracleE2eOutput =
    | (LocalOracleE2eBaseOutput & {
          runner_result: SignedFinalizedPayload;
          relayer_preview: RelayerResult<RelayerRequestPreview>;
          relayer_skipped?: never;
      })
    | (LocalOracleE2eBaseOutput & {
          runner_result: Exclude<TeeCoreResult, SignedFinalizedPayload>;
          relayer_preview?: never;
          relayer_skipped: {
              reason: "non_finalized_status";
              status: Exclude<TeeCoreResult["status"], "finalized">;
              error_code: OracleErrorCode;
          };
      });

interface LocalOracleE2eBaseOutput {
    case_id: string;
    source_event_id: string;
    first_process_summary: ProcessSummary;
    second_process_summary: ProcessSummary;
    final_event: EarthquakeEventRow;
    runner_invocation_count: number;
}

interface RunnerResultSummary {
    status: TeeCoreResult["status"];
    source_event_id: string;
    error_code: OracleErrorCode | null;
}

interface UsgsDetailFixture {
    id: string;
    properties: Record<string, unknown>;
}

export async function runLocalOracleE2e(
    options: LocalOracleE2eOptions = {},
): Promise<LocalOracleE2eOutput> {
    const caseId = options.caseId ?? DEFAULT_CASE_ID;
    const fixturesDir = resolveFromCwd(options.fixturesDir ?? DEFAULT_FIXTURES_DIR);
    const target = options.target ?? DEFAULT_TARGET;
    const registry = options.registry ?? DEFAULT_REGISTRY;
    const candidate = await loadFixtureCandidateAsync(caseId, fixturesDir);
    const nowMs = options.nowMs ?? candidate.occurred_at_ms + 25 * HOUR_MS;

    const repository = new InMemoryStateRepository();
    const runner = new LocalOracleCoreRunnerAdapter({ caseId, fixturesDir });

    await scanCandidates(repository, [candidate], nowMs);
    const firstProcessSummary = await processDueEvents(repository, runner, nowMs);

    await scanCandidates(repository, [candidate], nowMs);
    const secondProcessSummary = await processDueEvents(repository, runner, nowMs);

    const finalEvent = await repository.get(candidate.source_event_id);
    if (finalEvent === null) {
        throw new Error(`Local E2E did not create event ${candidate.source_event_id}`);
    }

    const runnerResult = runner.lastResult;
    if (runnerResult === null) {
        throw new Error(`Local E2E runner was not invoked for ${candidate.source_event_id}`);
    }

    const baseOutput: LocalOracleE2eBaseOutput = {
        case_id: caseId,
        source_event_id: candidate.source_event_id,
        first_process_summary: firstProcessSummary,
        second_process_summary: secondProcessSummary,
        final_event: finalEvent,
        runner_invocation_count: runner.invocationCount,
    };

    if (runnerResult.status === "finalized") {
        const relayerPreview = buildRelayerRequestPreview(runnerResult, { target, registry });
        if (!relayerPreview.ok) {
            throw new Error(
                `Local E2E relayer preview failed: ${relayerPreview.error_code}: ${relayerPreview.message}`,
            );
        }

        return {
            ...baseOutput,
            runner_result: runnerResult,
            relayer_preview: relayerPreview,
        };
    }

    return {
        ...baseOutput,
        runner_result: runnerResult,
        relayer_skipped: {
            reason: "non_finalized_status",
            status: runnerResult.status,
            error_code: runnerResult.error_code,
        },
    };
}

export function loadFixtureCandidate(
    caseId = DEFAULT_CASE_ID,
    fixturesDir = resolveFromCwd(DEFAULT_FIXTURES_DIR),
): UsgsEarthquakeCandidate {
    const detailPath = fixtureDetailPath(fixturesDir, caseId);
    const detail = readJsonSync(detailPath);
    return candidateFromDetail(detail, detailPath);
}

export class LocalOracleCoreRunnerAdapter implements RunnerAdapter {
    invocationCount = 0;
    lastResult: TeeCoreResult | null = null;

    constructor(
        private readonly options: {
            caseId: string;
            fixturesDir: string;
        },
    ) {}

    async run(request: WorkerToTeeRequest, context: RunnerContext): Promise<TeeCoreResult> {
        this.invocationCount += 1;
        const caseId = await this.resolveCaseId(request.source_event_id);
        const outputDir = await mkdtemp(path.join(tmpdir(), "sonari-nautilus-e2e-"));

        try {
            await runRustOracleCore({
                caseId,
                fixturesDir: this.options.fixturesDir,
                outputDir,
            });

            const summary = await readJson<RunnerResultSummary>(
                path.join(outputDir, "result.json"),
            );
            const result =
                summary.status === "finalized"
                    ? await readFinalizedResult(outputDir)
                    : readNonFinalizedResult(summary, context);
            this.lastResult = result;
            return result;
        } finally {
            await rm(outputDir, { recursive: true, force: true });
        }
    }

    private async resolveCaseId(sourceEventId: string): Promise<string> {
        const preferredCandidate = await loadFixtureCandidateAsync(
            this.options.caseId,
            this.options.fixturesDir,
        );
        if (preferredCandidate.source_event_id === sourceEventId) {
            return this.options.caseId;
        }

        for (const caseId of E2E_FIXTURE_CASES) {
            const candidate = await loadFixtureCandidateAsync(caseId, this.options.fixturesDir);
            if (candidate.source_event_id === sourceEventId) {
                return caseId;
            }
        }

        throw new Error(`No local E2E fixture case matches source_event_id ${sourceEventId}`);
    }
}

async function runRustOracleCore(options: {
    caseId: string;
    fixturesDir: string;
    outputDir: string;
}): Promise<void> {
    const caseDir = path.join(options.fixturesDir, options.caseId);
    const inputDir = path.join(caseDir, "input");
    const detailPath = path.join(inputDir, "usgs_detail.json");
    const gridPath = path.join(inputDir, "usgs_grid.xml");
    const sourceEventId = (await loadFixtureCandidateAsync(options.caseId, options.fixturesDir))
        .source_event_id;
    const args = [
        "run",
        "--quiet",
        "--manifest-path",
        path.join(resolveFromCwd("."), "nautilus_disaster_oracle/tee/Cargo.toml"),
        "--",
        "--case-id",
        options.caseId,
        "--detail",
        detailPath,
        "--raw-detail-uri",
        displayPath(detailPath),
        "--raw-data-uri",
        `ipfs://sonari/examples/${sourceEventId}/raw_data_manifest.json`,
        "--affected-cells-uri",
        `ipfs://sonari/examples/${sourceEventId}/affected_cells.json`,
        "--output-dir",
        options.outputDir,
    ];

    if (await fileExists(gridPath)) {
        args.push("--grid", gridPath, "--raw-grid-uri", displayPath(gridPath));
    }

    await execFileAsync("cargo", args, {
        cwd: resolveFromCwd("."),
        maxBuffer: 1024 * 1024 * 10,
    });
}

async function readFinalizedResult(outputDir: string): Promise<SignedFinalizedPayload> {
    const payload = await readJson<Record<string, unknown>>(
        path.join(outputDir, "unsigned_payload_v1.json"),
    );
    const hashes = await readJson<Record<string, unknown>>(
        path.join(outputDir, "expected_hashes.json"),
    );
    const signature = await readJson<Record<string, unknown>>(
        path.join(outputDir, "signature.json"),
    );

    if (
        typeof hashes.unsigned_bcs_payload_hex !== "string" ||
        typeof signature.signature !== "string" ||
        typeof signature.public_key !== "string"
    ) {
        throw new Error("Finalized Rust oracle output is missing signing artifacts");
    }

    return {
        status: "finalized",
        payload,
        payload_bcs_hex: hashes.unsigned_bcs_payload_hex,
        signature: signature.signature,
        public_key: signature.public_key,
    };
}

function readNonFinalizedResult(
    summary: RunnerResultSummary,
    context: RunnerContext,
): Exclude<TeeCoreResult, SignedFinalizedPayload> {
    if (summary.error_code === null) {
        throw new Error(`Non-finalized result ${summary.status} requires error_code`);
    }

    if (summary.status === "pending_source") {
        if (
            summary.error_code !== "SHAKEMAP_PRODUCT_MISSING" &&
            summary.error_code !== "SHAKEMAP_GRID_UNAVAILABLE"
        ) {
            throw new Error(`Unsupported pending_source error_code ${summary.error_code}`);
        }
        return {
            status: "pending_source",
            source_event_id: summary.source_event_id,
            next_retry_at_ms: Math.min(context.nowMs + HOUR_MS, context.finalizationDeadlineAtMs),
            error_code: summary.error_code,
        };
    }

    if (summary.status === "pending_mmi") {
        if (summary.error_code !== "MMI_NOT_AVAILABLE") {
            throw new Error(`Unsupported pending_mmi error_code ${summary.error_code}`);
        }
        return {
            status: "pending_mmi",
            source_event_id: summary.source_event_id,
            next_retry_at_ms: Math.min(context.nowMs + HOUR_MS, context.finalizationDeadlineAtMs),
            error_code: summary.error_code,
        };
    }

    if (summary.status === "rejected") {
        return {
            status: "rejected",
            source_event_id: summary.source_event_id,
            error_code: summary.error_code,
        };
    }

    throw new Error(`Unsupported local oracle status ${summary.status}`);
}

async function loadFixtureCandidateAsync(
    caseId: string,
    fixturesDir: string,
): Promise<UsgsEarthquakeCandidate> {
    const detailPath = fixtureDetailPath(fixturesDir, caseId);
    const detail = await readJson<unknown>(detailPath);
    return candidateFromDetail(detail, detailPath);
}

function candidateFromDetail(input: unknown, detailPath: string): UsgsEarthquakeCandidate {
    if (!isRecord(input) || typeof input.id !== "string" || !isRecord(input.properties)) {
        throw new Error(`${detailPath} must contain id and properties`);
    }

    const detail: UsgsDetailFixture = {
        id: input.id,
        properties: input.properties,
    };

    if (detail.properties.type !== undefined && detail.properties.type !== "earthquake") {
        throw new Error(`${detailPath} is not an earthquake detail fixture`);
    }

    const occurredAtMs = detail.properties.time;
    const sourceUpdatedAtMs = detail.properties.updated;
    if (!isUnixMs(occurredAtMs) || !isUnixMs(sourceUpdatedAtMs)) {
        throw new Error(`${detailPath} has invalid USGS time metadata`);
    }

    return {
        source_event_id: detail.id,
        occurred_at_ms: occurredAtMs,
        source_updated_at_ms: sourceUpdatedAtMs,
        magnitude: readFiniteNumber(detail.properties.mag),
        summary_mmi: readFiniteNumber(detail.properties.mmi),
        alert: readAlert(detail.properties.alert),
        tsunami: detail.properties.tsunami === 1,
    };
}

function parseCliArgs(argv: readonly string[]): LocalOracleE2eOptions {
    const options: LocalOracleE2eOptions = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined) {
            continue;
        }

        const value = argv[index + 1];
        switch (arg) {
            case "--case":
                options.caseId = requireCliValue(arg, value);
                index += 1;
                break;
            case "--fixtures-dir":
                options.fixturesDir = requireCliValue(arg, value);
                index += 1;
                break;
            case "--target":
                options.target = requireCliValue(arg, value);
                index += 1;
                break;
            case "--registry":
                options.registry = requireCliValue(arg, value);
                index += 1;
                break;
            case "--now-ms":
                options.nowMs = parseNowMs(requireCliValue(arg, value));
                index += 1;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

function requireCliValue(flag: string, value: string | undefined): string {
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function parseNowMs(value: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("--now-ms must be a non-negative integer timestamp");
    }
    return parsed;
}

function readFiniteNumber(input: unknown): number | null {
    return typeof input === "number" && Number.isFinite(input) ? input : null;
}

function readAlert(input: unknown): UsgsEarthquakeCandidate["alert"] {
    return input === "green" || input === "yellow" || input === "orange" || input === "red"
        ? input
        : null;
}

function isUnixMs(input: unknown): input is number {
    return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}

async function readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function readJsonSync(filePath: string): unknown {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        return (await stat(filePath)).isFile();
    } catch {
        return false;
    }
}

function fixtureDetailPath(fixturesDir: string, caseId: string): string {
    return path.join(fixturesDir, caseId, "input", "usgs_detail.json");
}

function resolveFromCwd(input: string): string {
    return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function displayPath(filePath: string): string {
    return path.relative(resolveFromCwd("."), filePath).replaceAll(path.sep, "/");
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

async function main(): Promise<void> {
    const output = await runLocalOracleE2e(parseCliArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    });
}
