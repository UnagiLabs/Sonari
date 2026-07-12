import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createGraphqlEventClient,
    resolveGraphqlEventClientConfig,
} from "./graphql-event-client";

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("resolveGraphqlEventClientConfig", () => {
    it("uses and trims an explicit GraphQL URL", () => {
        expect(
            resolveGraphqlEventClientConfig({
                network: "testnet",
                graphqlUrl: " https://graphql.example.test/query ",
            }),
        ).toEqual({ network: "testnet", url: "https://graphql.example.test/query" });
    });

    it.each([
        ["mainnet", "https://graphql.mainnet.sui.io/graphql"],
        ["testnet", "https://graphql.testnet.sui.io/graphql"],
        ["localnet", "http://127.0.0.1:9125/graphql"],
    ] as const)("uses the %s default URL", (network, url) => {
        expect(resolveGraphqlEventClientConfig({ network, graphqlUrl: "" })).toEqual({
            network,
            url,
        });
    });

    it("uses NEXT_PUBLIC_SONARI_GRAPHQL_URL as the override", () => {
        vi.stubEnv("NEXT_PUBLIC_SONARI_GRAPHQL_URL", " https://graphql.env.test/query ");
        expect(resolveGraphqlEventClientConfig({ network: "testnet" }).url).toBe(
            "https://graphql.env.test/query",
        );
    });
});

describe("createGraphqlEventClient", () => {
    it("queries backward pages and normalizes each page in newest-first order", async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as {
                variables: { type: string; last: number; before?: string };
            };
            expect(body.variables.type).toBe("0x1::module::Created");
            expect(body.variables.last).toBe(2);
            expect(body.variables.before).toBe("next-page");
            return new Response(
                JSON.stringify({
                    data: {
                        events: {
                            nodes: [
                                {
                                    contents: { json: { value: "older" } },
                                    timestamp: "2026-07-12T00:00:00.000Z",
                                    transaction: { digest: "digest-1" },
                                    sequenceNumber: 1,
                                },
                                {
                                    contents: { json: { value: "newer" } },
                                    timestamp: "2026-07-12T00:00:01.000Z",
                                    transaction: { digest: "digest-2" },
                                    sequenceNumber: 0,
                                },
                            ],
                            pageInfo: {
                                hasPreviousPage: true,
                                startCursor: "previous-page",
                            },
                        },
                    },
                }),
                { status: 200 },
            );
        });
        const client = createGraphqlEventClient({
            network: "testnet",
            graphqlUrl: "https://graphql.example.test/query",
            fetch: fetchMock,
        });

        await expect(
            client.queryMoveEvents({
                type: "0x1::module::Created",
                cursor: "next-page",
                limit: 2,
            }),
        ).resolves.toEqual({
            data: [
                {
                    id: "digest-2:0",
                    timestampMs: Date.parse("2026-07-12T00:00:01.000Z"),
                    json: { value: "newer" },
                },
                {
                    id: "digest-1:1",
                    timestampMs: Date.parse("2026-07-12T00:00:00.000Z"),
                    json: { value: "older" },
                },
            ],
            hasNextPage: true,
            nextCursor: "previous-page",
        });
    });

    it("rejects HTTP errors", async () => {
        const client = createGraphqlEventClient({
            network: "testnet",
            fetch: vi.fn(async () => new Response("unavailable", { status: 503 })),
        });
        await expect(client.queryMoveEvents({ type: "0x1::module::Created" })).rejects.toThrow(
            "GraphQL request failed",
        );
    });

    it("rejects GraphQL errors", async () => {
        const client = createGraphqlEventClient({
            network: "testnet",
            fetch: vi.fn(
                async () =>
                    new Response(JSON.stringify({ errors: [{ message: "indexer unavailable" }] })),
            ),
        });
        await expect(client.queryMoveEvents({ type: "0x1::module::Created" })).rejects.toThrow(
            "indexer unavailable",
        );
    });

    it.each([
        { data: null },
        { data: { events: { nodes: [], pageInfo: { hasPreviousPage: true, startCursor: null } } } },
        {
            data: {
                events: {
                    nodes: [
                        {
                            contents: { json: {} },
                            timestamp: null,
                            transaction: { digest: "digest" },
                            sequenceNumber: 0,
                        },
                    ],
                    pageInfo: { hasPreviousPage: false, startCursor: "cursor" },
                },
            },
        },
    ])("rejects malformed responses", async (body) => {
        const client = createGraphqlEventClient({
            network: "testnet",
            fetch: vi.fn(async () => new Response(JSON.stringify(body))),
        });
        await expect(client.queryMoveEvents({ type: "0x1::module::Created" })).rejects.toThrow(
            "Malformed GraphQL event response",
        );
    });
});
