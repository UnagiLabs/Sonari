import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    assertDirectEarthquakeWrapperResult,
    buildEarthquakeWrapperInput,
    buildSsmParametersPayload,
    parseStackOutputs,
    writeSsmParametersFile,
} from "./shared.js";

describe("AWS script shared helpers", () => {
    it("reads required resource names from CloudFormation stack outputs", () => {
        const outputs = parseStackOutputs({
            Stacks: [
                {
                    Outputs: [
                        { OutputKey: "RunnerAutoScalingGroupName", OutputValue: "runner-asg" },
                        { OutputKey: "WatcherScheduleName", OutputValue: "watcher-schedule" },
                        { OutputKey: "BatchScheduleName", OutputValue: "batch-schedule" },
                        { OutputKey: "EventsTableName", OutputValue: "events-table" },
                        {
                            OutputKey: "EarthquakeRunnerStateMachineArn",
                            OutputValue:
                                "arn:aws:states:ap-northeast-1:595103996064:stateMachine:runner",
                        },
                        { OutputKey: "ManualWatcherLambdaName", OutputValue: "manual-watcher" },
                        { OutputKey: "SourceArchiverLambdaName", OutputValue: "source-archiver" },
                        {
                            OutputKey: "SourceArchiverFunctionUrlOutput",
                            OutputValue: "https://source-archiver.lambda-url.test/",
                        },
                        { OutputKey: "RunnerResultBucketName", OutputValue: "runner-results" },
                        { OutputKey: "DeployedGitCommitSha", OutputValue: "abc123" },
                        { OutputKey: "LambdaCodeS3KeyOutput", OutputValue: "lambda.zip" },
                    ],
                },
            ],
        });

        expect(outputs.RunnerAutoScalingGroupName).toBe("runner-asg");
        expect(outputs.WatcherScheduleName).toBe("watcher-schedule");
        expect(outputs.BatchScheduleName).toBe("batch-schedule");
        expect(outputs.EventsTableName).toBe("events-table");
        expect(outputs.EarthquakeRunnerStateMachineArn).toContain("stateMachine:runner");
        expect(outputs.ManualWatcherLambdaName).toBe("manual-watcher");
        expect(outputs.SourceArchiverLambdaName).toBe("source-archiver");
        expect(outputs.SourceArchiverFunctionUrlOutput).toBe(
            "https://source-archiver.lambda-url.test/",
        );
        expect(outputs.RunnerResultBucketName).toBe("runner-results");
        expect(outputs.DeployedGitCommitSha).toBe("abc123");
        expect(outputs.LambdaCodeS3KeyOutput).toBe("lambda.zip");
    });

    it("serializes SSM commands through a JSON parameters file payload", async () => {
        const payload = buildSsmParametersPayload([
            "test -f /opt/sonari/bootstrap-complete",
            "printf '%s\\n' '{\"action\":\"health_check\"}' | /opt/sonari/bin/run-earthquake-enclave",
        ]);

        expect(payload).toEqual({
            commands: [
                "test -f /opt/sonari/bootstrap-complete",
                "printf '%s\\n' '{\"action\":\"health_check\"}' | /opt/sonari/bin/run-earthquake-enclave",
            ],
        });

        const file = await writeSsmParametersFile(payload, {
            tmpDir: path.join(process.cwd(), "dist", "test-tmp"),
            prefix: "ssm-parameters-test",
        });
        const onDisk = JSON.parse(await readFile(file, "utf8")) as unknown;
        expect(onDisk).toEqual(payload);
    });

    it("validates direct production wrapper JSON instead of runner service ok/result shape", () => {
        const result = finalizedWrapperResult();

        expect(assertDirectEarthquakeWrapperResult(result, "public-key-1")).toBe(result);
        expect(() =>
            assertDirectEarthquakeWrapperResult({ ok: true, result }, "public-key-1"),
        ).toThrow("direct earthquake wrapper JSON");
        expect(() =>
            assertDirectEarthquakeWrapperResult(
                { ...result, raw_data_manifest: { entries: [{ path: "only-one" }] } },
                "public-key-1",
            ),
        ).toThrow("raw_data_manifest.entries length");
        expect(() =>
            assertDirectEarthquakeWrapperResult(
                {
                    ...result,
                    payload: { ...result.payload, evidence_manifest_uri: "ipfs://sonari/live" },
                },
                "public-key-1",
            ),
        ).toThrow("payload.evidence_manifest_uri");
    });

    it("builds earthquake wrapper process_data input with event_revision", () => {
        expect(
            buildEarthquakeWrapperInput({
                sourceEventId: "us6000m0xl",
                eventRevision: 2,
                hazardType: 1,
                primarySource: 1,
                geoResolution: 7,
                verifierConfigKey: 1,
                verifierConfigVersion: 7,
                enclaveInstancePublicKey: "public-key-1",
            }),
        ).toEqual({
            action: "process_data",
            payload: {
                source_event_id: "us6000m0xl",
                event_revision: 2,
                hazard_type: 1,
                primary_source: 1,
                geo_resolution: 7,
            },
            registration_metadata: {
                verifier_config_key: 1,
                verifier_config_version: 7,
                enclave_instance_public_key: "public-key-1",
            },
        });

        expect(() =>
            buildEarthquakeWrapperInput({
                sourceEventId: "us6000m0xl",
                eventRevision: 0,
                hazardType: 1,
                primarySource: 1,
                geoResolution: 7,
                verifierConfigKey: 1,
                verifierConfigVersion: 7,
                enclaveInstancePublicKey: "public-key-1",
            }),
        ).toThrow("eventRevision must be an integer");
    });
});

function finalizedWrapperResult(): {
    status: "finalized";
    source_event_id: string;
    payload: Record<string, unknown>;
    raw_data_manifest: { entries: Array<{ path: string }> };
    affected_cells_ref: { uri: string; source_hash: string };
    evidence_manifest_ref: { uri: string; source_hash: string };
    evidence_manifest: Record<string, unknown>;
    attestation: { public_key: string };
    signature: { public_key: string };
} {
    const affectedCellsRef = {
        uri: "walrus://blob/affected-cells",
        source_hash: `0x${"66".repeat(32)}`,
    };
    const evidenceManifestRef = {
        uri: "walrus://blob/evidence-manifest",
        source_hash: `0x${"77".repeat(32)}`,
    };
    const evidenceManifest = {
        schema_version: 1,
        oracle_version: 1,
        event_uid: `0x${"11".repeat(32)}`,
        event_revision: 1,
        hazard_type: "EARTHQUAKE",
        source_event_id: "us6000m0xl",
        sources: [],
        earthquake: {
            title: "M 7.1 - Fixture",
            region: "Fixture Region",
            occurred_at_ms: 1_700_000_000_000,
            magnitude_x100: 710,
            source_updated_at_ms: 1_700_000_050_000,
        },
        affected_cells: {
            uri: affectedCellsRef.uri,
            hash: affectedCellsRef.source_hash,
            root: `0x${"44".repeat(32)}`,
            count: 1,
            geo_resolution: 7,
        },
    };
    const evidenceManifestHash = `0x${createHash("sha256")
        .update(JSON.stringify(evidenceManifest))
        .digest("hex")}`;
    return {
        status: "finalized",
        source_event_id: "us6000m0xl",
        payload: {
            intent: 1,
            oracle_version: 1,
            event_uid: `0x${"11".repeat(32)}`,
            event_revision: 1,
            source_event_id: "us6000m0xl",
            title: "M 7.1 - Fixture",
            region: "Fixture Region",
            occurred_at_ms: 1_700_000_000_000,
            hazard_type: 1,
            status: 3,
            severity_band: 3,
            affected_cells_root: `0x${"44".repeat(32)}`,
            affected_cell_count: 1,
            evidence_manifest_uri: evidenceManifestRef.uri,
            evidence_manifest_hash: evidenceManifestHash,
            verified_at_ms: 1_700_000_100_000,
            freshness_deadline_ms: 1_700_021_700_000,
        },
        raw_data_manifest: { entries: [{ path: "grid.xml" }, { path: "detail.json" }] },
        affected_cells_ref: affectedCellsRef,
        evidence_manifest_ref: evidenceManifestRef,
        evidence_manifest: evidenceManifest,
        attestation: { public_key: "public-key-1" },
        signature: { public_key: "public-key-1" },
    };
}
