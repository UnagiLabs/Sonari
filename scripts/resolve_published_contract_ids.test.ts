import { afterEach, describe, expect, it, vi } from "vitest";
import {
    defaultGraphqlUrl,
    GENESIS_OBJECT_KIND,
    type GraphqlQueryClient,
    parseGenesisObjectCreatedEvent,
    parseResolverArgs,
    readPublishedPackageId,
    resolvePublishedContractIds,
} from "./resolve_published_contract_ids.js";

const PACKAGE_ID = objectId("aa");
const ADMIN_CAP_ID = objectId("01");
const PAUSE_STATE_ID = objectId("02");
const MAIN_POOL_ID = objectId("03");
const MEMBERSHIP_REGISTRY_ID = objectId("06");
const VERIFIER_REGISTRY_ID = objectId("07");
const IDENTITY_REGISTRY_ID = objectId("09");
const CATEGORY_REGISTRY_ID = objectId("0a");
const EARTHQUAKE_POOL_ID = objectId("0b");
const DISASTER_REGISTRY_ID = objectId("0d");
const ALLOWED_RESIDENCE_CELL_REGISTRY_ID = objectId("0e");
const CELL_COUNT_INDEX_ID = objectId("0f");
const GENESIS_EVENT_TYPE = `${PACKAGE_ID}::admin::GenesisObjectCreated`;
const DISASTER_REGISTRY_EVENT_TYPE = `${PACKAGE_ID}::disaster_event::DisasterRegistryCreated`;
const NEXT_PUBLIC_OBJECT_ID_ENV_NAMES = [
    `NEXT_PUBLIC_SONARI_${"ALLOWED_RESIDENCE_CELL_REGISTRY_ID"}`,
    `NEXT_PUBLIC_SONARI_${"IDENTITY_REGISTRY_ID"}`,
    `NEXT_PUBLIC_SONARI_${"IDENTITY_PAUSE_STATE_ID"}`,
    `NEXT_PUBLIC_SONARI_${"MEMBERSHIP_REGISTRY_ID"}`,
    `NEXT_PUBLIC_SONARI_${"CELL_COUNT_INDEX_ID"}`,
] as const;

const publishedToml = `
[published.testnet]
published-at = "${PACKAGE_ID}"

[published.mainnet]
published-at = "${objectId("bb")}"
`;

afterEach(() => {
    vi.unstubAllEnvs();
});

function objectId(byte: string): string {
    return `0x${byte.repeat(32)}`;
}

function event(type: string, json: Record<string, unknown>): unknown {
    return { contents: { type: { repr: type }, json } };
}

function genesisEvent(objectKind: number, objectIdValue: string) {
    return event(GENESIS_EVENT_TYPE, {
        object_id: objectIdValue,
        object_kind: objectKind,
        shared: true,
        created_at_ms: "1",
        actor: objectId("99"),
    });
}

function registryEvent(registryId: string) {
    return event(DISASTER_REGISTRY_EVENT_TYPE, {
        registry_id: registryId,
        created_at_ms: "1",
        actor: objectId("99"),
    });
}

function packageEventsResponse(
    nodes: readonly unknown[],
    pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null } = {
        hasNextPage: false,
        endCursor: null,
    },
): unknown {
    return {
        data: {
            object: {
                address: PACKAGE_ID,
                version: 1,
                previousTransaction: {
                    effects: {
                        events: { nodes, pageInfo },
                    },
                },
            },
        },
    };
}

function clientWithEvents(events: readonly unknown[]): GraphqlQueryClient {
    return {
        query: vi.fn(async () => packageEventsResponse(events)),
    };
}

function validClient(): GraphqlQueryClient {
    return clientWithEvents([...genesisEvents(), registryEvent(DISASTER_REGISTRY_ID)]);
}

function genesisEvents(): readonly unknown[] {
    return [
        genesisEvent(GENESIS_OBJECT_KIND.adminCap, ADMIN_CAP_ID),
        genesisEvent(GENESIS_OBJECT_KIND.pauseState, PAUSE_STATE_ID),
        genesisEvent(GENESIS_OBJECT_KIND.mainPool, MAIN_POOL_ID),
        genesisEvent(GENESIS_OBJECT_KIND.membershipRegistry, MEMBERSHIP_REGISTRY_ID),
        genesisEvent(GENESIS_OBJECT_KIND.verifierRegistry, VERIFIER_REGISTRY_ID),
        genesisEvent(GENESIS_OBJECT_KIND.identityRegistry, IDENTITY_REGISTRY_ID),
        genesisEvent(GENESIS_OBJECT_KIND.categoryRegistry, CATEGORY_REGISTRY_ID),
        genesisEvent(GENESIS_OBJECT_KIND.earthquakePool, EARTHQUAKE_POOL_ID),
        genesisEvent(
            GENESIS_OBJECT_KIND.allowedResidenceCellRegistry,
            ALLOWED_RESIDENCE_CELL_REGISTRY_ID,
        ),
        genesisEvent(GENESIS_OBJECT_KIND.cellCountIndex, CELL_COUNT_INDEX_ID),
    ];
}

describe("readPublishedPackageId", () => {
    it("reads the package id for the selected network from Published.toml", () => {
        expect(readPublishedPackageId(publishedToml, "testnet")).toBe(PACKAGE_ID);
        expect(readPublishedPackageId(publishedToml, "mainnet")).toBe(objectId("bb"));
    });

    it("fails closed when the network section or package id is missing", () => {
        expect(() => readPublishedPackageId(publishedToml, "devnet")).toThrow(
            "missing a valid published-at",
        );
        expect(() =>
            readPublishedPackageId('[published.testnet]\npublished-at = "0x1234"\n', "testnet"),
        ).toThrow("missing a valid published-at");
    });
});

describe("defaultGraphqlUrl", () => {
    it.each([
        ["mainnet", "https://graphql.mainnet.sui.io/graphql"],
        ["testnet", "https://graphql.testnet.sui.io/graphql"],
        ["localnet", "http://127.0.0.1:9125/graphql"],
    ])("uses the %s GraphQL endpoint", (network, expected) => {
        expect(defaultGraphqlUrl(network)).toBe(expected);
    });
});

describe("parseResolverArgs", () => {
    it("uses the GraphQL URL environment override", () => {
        vi.stubEnv("SONARI_SUI_NETWORK", "mainnet");
        vi.stubEnv("SONARI_SUI_GRAPHQL_URL", " https://graphql.env.test/query ");

        expect(parseResolverArgs([])).toEqual({
            network: "mainnet",
            publishedTomlPath: "contracts/Published.toml",
            graphqlUrl: "https://graphql.env.test/query",
        });
    });

    it("gives explicit GraphQL arguments precedence", () => {
        vi.stubEnv("SONARI_SUI_GRAPHQL_URL", "https://graphql.env.test/query");

        expect(
            parseResolverArgs([
                "--network",
                "localnet",
                "--published-toml",
                "custom/Published.toml",
                "--graphql-url",
                "https://graphql.cli.test/query",
            ]),
        ).toEqual({
            network: "localnet",
            publishedTomlPath: "custom/Published.toml",
            graphqlUrl: "https://graphql.cli.test/query",
        });
    });
});

describe("parseGenesisObjectCreatedEvent", () => {
    it("keeps the genesis object kind contract for dapp object resolution", () => {
        expect(GENESIS_OBJECT_KIND.allowedResidenceCellRegistry).toBe(13);
        expect(GENESIS_OBJECT_KIND.cellCountIndex).toBe(14);
    });

    it("parses the object kind and object id", () => {
        expect(
            parseGenesisObjectCreatedEvent({ json: { object_id: ADMIN_CAP_ID, object_kind: 1 } }),
        ).toEqual({
            objectId: ADMIN_CAP_ID,
            objectKind: 1,
        });
    });

    it("fails closed for malformed genesis events", () => {
        expect(() =>
            parseGenesisObjectCreatedEvent({ json: { object_id: "bad", object_kind: 1 } }),
        ).toThrow("GenesisObjectCreated event is malformed");
        expect(() => parseGenesisObjectCreatedEvent({ json: null })).toThrow(
            "Sui event did not include JSON contents",
        );
    });
});

describe("resolvePublishedContractIds", () => {
    it("derives package, genesis object, disaster registry, allowed residence registry, and target env values", async () => {
        const result = await resolvePublishedContractIds({
            publishedToml,
            network: "testnet",
            client: validClient(),
        });

        expect(result.packageId).toBe(PACKAGE_ID);
        expect(result.env).toMatchObject({
            SONARI_IDENTITY_PACKAGE_ID: PACKAGE_ID,
            RELAYER_TARGET: `${PACKAGE_ID}::accessor::create_disaster_event_and_campaign_from_signed_payload`,
            FLOOR_CENSUS_TARGET: `${PACKAGE_ID}::accessor::set_floor_census`,
            SONARI_ADMIN_CAP_ID: ADMIN_CAP_ID,
            SONARI_IDENTITY_PAUSE_STATE_ID: PAUSE_STATE_ID,
            SONARI_FLOOR_CENSUS_PAUSE_STATE: PAUSE_STATE_ID,
            SONARI_FLOOR_CENSUS_MAIN_POOL: MAIN_POOL_ID,
            FLOOR_CENSUS_PAUSE_STATE: PAUSE_STATE_ID,
            FLOOR_CENSUS_MAIN_POOL: MAIN_POOL_ID,
            SONARI_MEMBERSHIP_REGISTRY_ID: MEMBERSHIP_REGISTRY_ID,
            SONARI_CELL_COUNT_INDEX_ID: CELL_COUNT_INDEX_ID,
            FLOOR_CENSUS_CELL_COUNT_INDEX: CELL_COUNT_INDEX_ID,
            SONARI_VERIFIER_REGISTRY_ID: VERIFIER_REGISTRY_ID,
            SONARI_IDENTITY_REGISTRY_ID: IDENTITY_REGISTRY_ID,
            SONARI_CATEGORY_REGISTRY_ID: CATEGORY_REGISTRY_ID,
            SONARI_EARTHQUAKE_CATEGORY_POOL_ID: EARTHQUAKE_POOL_ID,
            SONARI_FLOOR_CENSUS_CATEGORY_POOL: EARTHQUAKE_POOL_ID,
            FLOOR_CENSUS_CATEGORY_POOL: EARTHQUAKE_POOL_ID,
            RELAYER_VERIFIER_REGISTRY: VERIFIER_REGISTRY_ID,
            RELAYER_CATEGORY_REGISTRY: CATEGORY_REGISTRY_ID,
            RELAYER_CATEGORY_POOL: EARTHQUAKE_POOL_ID,
            RELAYER_REGISTRY: DISASTER_REGISTRY_ID,
            SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID: ALLOWED_RESIDENCE_CELL_REGISTRY_ID,
        });
        for (const envName of NEXT_PUBLIC_OBJECT_ID_ENV_NAMES) {
            expect(result.env).not.toHaveProperty(envName);
        }
    });

    it("fails closed when DisasterRegistryCreated is absent or ambiguous", async () => {
        const absentClient = clientWithEvents(genesisEvents());
        await expect(
            resolvePublishedContractIds({
                publishedToml,
                network: "testnet",
                client: absentClient,
            }),
        ).rejects.toThrow("DisasterRegistryCreated must resolve to exactly one registry id");

        const client = clientWithEvents([
            ...genesisEvents(),
            registryEvent(DISASTER_REGISTRY_ID),
            registryEvent(objectId("dd")),
        ]);
        await expect(
            resolvePublishedContractIds({ publishedToml, network: "testnet", client }),
        ).rejects.toThrow("DisasterRegistryCreated must resolve to exactly one registry id");
    });

    it("derives allowed residence registry from GenesisObjectCreated kind 13", async () => {
        const client = clientWithEvents([
            ...genesisEvents().filter((_node, index) => index !== 8),
            registryEvent(DISASTER_REGISTRY_ID),
        ]);
        await expect(
            resolvePublishedContractIds({ publishedToml, network: "testnet", client }),
        ).rejects.toThrow("GenesisObjectCreated event is missing object kind 13");

        expect(client.query).toHaveBeenCalledTimes(1);
    });

    it("reads the package publish transaction and follows its event pages", async () => {
        const firstPage = genesisEvents().slice(0, 5);
        const secondPage = [...genesisEvents().slice(5), registryEvent(DISASTER_REGISTRY_ID)];
        const client: GraphqlQueryClient = {
            query: vi.fn(async ({ variables }) => {
                return variables.after === null
                    ? packageEventsResponse(firstPage, {
                          hasNextPage: true,
                          endCursor: "next-page",
                      })
                    : packageEventsResponse(secondPage);
            }),
        };

        await expect(
            resolvePublishedContractIds({ publishedToml, network: "testnet", client }),
        ).resolves.toMatchObject({ packageId: PACKAGE_ID });
        expect(client.query).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: {
                    packageId: PACKAGE_ID,
                    first: 50,
                    after: null,
                },
            }),
        );
        expect(client.query).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: {
                    packageId: PACKAGE_ID,
                    first: 50,
                    after: "next-page",
                },
            }),
        );
        expect(vi.mocked(client.query).mock.calls[0]?.[0].query).toContain(
            "object(address: $packageId)",
        );
    });

    it("fails closed on GraphQL errors and malformed responses", async () => {
        const malformedResponses: readonly unknown[] = [
            { errors: [{ message: "indexer unavailable" }] },
            { data: null },
            {
                data: {
                    object: {
                        address: objectId("bb"),
                        version: 1,
                        previousTransaction: null,
                    },
                },
            },
            packageEventsResponse([], { hasNextPage: true, endCursor: null }),
            packageEventsResponse([{ contents: { type: null, json: {} } }]),
        ];
        for (const response of malformedResponses) {
            await expect(
                resolvePublishedContractIds({
                    publishedToml,
                    network: "testnet",
                    client: { query: vi.fn(async () => response) },
                }),
            ).rejects.toThrow();
        }
    });

    it("fails closed when a GraphQL page cursor does not advance", async () => {
        await expect(
            resolvePublishedContractIds({
                publishedToml,
                network: "testnet",
                client: {
                    query: vi.fn(async () =>
                        packageEventsResponse([], {
                            hasNextPage: true,
                            endCursor: "repeated-cursor",
                        }),
                    ),
                },
            }),
        ).rejects.toThrow("Malformed GraphQL event response");
    });

    it("fails closed on GraphQL transport errors", async () => {
        await expect(
            resolvePublishedContractIds({
                publishedToml,
                network: "testnet",
                client: {
                    query: vi.fn(async () => {
                        throw new Error("graphql unavailable");
                    }),
                },
            }),
        ).rejects.toThrow("graphql unavailable");
    });
});
