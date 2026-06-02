import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    assertDirectEarthquakeWrapperResult,
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
                                "arn:aws:states:us-west-2:595103996064:stateMachine:runner",
                        },
                        { OutputKey: "ManualWatcherLambdaName", OutputValue: "manual-watcher" },
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
        const result = {
            status: "finalized",
            source_event_id: "us6000m0xl",
            raw_data_manifest: { entries: [{ path: "grid.xml" }, { path: "detail.json" }] },
            attestation: { public_key: "public-key-1" },
            signature: { public_key: "public-key-1" },
            unsigned_payload: {},
        };

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
    });
});
