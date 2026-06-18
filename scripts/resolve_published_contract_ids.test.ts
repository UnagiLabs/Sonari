import { describe, expect, it, vi } from "vitest";
import {
    GENESIS_OBJECT_KIND,
    parseGenesisObjectCreatedEvent,
    type QueryEventsClient,
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

function objectId(byte: string): string {
    return `0x${byte.repeat(32)}`;
}

function event(parsedJson: Record<string, unknown>): {
    readonly parsedJson: Record<string, unknown>;
} {
    return { parsedJson };
}

function genesisEvent(objectKind: number, objectIdValue: string) {
    return event({
        object_id: objectIdValue,
        object_kind: objectKind,
        shared: true,
        created_at_ms: "1",
        actor: objectId("99"),
    });
}

function registryEvent(registryId: string) {
    return event({
        registry_id: registryId,
        created_at_ms: "1",
        actor: objectId("99"),
    });
}

function clientWithEvents(
    eventsByType: Readonly<Record<string, readonly unknown[]>>,
): QueryEventsClient {
    return {
        queryEvents: vi.fn(async ({ query }) => ({
            data: eventsByType[query.MoveEventType] ?? [],
            hasNextPage: false,
        })),
    };
}

function validClient(): QueryEventsClient {
    return clientWithEvents({
        [`${PACKAGE_ID}::admin::GenesisObjectCreated`]: [
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
        ],
        [`${PACKAGE_ID}::disaster_event::DisasterRegistryCreated`]: [
            registryEvent(DISASTER_REGISTRY_ID),
        ],
    });
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

describe("parseGenesisObjectCreatedEvent", () => {
    it("keeps the genesis object kind contract for dapp object resolution", () => {
        expect(GENESIS_OBJECT_KIND.allowedResidenceCellRegistry).toBe(13);
        expect(GENESIS_OBJECT_KIND.cellCountIndex).toBe(14);
    });

    it("parses the object kind and object id", () => {
        expect(parseGenesisObjectCreatedEvent(genesisEvent(1, ADMIN_CAP_ID))).toEqual({
            objectId: ADMIN_CAP_ID,
            objectKind: 1,
        });
    });

    it("fails closed for malformed genesis events", () => {
        expect(() =>
            parseGenesisObjectCreatedEvent(event({ object_id: "bad", object_kind: 1 })),
        ).toThrow("GenesisObjectCreated event is malformed");
        expect(() => parseGenesisObjectCreatedEvent({ parsedJson: null })).toThrow(
            "Sui event did not include parsedJson",
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
            SONARI_CELL_COUNT_INDEX_ID: CELL_COUNT_INDEX_ID,
        });
        for (const envName of NEXT_PUBLIC_OBJECT_ID_ENV_NAMES) {
            expect(result.env).not.toHaveProperty(envName);
        }
    });

    it("fails closed when DisasterRegistryCreated is absent or ambiguous", async () => {
        const absentClient = validClient();
        vi.mocked(absentClient.queryEvents).mockImplementation(async ({ query }) => ({
            data:
                query.MoveEventType === `${PACKAGE_ID}::disaster_event::DisasterRegistryCreated`
                    ? []
                      : [
                            genesisEvent(GENESIS_OBJECT_KIND.adminCap, ADMIN_CAP_ID),
                            genesisEvent(GENESIS_OBJECT_KIND.pauseState, PAUSE_STATE_ID),
                            genesisEvent(GENESIS_OBJECT_KIND.mainPool, MAIN_POOL_ID),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.membershipRegistry,
                                MEMBERSHIP_REGISTRY_ID,
                            ),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.verifierRegistry,
                                VERIFIER_REGISTRY_ID,
                            ),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.identityRegistry,
                                IDENTITY_REGISTRY_ID,
                            ),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.categoryRegistry,
                                CATEGORY_REGISTRY_ID,
                            ),
                            genesisEvent(GENESIS_OBJECT_KIND.earthquakePool, EARTHQUAKE_POOL_ID),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.allowedResidenceCellRegistry,
                                ALLOWED_RESIDENCE_CELL_REGISTRY_ID,
                            ),
                            genesisEvent(GENESIS_OBJECT_KIND.cellCountIndex, CELL_COUNT_INDEX_ID),
                        ],
            hasNextPage: false,
        }));
        await expect(
            resolvePublishedContractIds({
                publishedToml,
                network: "testnet",
                client: absentClient,
            }),
        ).rejects.toThrow("DisasterRegistryCreated must resolve to exactly one registry id");

        const client = validClient();
        vi.mocked(client.queryEvents).mockImplementation(async ({ query }) => ({
            data:
                query.MoveEventType === `${PACKAGE_ID}::disaster_event::DisasterRegistryCreated`
                    ? [registryEvent(DISASTER_REGISTRY_ID), registryEvent(objectId("dd"))]
                      : [
                            genesisEvent(GENESIS_OBJECT_KIND.adminCap, ADMIN_CAP_ID),
                            genesisEvent(GENESIS_OBJECT_KIND.pauseState, PAUSE_STATE_ID),
                            genesisEvent(GENESIS_OBJECT_KIND.mainPool, MAIN_POOL_ID),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.membershipRegistry,
                                MEMBERSHIP_REGISTRY_ID,
                            ),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.verifierRegistry,
                                VERIFIER_REGISTRY_ID,
                            ),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.identityRegistry,
                                IDENTITY_REGISTRY_ID,
                            ),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.categoryRegistry,
                                CATEGORY_REGISTRY_ID,
                            ),
                            genesisEvent(GENESIS_OBJECT_KIND.earthquakePool, EARTHQUAKE_POOL_ID),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.allowedResidenceCellRegistry,
                                ALLOWED_RESIDENCE_CELL_REGISTRY_ID,
                            ),
                            genesisEvent(GENESIS_OBJECT_KIND.cellCountIndex, CELL_COUNT_INDEX_ID),
                        ],
            hasNextPage: false,
        }));
        await expect(
            resolvePublishedContractIds({ publishedToml, network: "testnet", client }),
        ).rejects.toThrow("DisasterRegistryCreated must resolve to exactly one registry id");
    });

    it("derives allowed residence registry from GenesisObjectCreated kind 13", async () => {
        const client = validClient();
        vi.mocked(client.queryEvents).mockImplementation(async ({ query }) => ({
            data:
                query.MoveEventType === `${PACKAGE_ID}::disaster_event::DisasterRegistryCreated`
                      ? [registryEvent(DISASTER_REGISTRY_ID)]
                      : [
                            genesisEvent(GENESIS_OBJECT_KIND.adminCap, ADMIN_CAP_ID),
                            genesisEvent(GENESIS_OBJECT_KIND.pauseState, PAUSE_STATE_ID),
                            genesisEvent(GENESIS_OBJECT_KIND.mainPool, MAIN_POOL_ID),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.membershipRegistry,
                                MEMBERSHIP_REGISTRY_ID,
                            ),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.verifierRegistry,
                                VERIFIER_REGISTRY_ID,
                            ),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.identityRegistry,
                                IDENTITY_REGISTRY_ID,
                            ),
                            genesisEvent(
                                GENESIS_OBJECT_KIND.categoryRegistry,
                                CATEGORY_REGISTRY_ID,
                            ),
                            genesisEvent(GENESIS_OBJECT_KIND.earthquakePool, EARTHQUAKE_POOL_ID),
                            genesisEvent(GENESIS_OBJECT_KIND.cellCountIndex, CELL_COUNT_INDEX_ID),
                        ],
            hasNextPage: false,
        }));
        await expect(
            resolvePublishedContractIds({ publishedToml, network: "testnet", client }),
        ).rejects.toThrow("GenesisObjectCreated event is missing object kind 13");

        expect(client.queryEvents).not.toHaveBeenCalledWith(
            expect.objectContaining({
                query: {
                    MoveEventType: `${PACKAGE_ID}::allowed_residence_cell::AllowedResidenceCellRootUpdated`,
                },
            }),
        );
    });

    it("fails closed on RPC errors", async () => {
        await expect(
            resolvePublishedContractIds({
                publishedToml,
                network: "testnet",
                client: {
                    queryEvents: vi.fn(async () => {
                        throw new Error("rpc unavailable");
                    }),
                },
            }),
        ).rejects.toThrow("rpc unavailable");
    });
});
