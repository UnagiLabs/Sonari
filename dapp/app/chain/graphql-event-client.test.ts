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
    it("caps the GraphQL page size at 50", async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as {
                variables: { last: number };
            };
            expect(body.variables.last).toBe(50);
            return new Response(
                JSON.stringify({
                    data: {
                        events: {
                            nodes: [],
                            pageInfo: { hasPreviousPage: false, startCursor: null },
                        },
                    },
                }),
            );
        });
        const client = createGraphqlEventClient({ network: "testnet", fetch: fetchMock });

        await expect(
            client.queryMoveEvents({ type: "0x1::module::Created", limit: 100 }),
        ).resolves.toEqual({ data: [], hasNextPage: false, nextCursor: null });
    });

    it.each([0, -1, 1.5])("rejects an invalid page size: %s", async (limit) => {
        const fetchMock = vi.fn();
        const client = createGraphqlEventClient({ network: "testnet", fetch: fetchMock });

        await expect(
            client.queryMoveEvents({ type: "0x1::module::Created", limit }),
        ).rejects.toThrow("GraphQL event query limit must be a positive integer");
        expect(fetchMock).not.toHaveBeenCalled();
    });

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

    it("queries objects by type with forward pagination and normalizes object IDs", async () => {
        const firstObjectId = `0x${"AA".repeat(32)}`;
        const secondObjectId = `0x${"bb".repeat(32)}`;
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as {
                query: string;
                variables: { type: string; first: number; after?: string | null };
            };
            expect(body.query).toContain(
                "objects(filter: { type: $type }, first: $first, after: $after)",
            );
            expect(body.variables).toEqual({
                type: "0x1::campaign::Campaign",
                first: 2,
                after: "cursor-1",
            });
            return new Response(
                JSON.stringify({
                    data: {
                        objects: {
                            nodes: [{ address: firstObjectId }, { address: secondObjectId }],
                            pageInfo: {
                                hasNextPage: true,
                                endCursor: "cursor-2",
                            },
                        },
                    },
                }),
            );
        });
        const client = createGraphqlEventClient({ network: "testnet", fetch: fetchMock });

        await expect(
            client.queryObjectsByType({
                type: "0x1::campaign::Campaign",
                cursor: "cursor-1",
                limit: 2,
            }),
        ).resolves.toEqual({
            data: [`0x${"aa".repeat(32)}`, secondObjectId],
            hasNextPage: true,
            nextCursor: "cursor-2",
        });
    });

    it("caps the GraphQL object page size at 50", async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as {
                variables: { first: number };
            };
            expect(body.variables.first).toBe(50);
            return new Response(
                JSON.stringify({
                    data: {
                        objects: {
                            nodes: [],
                            pageInfo: { hasNextPage: false, endCursor: null },
                        },
                    },
                }),
            );
        });
        const client = createGraphqlEventClient({ network: "testnet", fetch: fetchMock });

        await expect(
            client.queryObjectsByType({ type: "0x1::campaign::Campaign", limit: 100 }),
        ).resolves.toEqual({ data: [], hasNextPage: false, nextCursor: null });
    });

    it.each([0, -1, 1.5])("rejects an invalid object page size: %s", async (limit) => {
        const fetchMock = vi.fn();
        const client = createGraphqlEventClient({ network: "testnet", fetch: fetchMock });

        await expect(
            client.queryObjectsByType({ type: "0x1::campaign::Campaign", limit }),
        ).rejects.toThrow("GraphQL object query limit must be a positive integer");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects GraphQL object errors", async () => {
        const client = createGraphqlEventClient({
            network: "testnet",
            fetch: vi.fn(
                async () =>
                    new Response(
                        JSON.stringify({ errors: [{ message: "object index unavailable" }] }),
                    ),
            ),
        });
        await expect(
            client.queryObjectsByType({ type: "0x1::campaign::Campaign" }),
        ).rejects.toThrow("object index unavailable");
    });

    it.each([
        { data: null },
        { data: { objects: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } },
        {
            data: {
                objects: {
                    nodes: [{ address: "0xabc" }],
                    pageInfo: { hasNextPage: false, endCursor: "cursor" },
                },
            },
        },
        {
            data: {
                objects: {
                    nodes: [null],
                    pageInfo: { hasNextPage: false, endCursor: null },
                },
            },
        },
    ])("rejects malformed object responses", async (body) => {
        const client = createGraphqlEventClient({
            network: "testnet",
            fetch: vi.fn(async () => new Response(JSON.stringify(body))),
        });
        await expect(
            client.queryObjectsByType({ type: "0x1::campaign::Campaign" }),
        ).rejects.toThrow("Malformed GraphQL object response");
    });
});
