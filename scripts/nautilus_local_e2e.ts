import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    parseUsgsRecentFeed,
    processDueEventsInlineForTests,
    scanCandidates,
    USGS_RECENT_FEED_URL,
    type UsgsEarthquakeCandidate,
} from "../nautilus_disaster_oracle/watcher/src/index.js";
import type { EarthquakeEventRow } from "../nautilus_disaster_oracle/watcher/src/state.js";
import type { RunnerAdapter } from "../nautilus_disaster_oracle/watcher/src/trigger_tee.js";

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

export interface SourceArtifacts {
    case_id: string;
    source_event_id: string;
    raw_detail_path: string;
    raw_detail_uri: string;
    raw_grid_path: string | null;
    raw_grid_uri: string | null;
    raw_data_uri: string;
    affected_cells_uri: string;
    temporary_dir: string | null;
}

export interface SourceClient {
    getSourceArtifacts(sourceEventId: string): Promise<SourceArtifacts>;
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
    const firstProcessSummary = await processDueEventsInlineForTests(repository, runner, nowMs);

    await scanCandidates(repository, [candidate], nowMs);
    const secondProcessSummary = await processDueEventsInlineForTests(repository, runner, nowMs);

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

export class FixtureSourceClient implements SourceClient {
    private readonly caseId: string;
    private readonly fixturesDir: string;

    constructor(options: { caseId: string; fixturesDir: string }) {
        this.caseId = options.caseId;
        this.fixturesDir = resolveFromCwd(options.fixturesDir);
    }

    async getSourceArtifacts(sourceEventId: string): Promise<SourceArtifacts> {
        const caseId = await this.resolveCaseId(sourceEventId);
        const inputDir = path.join(this.fixturesDir, caseId, "input");
        const detailPath = path.join(inputDir, "usgs_detail.json");
        const gridPath = await this.resolveGridPath(inputDir);

        return {
            case_id: caseId,
            source_event_id: sourceEventId,
            raw_detail_path: detailPath,
            raw_detail_uri: displayPath(detailPath),
            raw_grid_path: gridPath,
            raw_grid_uri: gridPath === null ? null : displayPath(gridPath),
            raw_data_uri: `ipfs://sonari/examples/${sourceEventId}/raw_data_manifest.json`,
            affected_cells_uri: `ipfs://sonari/examples/${sourceEventId}/affected_cells.json`,
            temporary_dir: null,
        };
    }

    private async resolveCaseId(sourceEventId: string): Promise<string> {
        const preferredCandidate = await loadFixtureCandidateAsync(this.caseId, this.fixturesDir);
        if (preferredCandidate.source_event_id === sourceEventId) {
            return this.caseId;
        }

        for (const caseId of E2E_FIXTURE_CASES) {
            const candidate = await loadFixtureCandidateAsync(caseId, this.fixturesDir);
            if (candidate.source_event_id === sourceEventId) {
                return caseId;
            }
        }

        throw new Error(`No local E2E fixture case matches source_event_id ${sourceEventId}`);
    }

    private async resolveGridPath(inputDir: string): Promise<string | null> {
        for (const name of ["usgs_grid.xml", "usgs_grid.xml.zip"]) {
            const gridPath = path.join(inputDir, name);
            if (await fileExists(gridPath)) {
                return gridPath;
            }
        }
        return null;
    }
}

export class UsgsSourceClient implements SourceClient {
    private readonly fetcher: typeof fetch;
    private readonly recentFeedUrl: string;

    constructor(options: { fetcher?: typeof fetch; recentFeedUrl?: string } = {}) {
        this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
        this.recentFeedUrl = options.recentFeedUrl ?? USGS_RECENT_FEED_URL;
    }

    async getSourceArtifacts(sourceEventId: string): Promise<SourceArtifacts> {
        let temporaryDir: string | null = null;
        try {
            const detailUrl = await this.resolveDetailUrl(sourceEventId);
            const detail = await this.fetchDetail(sourceEventId, detailUrl);
            temporaryDir = await mkdtemp(path.join(tmpdir(), "sonari-usgs-live-"));
            const detailPath = path.join(temporaryDir, "usgs_detail.json");
            await writeFile(detailPath, `${JSON.stringify(detail)}\n`);

            const grid = await this.fetchPreferredGrid(sourceEventId, detail, temporaryDir);
            return {
                case_id: `usgs-live/${sourceEventId}`,
                source_event_id: sourceEventId,
                raw_detail_path: detailPath,
                raw_detail_uri: detailUrl,
                raw_grid_path: grid?.path ?? null,
                raw_grid_uri: grid?.uri ?? null,
                raw_data_uri: `ipfs://sonari/live/${sourceEventId}/raw_data_manifest.json`,
                affected_cells_uri: `ipfs://sonari/live/${sourceEventId}/affected_cells.json`,
                temporary_dir: temporaryDir,
            };
        } catch (error) {
            if (temporaryDir !== null) {
                await rm(temporaryDir, { recursive: true, force: true });
            }
            throw error;
        }
    }

    private async resolveDetailUrl(sourceEventId: string): Promise<string> {
        try {
            const response = await this.fetcher(this.recentFeedUrl);
            if (response.ok) {
                const candidates = parseUsgsRecentFeed(await response.json());
                const candidate = candidates.find((item) => item.source_event_id === sourceEventId);
                if (candidate?.detail_url !== undefined) {
                    return candidate.detail_url;
                }
            }
        } catch {
            // Fall back to USGS' deterministic detail URL. Manual submissions often only have an id.
        }
        return `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${sourceEventId}.geojson`;
    }

    private async fetchDetail(
        sourceEventId: string,
        detailUrl: string,
    ): Promise<Record<string, unknown>> {
        let response: Response;
        try {
            response = await this.fetcher(detailUrl);
        } catch {
            throw new SourcePendingError(sourceEventId, "USGS_DETAIL_UNAVAILABLE");
        }
        if (!response.ok) {
            throw new SourcePendingError(sourceEventId, "USGS_DETAIL_UNAVAILABLE");
        }
        let detail: unknown;
        try {
            detail = await response.json();
        } catch {
            throw new SourcePendingError(sourceEventId, "USGS_DETAIL_UNAVAILABLE");
        }
        if (!isRecord(detail) || detail.id !== sourceEventId) {
            throw new SourcePendingError(sourceEventId, "USGS_DETAIL_UNAVAILABLE");
        }
        return detail;
    }

    private async fetchPreferredGrid(
        sourceEventId: string,
        detail: Record<string, unknown>,
        temporaryDir: string,
    ): Promise<{ path: string; uri: string } | null> {
        const product = selectPreferredShakeMapProduct(detail);
        if (product === null) {
            return null;
        }

        const properties = isRecord(product.properties) ? product.properties : {};
        if (properties["map-status"] === "CANCELLED") {
            return null;
        }

        const contents = isRecord(product.contents) ? product.contents : {};
        const zipUrl = readContentUrl(contents["download/grid.xml.zip"]);
        const xmlUrl = readContentUrl(contents["download/grid.xml"]);
        const uri = zipUrl ?? xmlUrl;
        if (uri === undefined) {
            throw new SourcePendingError(sourceEventId, "SHAKEMAP_GRID_UNAVAILABLE");
        }

        let response: Response;
        try {
            response = await this.fetcher(uri);
        } catch {
            throw new SourcePendingError(sourceEventId, "SHAKEMAP_GRID_UNAVAILABLE");
        }
        if (!response.ok) {
            throw new SourcePendingError(sourceEventId, "SHAKEMAP_GRID_UNAVAILABLE");
        }
        let bytes: ArrayBuffer;
        try {
            bytes = await response.arrayBuffer();
        } catch {
            throw new SourcePendingError(sourceEventId, "SHAKEMAP_GRID_UNAVAILABLE");
        }

        const fileName = uri === zipUrl ? "usgs_grid.xml.zip" : "usgs_grid.xml";
        const gridPath = path.join(temporaryDir, fileName);
        await writeFile(gridPath, Buffer.from(bytes));
        return { path: gridPath, uri };
    }
}

class SourcePendingError extends Error {
    constructor(
        readonly sourceEventId: string,
        readonly errorCode: Extract<
            OracleErrorCode,
            "USGS_DETAIL_UNAVAILABLE" | "SHAKEMAP_GRID_UNAVAILABLE"
        >,
    ) {
        super(errorCode);
    }
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
    private readonly sourceClient: SourceClient;

    constructor(
        options:
            | {
                  caseId: string;
                  fixturesDir: string;
              }
            | { sourceClient: SourceClient },
    ) {
        this.sourceClient =
            "sourceClient" in options ? options.sourceClient : new FixtureSourceClient(options);
    }

    async run(request: WorkerToTeeRequest): Promise<TeeCoreResult> {
        this.invocationCount += 1;
        let source: SourceArtifacts | null = null;
        let outputDir: string | null = null;

        try {
            source = await this.sourceClient.getSourceArtifacts(request.source_event_id);
            outputDir = await mkdtemp(path.join(tmpdir(), "sonari-nautilus-e2e-"));
            await runRustOracleCore({
                source,
                outputDir,
            });

            const summary = await readJson<RunnerResultSummary>(
                path.join(outputDir, "result.json"),
            );
            const result =
                summary.status === "finalized"
                    ? await readFinalizedResult(outputDir)
                    : readNonFinalizedResult(summary);
            this.lastResult = result;
            return result;
        } catch (error) {
            if (error instanceof SourcePendingError) {
                const result = {
                    status: "pending_source",
                    source_event_id: error.sourceEventId,
                    error_code: error.errorCode,
                } satisfies TeeCoreResult;
                this.lastResult = result;
                return result;
            }
            throw error;
        } finally {
            if (outputDir !== null) {
                await rm(outputDir, { recursive: true, force: true });
            }
            if (source?.temporary_dir !== null && source?.temporary_dir !== undefined) {
                await rm(source.temporary_dir, { recursive: true, force: true });
            }
        }
    }
}

async function runRustOracleCore(options: {
    source: SourceArtifacts;
    outputDir: string;
}): Promise<void> {
    const args = [
        "run",
        "--quiet",
        "--manifest-path",
        path.join(resolveFromCwd("."), "nautilus_disaster_oracle/tee/Cargo.toml"),
        "--",
        "--case-id",
        options.source.case_id,
        "--detail",
        options.source.raw_detail_path,
        "--raw-detail-uri",
        options.source.raw_detail_uri,
        "--raw-data-uri",
        options.source.raw_data_uri,
        "--affected-cells-uri",
        options.source.affected_cells_uri,
        "--output-dir",
        options.outputDir,
    ];

    if (options.source.raw_grid_path !== null) {
        args.push("--grid", options.source.raw_grid_path);
        if (options.source.raw_grid_uri !== null) {
            args.push("--raw-grid-uri", options.source.raw_grid_uri);
        }
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
): Exclude<TeeCoreResult, SignedFinalizedPayload> {
    if (summary.error_code === null) {
        throw new Error(`Non-finalized result ${summary.status} requires error_code`);
    }

    if (summary.status === "pending_source") {
        if (
            summary.error_code !== "USGS_DETAIL_UNAVAILABLE" &&
            summary.error_code !== "SHAKEMAP_PRODUCT_MISSING" &&
            summary.error_code !== "SHAKEMAP_GRID_UNAVAILABLE"
        ) {
            throw new Error(`Unsupported pending_source error_code ${summary.error_code}`);
        }
        return {
            status: "pending_source",
            source_event_id: summary.source_event_id,
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

    const candidate: UsgsEarthquakeCandidate = {
        source_event_id: detail.id,
        occurred_at_ms: occurredAtMs,
        source_updated_at_ms: sourceUpdatedAtMs,
        magnitude: readFiniteNumber(detail.properties.mag),
        summary_mmi: readFiniteNumber(detail.properties.mmi),
        alert: readAlert(detail.properties.alert),
        tsunami: detail.properties.tsunami === 1,
    };
    if (typeof detail.properties.detail === "string" && detail.properties.detail.length > 0) {
        candidate.detail_url = detail.properties.detail;
    }
    return candidate;
}

function selectPreferredShakeMapProduct(
    detail: Record<string, unknown>,
): Record<string, unknown> | null {
    const properties = isRecord(detail.properties) ? detail.properties : {};
    const products = isRecord(properties.products) ? properties.products : {};
    const shakemap = products.shakemap;
    if (!Array.isArray(shakemap) || shakemap.length === 0) {
        return null;
    }

    return shakemap.filter(isRecord).sort(compareShakeMapProducts).at(-1) ?? null;
}

function compareShakeMapProducts(
    left: Record<string, unknown>,
    right: Record<string, unknown>,
): number {
    return compareProductSortKey(productSortKey(left), productSortKey(right));
}

function productSortKey(
    product: Record<string, unknown>,
): [number, number, number, string, string, string] {
    const properties = isRecord(product.properties) ? product.properties : {};
    return [
        readFiniteSortNumber(product.preferredWeight),
        readVersion(properties.version),
        readFiniteSortNumber(product.updateTime),
        typeof product.source === "string" ? product.source : "",
        typeof product.code === "string" ? product.code : "",
        typeof product.status === "string" ? product.status : "",
    ];
}

function compareProductSortKey(
    left: [number, number, number, string, string, string],
    right: [number, number, number, string, string, string],
): number {
    for (let index = 0; index < left.length; index += 1) {
        const leftValue = left[index];
        const rightValue = right[index];
        if (leftValue === rightValue) {
            continue;
        }
        if (typeof leftValue === "number" && typeof rightValue === "number") {
            return leftValue - rightValue;
        }
        return String(leftValue).localeCompare(String(rightValue));
    }
    return 0;
}

function readContentUrl(input: unknown): string | undefined {
    if (!isRecord(input) || typeof input.url !== "string" || input.url.length === 0) {
        return undefined;
    }
    return input.url;
}

function readFiniteSortNumber(input: unknown): number {
    return typeof input === "number" && Number.isFinite(input) ? input : 0;
}

function readVersion(input: unknown): number {
    if (typeof input !== "string") {
        return 0;
    }
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : 0;
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
