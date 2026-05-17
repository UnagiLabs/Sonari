import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { HOUR_MS } from "../nautilus_disaster_oracle/watcher/src/index.js";
import {
    type LocalOracleE2eOutput,
    loadFixtureCandidate,
    runLocalOracleE2e,
} from "./nautilus_local_e2e.js";

const execFileAsync = promisify(execFile);

const ROOT_DIR = resolveFromCwd(".");
const WATCHER_DIR = path.join(ROOT_DIR, "nautilus_disaster_oracle/watcher");
const TSX_BIN = path.join(ROOT_DIR, "node_modules/.bin/tsx");
const WRANGLER_BIN = path.join(WATCHER_DIR, "node_modules/.bin/wrangler");
const SIDECAR_HOST = "127.0.0.1";
const SIDECAR_PORT = 8789;
const WRANGLER_HOST = "127.0.0.1";
const WRANGLER_PORT = 8790;
const SIDECAR_URL = `http://${SIDECAR_HOST}:${SIDECAR_PORT}`;
const WRANGLER_URL = `http://${WRANGLER_HOST}:${WRANGLER_PORT}`;
const TARGET = "0x123::disaster_oracle::submit_payload_v1";
const REGISTRY = "0x456";
const MANUAL_SUBMIT_TOKEN = "local-dev-token";
const CASE_ID = "usgs/finalized_minimal";
const STARTUP_TIMEOUT_MS = 45_000;

interface WranglerE2eOutput {
    case_id: string;
    source_event_id: string;
    wrangler_event: {
        status: unknown;
        event_uid: unknown;
        latest_revision: unknown;
        source_updated_at_ms: unknown;
        relayer_preview_status: unknown;
        relayer_request_json_present: boolean;
    };
    local_event: LocalOracleE2eOutput["final_event"];
    relayer_preview_argument_lengths: number[];
}

export async function runWranglerOracleE2e(): Promise<WranglerE2eOutput> {
    const persistDir = await mkdtemp(path.join(tmpdir(), "sonari-wrangler-d1-"));
    let sidecar: ChildProcess | null = null;
    let wrangler: ChildProcess | null = null;

    try {
        await applyMigrations(persistDir);

        sidecar = spawnProcess(TSX_BIN, [
            "scripts/nautilus_sidecar.ts",
            "--host",
            SIDECAR_HOST,
            "--port",
            String(SIDECAR_PORT),
            "--case",
            CASE_ID,
        ]);
        await waitForHttp(`${SIDECAR_URL}/oracle/run`, "sidecar");

        wrangler = spawnProcess(
            WRANGLER_BIN,
            [
                "dev",
                "--local",
                "--ip",
                WRANGLER_HOST,
                "--port",
                String(WRANGLER_PORT),
                "--persist-to",
                persistDir,
                "--var",
                `MANUAL_SUBMIT_TOKEN:${MANUAL_SUBMIT_TOKEN}`,
                "--var",
                `ORACLE_SIDECAR_URL:${SIDECAR_URL}`,
                "--var",
                `RELAYER_TARGET:${TARGET}`,
                "--var",
                `RELAYER_REGISTRY:${REGISTRY}`,
                "--log-level",
                "error",
                "--show-interactive-dev-session=false",
            ],
            WATCHER_DIR,
        );
        await waitForHttp(`${WRANGLER_URL}/health`, "wrangler");

        const candidate = loadFixtureCandidate(CASE_ID);
        const nowMs = candidate.occurred_at_ms + 25 * HOUR_MS;
        const localOutput = await runLocalOracleE2e({
            caseId: CASE_ID,
            target: TARGET,
            registry: REGISTRY,
            nowMs,
        });
        const relayerPreview = localOutput.relayer_preview;
        if (
            localOutput.runner_result.status !== "finalized" ||
            relayerPreview === undefined ||
            !relayerPreview.ok
        ) {
            throw new Error("Wrangler E2E expects the canonical fixture to finalize locally");
        }

        const response = await fetch(`${WRANGLER_URL}/manual/earthquakes`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${MANUAL_SUBMIT_TOKEN}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                source_event_id: candidate.source_event_id,
                occurred_at_ms: candidate.occurred_at_ms,
                source_updated_at_ms: candidate.source_updated_at_ms,
            }),
        });
        if (response.status !== 202) {
            throw new Error(`Manual submit failed: ${response.status} ${await response.text()}`);
        }

        const wranglerEvent = await readD1Event(candidate.source_event_id, persistDir);
        const relayerRequest = readRelayerRequest(wranglerEvent);

        assertEqual(wranglerEvent.status, localOutput.final_event.status, "status");
        assertEqual(wranglerEvent.event_uid, localOutput.final_event.event_uid, "event_uid");
        assertEqual(
            Number(wranglerEvent.latest_revision),
            localOutput.final_event.latest_revision,
            "latest_revision",
        );
        assertEqual(
            Number(wranglerEvent.source_updated_at_ms),
            localOutput.final_event.source_updated_at_ms,
            "source_updated_at_ms",
        );
        assertEqual(wranglerEvent.relayer_preview_status, "succeeded", "relayer_preview_status");
        assertEqual(
            relayerRequest.arguments[1].join(","),
            relayerPreview.value.arguments[1].join(","),
            "payload_bcs_hex bytes",
        );
        assertEqual(
            relayerRequest.arguments[2].join(","),
            relayerPreview.value.arguments[2].join(","),
            "signature bytes",
        );
        assertEqual(
            relayerRequest.arguments[3].join(","),
            relayerPreview.value.arguments[3].join(","),
            "public key bytes",
        );

        return {
            case_id: CASE_ID,
            source_event_id: candidate.source_event_id,
            wrangler_event: {
                status: wranglerEvent.status,
                event_uid: wranglerEvent.event_uid,
                latest_revision: wranglerEvent.latest_revision,
                source_updated_at_ms: wranglerEvent.source_updated_at_ms,
                relayer_preview_status: wranglerEvent.relayer_preview_status,
                relayer_request_json_present:
                    typeof wranglerEvent.relayer_request_json === "string",
            },
            local_event: localOutput.final_event,
            relayer_preview_argument_lengths: relayerRequest.arguments
                .slice(1)
                .map((argument) => argument.length),
        };
    } finally {
        stopProcess(wrangler);
        stopProcess(sidecar);
        await rm(persistDir, { recursive: true, force: true });
    }
}

async function applyMigrations(persistDir: string): Promise<void> {
    await execFileAsync(
        WRANGLER_BIN,
        [
            "d1",
            "migrations",
            "apply",
            "sonari-oracle-watcher-local",
            "--local",
            "--persist-to",
            persistDir,
        ],
        { cwd: WATCHER_DIR, maxBuffer: 1024 * 1024 * 10 },
    );
}

async function readD1Event(
    sourceEventId: string,
    persistDir: string,
): Promise<Record<string, unknown>> {
    const { stdout } = await execFileAsync(
        WRANGLER_BIN,
        [
            "d1",
            "execute",
            "sonari-oracle-watcher-local",
            "--local",
            "--persist-to",
            persistDir,
            "--json",
            "--command",
            `SELECT * FROM earthquake_events WHERE source_event_id = '${sourceEventId}'`,
        ],
        { cwd: WATCHER_DIR, maxBuffer: 1024 * 1024 * 10 },
    );
    const parsed = JSON.parse(stdout) as unknown;
    const row = extractFirstD1Row(parsed);
    if (row === null) {
        throw new Error(`D1 row not found for ${sourceEventId}`);
    }
    return row;
}

function extractFirstD1Row(input: unknown): Record<string, unknown> | null {
    if (Array.isArray(input)) {
        for (const entry of input) {
            const row = extractFirstD1Row(entry);
            if (row !== null) {
                return row;
            }
        }
    }
    if (isRecord(input) && Array.isArray(input.results)) {
        const first = input.results[0];
        return isRecord(first) ? first : null;
    }
    if (isRecord(input) && Array.isArray(input.result)) {
        const first = input.result[0];
        return isRecord(first) ? first : null;
    }
    return null;
}

function readRelayerRequest(row: Record<string, unknown>): {
    arguments: [string, number[], number[], number[]];
} {
    if (typeof row.relayer_request_json !== "string") {
        throw new Error(`D1 row is missing relayer_request_json: ${JSON.stringify(row)}`);
    }
    const parsed = JSON.parse(row.relayer_request_json) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.arguments)) {
        throw new Error("relayer_request_json is malformed");
    }
    return parsed as { arguments: [string, number[], number[], number[]] };
}

function spawnProcess(command: string, args: string[], cwd = ROOT_DIR): ChildProcess {
    const child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    return child;
}

function stopProcess(child: ChildProcess | null): void {
    if (child === null || child.pid === undefined || child.killed) {
        return;
    }
    try {
        process.kill(-child.pid, "SIGTERM");
    } catch {
        child.kill("SIGTERM");
    }
}

async function waitForHttp(url: string, label: string): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.status < 500) {
                return;
            }
        } catch {
            // Retry until the process starts listening.
        }
        await sleep(500);
    }
    throw new Error(`Timed out waiting for ${label} at ${url}`);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label} mismatch: expected ${String(expected)}, got ${String(actual)}`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveFromCwd(input: string): string {
    return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

async function main(): Promise<void> {
    const output = await runWranglerOracleE2e();
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
