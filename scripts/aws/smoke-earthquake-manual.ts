import process from "node:process";
import { pathToFileURL } from "node:url";
import {
    assertExpectedAccount,
    DEFAULT_EXPECTED_ACCOUNT,
    DEFAULT_REGION,
    DEFAULT_STACK,
    describeStack,
    ExecFileAwsCli,
    parseArgs,
    parseStackOutputs,
    readStringOption,
    requireOutput,
} from "./shared.js";

const DEFAULT_SOURCE_EVENT_ID = "us6000m0xl";

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true) {
        process.stdout.write(
            "Usage: pnpm aws:smoke:earthquake-manual -- [--stack <name>] [--expected-account <id>] [--region <region>] [--source-event-id <id>] [--token <token>]\n",
        );
        return;
    }
    const stack = readStringOption(args, "stack", DEFAULT_STACK);
    const expectedAccount = readStringOption(args, "expected-account", DEFAULT_EXPECTED_ACCOUNT);
    const region = readStringOption(args, "region", DEFAULT_REGION);
    const sourceEventId = readStringOption(args, "source-event-id", DEFAULT_SOURCE_EVENT_ID);
    const token = readStringOption(args, "token", process.env.MANUAL_SUBMIT_TOKEN ?? "");
    if (token.length === 0) {
        throw new Error("MANUAL_SUBMIT_TOKEN or --token is required for manual watcher smoke");
    }

    const aws = new ExecFileAwsCli(region);
    await assertExpectedAccount(aws, expectedAccount);
    const outputs = parseStackOutputs(await describeStack(aws, stack));
    const manualLambda = requireOutput(outputs, "ManualWatcherLambdaName");
    const functionUrl = await getFunctionUrl(aws, manualLambda);

    process.stderr.write(
        "Relayer submit behavior depends on the deployed stack RelayerMode/RelayerTarget configuration.\n",
    );
    const response = await fetch(functionUrl, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({ source_event_id: sourceEventId }),
    });
    const body = await response.text();
    if (!response.ok) {
        throw new Error(`Manual watcher returned HTTP ${response.status}: ${body}`);
    }

    const executions = await aws.json([
        "stepfunctions",
        "list-executions",
        "--state-machine-arn",
        requireOutput(outputs, "EarthquakeRunnerStateMachineArn"),
        "--max-results",
        "5",
    ]);
    const row = await aws.json([
        "dynamodb",
        "get-item",
        "--table-name",
        requireOutput(outputs, "EventsTableName"),
        "--key",
        JSON.stringify({ source_event_id: { S: sourceEventId } }),
    ]);
    const item = isRecord(row) && isRecord(row.Item) ? row.Item : {};
    const teeResultSummary = readTeeResultSummary(item);
    const sourceArtifactS3Keys = readDynamoJsonStringArray(item, "source_artifact_s3_keys_json");
    const sourceArchiveSummary = {
        source_archive_status: readDynamoString(item, "source_archive_status"),
        source_archive_error_code: readDynamoString(item, "source_archive_error_code"),
        event_uid: teeResultSummary.event_uid,
        event_revision: teeResultSummary.event_revision,
        latest_source: teeResultSummary.latest_source,
        evidence_manifest_uri: teeResultSummary.evidence_manifest_uri,
        evidence_manifest_hash: teeResultSummary.evidence_manifest_hash,
        evidence_manifest_artifact_s3_key:
            sourceArtifactS3Keys.find((key) => key.endsWith("/evidence_manifest.json")) ?? null,
        affected_cells_artifact_s3_key:
            sourceArtifactS3Keys.find((key) => key.endsWith("/affected_cells.json")) ?? null,
        relayer_status: readDynamoString(item, "relayer_status"),
        relayer_mode: readDynamoString(item, "relayer_mode"),
        relayer_digest: readDynamoString(item, "relayer_digest"),
        disaster_event_object_id: readDynamoString(item, "disaster_event_object_id"),
    };

    process.stdout.write(
        `${JSON.stringify(
            {
                manual_response: JSON.parse(body) as unknown,
                source_archive_summary: sourceArchiveSummary,
                executions,
                row,
            },
            null,
            2,
        )}\n`,
    );
}

async function getFunctionUrl(aws: ExecFileAwsCli, functionName: string): Promise<string> {
    const response = await aws.json([
        "lambda",
        "get-function-url-config",
        "--function-name",
        functionName,
    ]);
    if (!isRecord(response) || typeof response.FunctionUrl !== "string") {
        throw new Error(`Unable to read Lambda function URL for ${functionName}`);
    }
    return response.FunctionUrl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDynamoString(item: Record<string, unknown>, key: string): string | null {
    const value = item[key];
    if (!isRecord(value)) {
        return null;
    }
    const stringValue = value.S;
    return typeof stringValue === "string" && stringValue.length > 0 ? stringValue : null;
}

export function readTeeResultSummary(item: Record<string, unknown>): {
    event_uid: string | null;
    event_revision: number | null;
    latest_source: string | null;
    evidence_manifest_uri: string | null;
    evidence_manifest_hash: string | null;
} {
    const raw = readDynamoString(item, "tee_result_json");
    if (raw === null) {
        return emptyTeeResultSummary();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.status !== "finalized") {
        return emptyTeeResultSummary();
    }
    const payload = parsed.payload;
    if (!isRecord(payload)) {
        throw new Error("Finalized Dynamo tee_result_json is missing payload");
    }
    const eventUid = payload.event_uid;
    const eventRevision = payload.event_revision;
    const evidenceManifestUri = payload.evidence_manifest_uri;
    const evidenceManifestHash = payload.evidence_manifest_hash;
    if (typeof evidenceManifestUri !== "string" || evidenceManifestUri.length === 0) {
        throw new Error(
            "Finalized Dynamo tee_result_json is missing payload.evidence_manifest_uri",
        );
    }
    if (typeof evidenceManifestHash !== "string" || evidenceManifestHash.length === 0) {
        throw new Error(
            "Finalized Dynamo tee_result_json is missing payload.evidence_manifest_hash",
        );
    }
    return {
        event_uid: typeof eventUid === "string" && eventUid.length > 0 ? eventUid : null,
        event_revision: typeof eventRevision === "number" ? eventRevision : null,
        latest_source: readLatestSource(parsed),
        evidence_manifest_uri: evidenceManifestUri,
        evidence_manifest_hash: evidenceManifestHash,
    };
}

function emptyTeeResultSummary(): {
    event_uid: null;
    event_revision: null;
    latest_source: null;
    evidence_manifest_uri: null;
    evidence_manifest_hash: null;
} {
    return {
        event_uid: null,
        event_revision: null,
        latest_source: null,
        evidence_manifest_uri: null,
        evidence_manifest_hash: null,
    };
}

function readLatestSource(result: Record<string, unknown>): string | null {
    const evidenceManifest = result.evidence_manifest;
    if (!isRecord(evidenceManifest) || !Array.isArray(evidenceManifest.sources)) {
        return null;
    }
    let latest: { source: string; updatedAtMs: number } | null = null;
    for (const item of evidenceManifest.sources) {
        if (!isRecord(item) || typeof item.source !== "string") {
            continue;
        }
        const updatedAtMs = item.source_updated_at_ms;
        if (typeof updatedAtMs !== "number" || !Number.isSafeInteger(updatedAtMs)) {
            continue;
        }
        if (latest === null || updatedAtMs > latest.updatedAtMs) {
            latest = { source: item.source, updatedAtMs };
        }
    }
    return latest?.source ?? null;
}

function readDynamoJsonStringArray(item: Record<string, unknown>, key: string): string[] {
    const raw = readDynamoString(item, key);
    if (raw === null) {
        return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        throw new Error(`Dynamo ${key} must be a JSON string array`);
    }
    return parsed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
