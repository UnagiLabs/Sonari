import { describe, expect, it } from "vitest";
import {
    SuiAuthenticatedEventProofCollector,
    type SuiAuthenticatedEventsTransport,
} from "../src/authenticated_events.js";

const streamId = `0x${"12".repeat(32)}`;
const eventStreamHeadObjectId = `0x${"34".repeat(32)}`;
const objectDigest = "11111111111111111111111111111111";
const treeRoot = "11111111111111111111111111111112";

describe("SuiAuthenticatedEventProofCollector", () => {
    it("collects paginated authenticated stream events and EventStreamHead proof", async () => {
        const transport = new RecordingAuthenticatedEventsTransport();
        const collector = new SuiAuthenticatedEventProofCollector(transport, {
            pageSize: 2,
        });

        const bundle = await collector.collect({
            streamId,
            eventStreamHeadObjectId,
            startCheckpoint: 10,
            endCheckpoint: 42,
        });

        expect(transport.eventRequests).toEqual([
            {
                streamId,
                startCheckpoint: 10,
                endCheckpoint: 42,
                pageSize: 2,
                pageToken: undefined,
            },
            {
                streamId,
                startCheckpoint: 10,
                endCheckpoint: 42,
                pageSize: 2,
                pageToken: "next-page",
            },
        ]);
        expect(transport.proofRequests).toEqual([
            {
                objectId: eventStreamHeadObjectId,
                checkpoint: 42,
            },
        ]);
        expect(bundle).toMatchObject({
            protocol: "sui-authenticated-events-v1",
            stream_id: streamId,
            event_stream_head_object_id: eventStreamHeadObjectId,
            start_checkpoint: 10,
            end_checkpoint: 42,
            highest_indexed_checkpoint: 45,
            validator_committee_bcs: "Y29tbWl0dGVl",
            checkpoint_summary_bcs: "c3VtbWFyeQ==",
            checkpoint_signature_bcs: "c2lnbmF0dXJl",
            event_stream_head: {
                object_id: eventStreamHeadObjectId,
                version: "7",
                digest: objectDigest,
                object_bcs: "aGVhZA==",
            },
            ocs_proof: {
                leaf_index: 3,
                tree_root: treeRoot,
                merkle_proof: ["cHJvb2YtMQ=="],
            },
            events: [
                {
                    checkpoint: 11,
                    transaction_index: 0,
                    event_index: 0,
                    type: `${streamId}::membership::MembershipPassIssued`,
                    event_bcs: "ZXZlbnQtMQ==",
                },
                {
                    checkpoint: 12,
                    transaction_index: 0,
                    event_index: 1,
                    type: `${streamId}::membership::HomeCellRegistered`,
                    event_bcs: "ZXZlbnQtMg==",
                },
            ],
        });
    });

    it("fails closed when the proof checkpoint is not fully indexed", async () => {
        const transport = new RecordingAuthenticatedEventsTransport();
        transport.highestIndexedCheckpoint = 41;
        const collector = new SuiAuthenticatedEventProofCollector(transport);

        await expect(
            collector.collect({
                streamId,
                eventStreamHeadObjectId,
                startCheckpoint: 10,
                endCheckpoint: 42,
            }),
        ).rejects.toThrow("authenticated event index is behind requested checkpoint");
    });

    it("fails closed when an authenticated event response is malformed", async () => {
        const transport = new RecordingAuthenticatedEventsTransport();
        transport.includeMalformedEvent = true;
        const collector = new SuiAuthenticatedEventProofCollector(transport);

        await expect(
            collector.collect({
                streamId,
                eventStreamHeadObjectId,
                startCheckpoint: 10,
                endCheckpoint: 42,
            }),
        ).rejects.toThrow("authenticated event is malformed");
    });
});

class RecordingAuthenticatedEventsTransport implements SuiAuthenticatedEventsTransport {
    readonly eventRequests: unknown[] = [];
    readonly proofRequests: unknown[] = [];
    highestIndexedCheckpoint = 45;
    includeMalformedEvent = false;

    async listAuthenticatedEvents(input: {
        streamId: string;
        startCheckpoint: number;
        endCheckpoint: number;
        pageSize: number;
        pageToken?: string | undefined;
    }) {
        this.eventRequests.push(input);
        if (input.pageToken === undefined) {
            return {
                events: [
                    {
                        checkpoint: 11,
                        transactionIndex: 0,
                        eventIndex: 0,
                        type: `${streamId}::membership::MembershipPassIssued`,
                        eventBcs: "ZXZlbnQtMQ==",
                    },
                ],
                highestIndexedCheckpoint: this.highestIndexedCheckpoint,
                nextPageToken: "next-page",
            };
        }
        return {
            events: [
                this.includeMalformedEvent
                    ? { checkpoint: 12, eventBcs: "ZXZlbnQtMg==" }
                    : {
                          checkpoint: 12,
                          transactionIndex: 0,
                          eventIndex: 1,
                          type: `${streamId}::membership::HomeCellRegistered`,
                          eventBcs: "ZXZlbnQtMg==",
                      },
            ],
            highestIndexedCheckpoint: this.highestIndexedCheckpoint,
            nextPageToken: undefined,
        };
    }

    async getObjectInclusionProof(input: { objectId: string; checkpoint: number }) {
        this.proofRequests.push(input);
        return {
            objectRef: {
                objectId: input.objectId,
                version: "7",
                digest: objectDigest,
            },
            objectBcs: "aGVhZA==",
            validatorCommitteeBcs: "Y29tbWl0dGVl",
            checkpointSummaryBcs: "c3VtbWFyeQ==",
            checkpointSignatureBcs: "c2lnbmF0dXJl",
            inclusionProof: {
                leafIndex: 3,
                treeRoot,
                merkleProof: ["cHJvb2YtMQ=="],
            },
        };
    }
}
