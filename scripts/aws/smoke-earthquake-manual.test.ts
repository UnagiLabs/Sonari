import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readTeeResultSummary } from "./smoke-earthquake-manual.js";

describe("AWS earthquake manual smoke summary", () => {
    it("reports event uid, revision, and latest source from finalized state", () => {
        const eventUid = `0x${"aa".repeat(32)}`;

        expect(
            readTeeResultSummary({
                tee_result_json: {
                    S: JSON.stringify({
                        status: "finalized",
                        payload: {
                            event_uid: eventUid,
                            event_revision: 2,
                            evidence_manifest_uri: "walrus://blob/manifestBlob_123456",
                            evidence_manifest_hash: `0x${"bb".repeat(32)}`,
                        },
                        evidence_manifest: {
                            sources: [
                                {
                                    source: "USGS detail",
                                    source_updated_at_ms: 1_800_000_001_000,
                                },
                                {
                                    source: "USGS shakemap",
                                    source_updated_at_ms: 1_800_000_002_000,
                                },
                            ],
                        },
                    }),
                },
            }),
        ).toEqual({
            event_uid: eventUid,
            event_revision: 2,
            latest_source: "USGS shakemap",
            evidence_manifest_uri: "walrus://blob/manifestBlob_123456",
            evidence_manifest_hash: `0x${"bb".repeat(32)}`,
        });
    });

    it("includes Floor Census row fields in the manual smoke summary", () => {
        const script = readFileSync(
            new URL("./smoke-earthquake-manual.ts", import.meta.url),
            "utf8",
        );

        expect(script).toContain('readDynamoString(item, "floor_census_status")');
        expect(script).toContain('readDynamoString(item, "floor_census_digest")');
        expect(script).toContain('readDynamoJsonStringArray(item, "floor_census_counts_json")');
        expect(script).toContain('readDynamoString(item, "floor_census_error_message")');
    });
});
