import { pathToFileURL } from "node:url";
import {
    buildRelayerRequestPreview,
    dryRunRelayerSubmit,
    type RelayerRequestPreview,
} from "../nautilus/verifiers/disaster/relayer/src/index.js";
import type { TeeCoreResult } from "../nautilus/verifiers/disaster/shared/src/index.js";
import {
    fetchUsgsRecentCandidates,
    HOUR_MS,
    InMemoryStateRepository,
    processDueEventsInlineForTests,
    scanCandidates,
    type UsgsEarthquakeCandidate,
} from "../nautilus/verifiers/disaster/watcher/src/index.js";
import type {
    RelayerAdapter,
    RelayerMode,
    RelayerRunResult,
} from "../nautilus/verifiers/disaster/watcher/src/relayer_preview.js";
import { LocalOracleCoreRunnerAdapter, UsgsSourceClient } from "./nautilus_local_e2e.js";

type ExpectedStatus =
    | "finalized"
    | "pending_source"
    | "pending_mmi"
    | "rejected"
    | "ignored_small"
    | "submitted";

interface LiveE2eOptions {
    scanLive: boolean;
    manualEventId?: string;
    expect?: ExpectedStatus;
    nowMs?: number;
}

const DEFAULT_TARGET = "0x123::disaster_oracle::submit_payload_v1";
const DEFAULT_REGISTRY = "0x456";

export async function runLiveE2e(options: LiveE2eOptions): Promise<Record<string, unknown>> {
    const nowMs = options.nowMs ?? Date.now();
    const repository = new InMemoryStateRepository();
    const sourceClient = new UsgsSourceClient();
    const runner = new LocalOracleCoreRunnerAdapter({ sourceClient });
    const relayer = relayerFromEnv();
    if (options.expect === "submitted" && relayer.mode !== "submit") {
        throw new Error("submitted expectation requires RELAYER_MODE=submit");
    }

    let candidates: UsgsEarthquakeCandidate[] = [];
    if (options.scanLive) {
        candidates = await fetchUsgsRecentCandidates();
        await scanCandidates(repository, candidates, nowMs);
    }

    if (options.manualEventId !== undefined) {
        const candidate: UsgsEarthquakeCandidate = {
            source_event_id: options.manualEventId,
            occurred_at_ms: nowMs - 25 * HOUR_MS,
            source_updated_at_ms: nowMs,
            magnitude: null,
            summary_mmi: null,
            alert: null,
            tsunami: false,
        };
        candidates = [candidate];
        await scanCandidates(repository, [candidate], nowMs, { bypassScreening: true });
    }

    const first = await processDueEventsInlineForTests(
        repository,
        runner,
        nowMs,
        undefined,
        relayer,
    );
    const eventId = options.manualEventId ?? candidates[0]?.source_event_id;
    const row = eventId === undefined ? null : await repository.get(eventId);

    if (options.expect !== undefined && row?.status !== options.expect) {
        throw new Error(`Expected ${options.expect}, got ${row?.status ?? "none"}`);
    }

    return {
        scan_live: options.scanLive,
        scanned_count: candidates.length,
        manual_event_id: options.manualEventId ?? null,
        runner_invocation_count: runner.invocationCount,
        runner_result: summarizeRunnerResult(runner.lastResult),
        process_summary: first,
        event: row,
        relayer: {
            mode: row?.relayer_mode ?? relayer.mode,
            status: row?.relayer_status ?? null,
            digest: row?.relayer_digest ?? null,
            error_code: row?.relayer_error_code ?? null,
            argument_lengths: relayerArgumentLengths(row?.relayer_request_json ?? null),
        },
    };
}

class LocalRelayerAdapter implements RelayerAdapter {
    readonly mode: RelayerMode;

    constructor(mode: RelayerMode) {
        this.mode = mode;
    }

    async relay(input: TeeCoreResult): Promise<RelayerRunResult> {
        if (input.status !== "finalized") {
            return {
                ok: false,
                error_code: "RELAYER_SUBMIT_FAILED",
                message: "Relayer accepts only finalized results",
            };
        }
        const config = {
            target: process.env.RELAYER_TARGET ?? DEFAULT_TARGET,
            registry: process.env.RELAYER_REGISTRY ?? DEFAULT_REGISTRY,
        };
        if (this.mode === "preview") {
            const result = buildRelayerRequestPreview(input, config);
            return result.ok
                ? { ok: true, value: { mode: this.mode, request: result.value } }
                : result;
        }
        if (this.mode === "dry_run") {
            const grpcUrl = process.env.RELAYER_GRPC_URL;
            const senderAddress = process.env.RELAYER_SENDER_ADDRESS;
            if (grpcUrl === undefined || senderAddress === undefined) {
                return {
                    ok: false,
                    error_code: "RELAYER_SUBMIT_FAILED",
                    message: "dry_run requires RELAYER_GRPC_URL and RELAYER_SENDER_ADDRESS",
                };
            }
            const result = await dryRunRelayerSubmit(input, { ...config, grpcUrl, senderAddress });
            return result.ok
                ? { ok: true, value: { mode: this.mode, request: result.value.request } }
                : result;
        }
        if (process.env.RELAYER_ALLOW_SUBMIT !== "true") {
            return {
                ok: false,
                error_code: "RELAYER_SUBMIT_FAILED",
                message: "submit requires RELAYER_ALLOW_SUBMIT=true",
            };
        }
        return {
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "submit signer is not configured in the live E2E harness",
        };
    }
}

function relayerFromEnv(): LocalRelayerAdapter {
    const mode = process.env.RELAYER_MODE;
    if (mode === undefined) {
        return new LocalRelayerAdapter("preview");
    }
    if (mode === "dry_run" || mode === "submit" || mode === "preview") {
        return new LocalRelayerAdapter(mode);
    }
    throw new Error(`Unsupported RELAYER_MODE: ${mode}`);
}

function summarizeRunnerResult(result: TeeCoreResult | null): Record<string, unknown> | null {
    if (result === null) {
        return null;
    }
    if (result.status !== "finalized") {
        return result;
    }
    return {
        status: "finalized",
        payload_bcs_hex_length: result.payload_bcs_hex.length,
        signature_length: result.signature.length,
        public_key_length: result.public_key.length,
    };
}

function relayerArgumentLengths(requestJson: string | null): number[] {
    if (requestJson === null) {
        return [];
    }
    const parsed = JSON.parse(requestJson) as RelayerRequestPreview;
    return parsed.arguments.map((argument) =>
        Array.isArray(argument) ? argument.length : String(argument).length,
    );
}

function parseArgs(argv: readonly string[]): LiveE2eOptions {
    const options: LiveE2eOptions = { scanLive: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];
        switch (arg) {
            case "--scan-live":
                options.scanLive = true;
                break;
            case "--manual-event-id":
                options.manualEventId = requireValue(arg, value);
                index += 1;
                break;
            case "--expect":
                options.expect = parseExpectedStatus(requireValue(arg, value));
                index += 1;
                break;
            case "--now-ms":
                options.nowMs = Number(requireValue(arg, value));
                index += 1;
                break;
            default:
                throw new Error(`Unknown argument: ${String(arg)}`);
        }
    }
    if (!options.scanLive && options.manualEventId === undefined) {
        throw new Error("Use --scan-live or --manual-event-id <id>");
    }
    return options;
}

function parseExpectedStatus(value: string): ExpectedStatus {
    if (
        value === "finalized" ||
        value === "pending_source" ||
        value === "pending_mmi" ||
        value === "rejected" ||
        value === "ignored_small" ||
        value === "submitted"
    ) {
        return value;
    }
    throw new Error(`Unsupported --expect value: ${value}`);
}

function requireValue(flag: string, value: string | undefined): string {
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    runLiveE2e(parseArgs(process.argv.slice(2)))
        .then((output) => {
            process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        })
        .catch((error: unknown) => {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        });
}
