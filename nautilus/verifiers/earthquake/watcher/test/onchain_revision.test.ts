import { describe, expect, it } from "vitest";
import {
    decodeDynamicFieldRevision,
    getLatestOnchainEventRevision,
    parseDisasterEventCreatedRevision,
} from "../src/onchain_revision.js";

const eventUid = `0x${"ab".repeat(32)}`;
const otherEventUid = `0x${"cd".repeat(32)}`;
const disasterEventType = `0x${"12".repeat(32)}::disaster_event::DisasterEventCreated`;

describe("on-chain revision reader", () => {
    it("returns 0 with source info when configured sources find no matching revision", async () => {
        const result = await getLatestOnchainEventRevision({
            eventUid,
            disasterEventType,
            graphql: { query: async () => ({ data: { events: { nodes: [] } } }) },
        });

        expect(result).toEqual({ latestRevision: 0, sources: ["graphql"] });
    });

    it("parses DisasterEventCreated-like GraphQL data and returns the max matching revision", async () => {
        const result = await getLatestOnchainEventRevision({
            eventUid,
            disasterEventType,
            graphql: {
                query: async () => ({
                    data: {
                        events: {
                            nodes: [
                                { contents: { json: { event_uid: eventUid, event_revision: 1 } } },
                                {
                                    parsedJson: {
                                        event_uid: Array.from(Buffer.from(eventUid.slice(2), "hex")),
                                        event_revision: "3",
                                    },
                                },
                                { contents: { json: { event_uid: otherEventUid, event_revision: 9 } } },
                            ],
                        },
                    },
                }),
            },
        });

        expect(result).toEqual({ latestRevision: 3, sources: ["graphql"] });
    });

    it("queries the full DisasterEventCreated type and paginates GraphQL data", async () => {
        const variables: Record<string, unknown>[] = [];
        const queries: string[] = [];
        const result = await getLatestOnchainEventRevision({
            eventUid,
            disasterEventType,
            graphql: {
                query: async (_query, inputVariables) => {
                    queries.push(_query);
                    variables.push(inputVariables);
                    if (inputVariables.cursor === null) {
                        return {
                            data: {
                                events: {
                                    nodes: [
                                        {
                                            parsedJson: {
                                                event_uid: eventUid,
                                                event_revision: 2,
                                            },
                                        },
                                    ],
                                    pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                                },
                            },
                        };
                    }
                    return {
                        data: {
                            events: {
                                nodes: [
                                    {
                                        parsedJson: {
                                            event_uid: eventUid,
                                            event_revision: 5,
                                        },
                                    },
                                ],
                                pageInfo: { hasNextPage: false, endCursor: null },
                            },
                        },
                    };
                },
            },
        });

        expect(result).toEqual({ latestRevision: 5, sources: ["graphql"] });
        expect(queries[0]).toContain("contents");
        expect(queries[0]).not.toContain("parsedJson");
        expect(variables).toEqual([
            { eventType: disasterEventType, cursor: null },
            { eventType: disasterEventType, cursor: "cursor-1" },
        ]);
    });

    it("uses the max revision when both dynamic-field and GraphQL sources are available", async () => {
        const result = await getLatestOnchainEventRevision({
            eventUid,
            disasterEventType,
            graphql: {
                query: async () => ({
                    data: {
                        events: {
                            nodes: [{ parsedJson: { event_uid: eventUid, event_revision: 4 } }],
                        },
                    },
                }),
            },
            dynamicField: {
                getLatestRevision: async () => ({ data: { content: { fields: { value: "7" } } } }),
            },
        });

        expect(result).toEqual({ latestRevision: 7, sources: ["dynamic-field", "graphql"] });
    });

    it("fails closed when no source is configured", async () => {
        await expect(getLatestOnchainEventRevision({ eventUid })).rejects.toThrow(
            "on-chain latest revision reader requires at least one source",
        );
    });

    it("fails closed on network failures", async () => {
        await expect(
            getLatestOnchainEventRevision({
                eventUid,
                disasterEventType,
                graphql: {
                    query: async () => {
                        throw new Error("graphql unavailable");
                    },
                },
            }),
        ).rejects.toThrow("graphql unavailable");
    });

    it("fails closed on malformed GraphQL responses", async () => {
        await expect(
            getLatestOnchainEventRevision({
                eventUid,
                disasterEventType,
                graphql: { query: async () => ({ data: { events: { nodes: "bad" } } }) },
            }),
        ).rejects.toThrow("GraphQL event nodes must be an array");
    });

    it("fails closed on invalid revisions", () => {
        expect(() =>
            parseDisasterEventCreatedRevision({ parsedJson: { event_uid: eventUid, event_revision: 0 } }, eventUid),
        ).toThrow("event_revision must be a positive u32");
        expect(() => decodeDynamicFieldRevision({ data: { content: { fields: { value: -1 } } } })).toThrow(
            "latest event revision must be a positive u32",
        );
    });

    it("distinguishes absent dynamic field from decode failures", async () => {
        const result = await getLatestOnchainEventRevision({
            eventUid,
            dynamicField: { getLatestRevision: async () => ({ error: { code: "dynamicFieldNotFound" } }) },
        });

        expect(result).toEqual({ latestRevision: 0, sources: ["dynamic-field"] });
        expect(() => decodeDynamicFieldRevision({ data: { content: { fields: {} } } })).toThrow(
            "latest event revision field is missing or malformed",
        );
    });
});
