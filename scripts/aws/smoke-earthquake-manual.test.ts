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
});
