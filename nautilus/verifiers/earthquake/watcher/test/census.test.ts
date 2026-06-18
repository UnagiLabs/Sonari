import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
    buildFloorCensusInputBundle,
    computeFloorCensusCounts,
    computeFloorCensusSnapshot,
    DirectFloorCensusAdapter,
    encodeFloorCensusResultBcs,
    type FloorCensusAffectedCellsResolver,
    type FloorCensusOnchainReader,
    type FloorCensusSubmitClient,
    GraphqlFloorCensusReader,
    JsonRpcFloorCensusReader,
    parseFloorCensusTeeOutput,
    signFloorCensusResult,
    TeeFloorCensusAdapter,
    type HomeCellRegisteredEvent,
} from "../src/census.js";
import {
    BCS_ENUMS,
    encodeEarthquakeOraclePayloadBcsHex,
    type EarthquakeOraclePayload,
    type EnclaveVerificationMetadata,
} from "@sonari/earthquake-shared";
import type { RelayerSigner } from "@sonari/earthquake-relayer";

const eventUid = `0x${"aa".repeat(32)}`;
const affectedCellsRoot = `0x${"bb".repeat(32)}`;
const membershipRegistryId = `0x${"22".repeat(32)}`;
const cellCountIndexId = `0x${"33".repeat(32)}`;
const countedCellsRoot = `0x${"cc".repeat(32)}`;
const censusRegistrationMetadata: EnclaveVerificationMetadata = {
    verifier_config_key: 3,
    verifier_config_version: 7,
    enclave_instance_public_key: `0x${"22".repeat(32)}`,
};
const originalFetch = globalThis.fetch;

const affectedCells = {
    event_uid: eventUid,
    event_revision: 7,
    oracle_version: 1,
    geo_resolution: 7,
    cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
    cell_metric: "USGS_MMI",
    cell_aggregation: "GRID_POINT_P90",
    intensity_scale: "MMI_X100",
    affected_cells: [
        { h3_index: "10", intensity_value: 500, cell_band: 1 },
        { h3_index: "20", intensity_value: 600, cell_band: 2 },
        { h3_index: "30", intensity_value: 700, cell_band: 3 },
    ],
};

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("floor census core", () => {
    it("uses the last pre-cutoff home cell, filters active lineages, and counts by band", () => {
        const expectedAffectedCellsRoot = expectedRoot();
        const events: HomeCellRegisteredEvent[] = [
            { lineage: "0xlineage1", homeCell: "10", registeredAtMs: 900 },
            { lineage: "0xlineage1", homeCell: "20", registeredAtMs: 999 },
            { lineage: "0xlineage1", homeCell: "30", registeredAtMs: 1_000 },
            { lineage: "0xlineage2", homeCell: "30", registeredAtMs: 800 },
            { lineage: "0xlineage3", homeCell: "20", registeredAtMs: 700 },
            { lineage: "0xlineage4", homeCell: "40", registeredAtMs: 700 },
        ];

        const snapshot = computeFloorCensusSnapshot({
            affectedCells,
            homeCellEvents: events,
            activeLineages: new Set(["0xlineage1", "0xlineage2", "0xlineage4"]),
            cutoffMs: 1_000,
            expectedAffectedCellsRoot,
            eventUid,
            eventRevision: 7,
        });

        expect(snapshot.counts).toEqual([0n, 1n, 1n]);
        expect(snapshot.countedCellsRoot).toBe(
            computeCountedCellsRootForTest([
                { h3: 10n, band: 1, count: 0n },
                { h3: 20n, band: 2, count: 1n },
                { h3: 30n, band: 3, count: 1n },
            ]),
        );
        expect(
            computeFloorCensusCounts({
                affectedCells,
                homeCellEvents: events,
                activeLineages: new Set(["0xlineage1", "0xlineage2", "0xlineage4"]),
                cutoffMs: 1_000,
                expectedAffectedCellsRoot,
                eventUid,
                eventRevision: 7,
            }),
        ).toEqual([0n, 1n, 1n]);
    });

    it("fails closed when affected cell leaves do not match the signed root", () => {
        expect(() =>
            computeFloorCensusCounts({
                affectedCells,
                homeCellEvents: [],
                activeLineages: new Set(),
                cutoffMs: 1_000,
                expectedAffectedCellsRoot: affectedCellsRoot,
                eventUid,
                eventRevision: 7,
            }),
        ).toThrow(/Merkle root/);
    });

    it("encodes census_result BCS in schema order without vector prefixes for bytes32 fields", () => {
        const encoded = encodeFloorCensusResultBcs({
            eventUid,
            eventRevision: 7,
            affectedCellsRoot,
            membershipRegistryId,
            cellCountIndexId,
            censusCheckpoint: 41,
            registeredMembersByBand: [1n, 2n, 3n],
            countedCellsRoot,
            issuedAtMs: 1_234,
        });

        expect(Buffer.from(encoded).toString("hex")).toBe(
            [
                "16534f4e4152495f464c4f4f525f43454e5355535f5631",
                "0663656e737573",
                "0100000000000000",
                "aa".repeat(32),
                "07000000",
                "bb".repeat(32),
                "22".repeat(32),
                "33".repeat(32),
                "2900000000000000",
                "07",
                "0010000000000000",
                "03",
                "0100000000000000",
                "0200000000000000",
                "0300000000000000",
                "cc".repeat(32),
                "d204000000000000",
            ].join(""),
        );
    });

    it("signs raw census BCS bytes with the relayer key interface", async () => {
        const recorder = new RecordingSigner();
        const signed = await signFloorCensusResult(recorder.asSigner(), {
            eventUid,
            eventRevision: 7,
            affectedCellsRoot,
            membershipRegistryId,
            cellCountIndexId,
            censusCheckpoint: 41,
            registeredMembersByBand: [1n, 2n, 3n],
            countedCellsRoot,
            issuedAtMs: 1_234,
        });

        expect(recorder.signedBytes).toEqual(signed.censusBcs);
        expect(signed.signature).toHaveLength(64);
        expect(signed.publicKey).toHaveLength(32);
        expect(signed.signatureHex).toBe(`0x${"11".repeat(64)}`);
        expect(signed.publicKeyHex).toBe(`0x${"22".repeat(32)}`);
    });

    it("builds a Census TEE input bundle without replay-derived membership data", async () => {
        const bundle = await buildFloorCensusInputBundle({
            result: finalizedResultForCensus(),
            packageId: `0x${"99".repeat(32)}`,
            campaignId: `0x${"44".repeat(32)}`,
            disasterEventId: `0x${"55".repeat(32)}`,
            membershipRegistryId,
            issuedAtMs: 1_800_000_001_000,
        });

        expect(bundle).toMatchObject({
            package_id: `0x${"99".repeat(32)}`,
            event_uid: eventUid,
            event_revision: 7,
            occurred_at_ms: 1_000,
            affected_cells_root: expectedRoot(),
            issued_at_ms: 1_800_000_001_000,
            campaign_id: `0x${"44".repeat(32)}`,
            disaster_event_id: `0x${"55".repeat(32)}`,
            membership_registry_id: membershipRegistryId,
        });
        expect(bundle.affected_cells).toEqual({ ...affectedCells, event_revision: 7 });
        expect("home_cell_events" in bundle).toBe(false);
        expect("active_lineages" in bundle).toBe(false);
        expect("counted_cells_root" in bundle).toBe(false);
    });

    it("resolves affected cells from stored references when the finalized result omits the inline artifact", async () => {
        const { affected_cells: _affectedCells, ...baseResult } = finalizedResultForCensus();
        const result = {
            ...baseResult,
            affected_cells_ref: {
                uri: "walrus://blob/affectedCells_123456",
                walrus_blob_id: "affectedCells_123456",
                source_hash: `0x${"66".repeat(32)}`,
                size_bytes: 123,
            },
        };
        const resolver = new RecordingAffectedCellsResolver();

        const bundle = await buildFloorCensusInputBundle({
            result,
            packageId: `0x${"99".repeat(32)}`,
            campaignId: `0x${"44".repeat(32)}`,
            disasterEventId: `0x${"55".repeat(32)}`,
            membershipRegistryId,
            issuedAtMs: 1_800_000_001_000,
            affectedCellsResolver: resolver,
        });

        expect(bundle.affected_cells).toEqual({ ...affectedCells, event_revision: 7 });
        expect(resolver.inputs).toEqual([
            {
                affectedCellsRef: result.affected_cells_ref,
                evidenceManifest: undefined,
            },
        ]);
    });

    it("parses Census TEE output into raw submit bytes and counts", () => {
        const parsed = parseFloorCensusTeeOutput({
            status: "finalized",
            payload: {
                event_uid: eventUid,
                event_revision: 7,
                affected_cells_root: affectedCellsRoot,
                membership_registry_id: membershipRegistryId,
                cell_count_index_id: cellCountIndexId,
                census_checkpoint: 41,
                registered_members_by_band: [1, "2", 3],
            },
            payload_bcs_hex: `0x${"aa".repeat(8)}`,
            signature: `0x${"11".repeat(64)}`,
            public_key: `0x${"22".repeat(32)}`,
        });

        expect(parsed.counts).toEqual([1n, 2n, 3n]);
        expect(parsed.censusBcs).toEqual(Uint8Array.from({ length: 8 }, () => 0xaa));
        expect(parsed.signature).toHaveLength(64);
        expect(parsed.publicKey).toHaveLength(32);
        expect(parsed.payload.cellCountIndexId).toBe(cellCountIndexId);
    });

    it("fails closed on malformed Census TEE output", () => {
        expect(() =>
            parseFloorCensusTeeOutput({
                payload: { registered_members_by_band: [1, 2] },
                payload_bcs_hex: "0xaa",
                signature: `0x${"11".repeat(64)}`,
                public_key: `0x${"22".repeat(32)}`,
            }),
        ).toThrow("registered_members_by_band");
    });
});

describe("JsonRpcFloorCensusReader", () => {
    it("retries a rate-limited event page request and uses the Sui page limit", async () => {
        const requests: unknown[] = [];
        globalThis.fetch = async (_input, init) => {
            requests.push(JSON.parse(String(init?.body)));
            if (requests.length === 1) {
                return jsonResponse({}, { status: 429, headers: { "retry-after": "0" } });
            }
            return jsonResponse({
                result: {
                    data: [
                        {
                            parsedJson: {
                                lineage: "0xlineage1",
                                home_cell: "10",
                                registered_at: 900,
                            },
                        },
                    ],
                    nextCursor: null,
                    hasNextPage: false,
                },
            });
        };

        const reader = new JsonRpcFloorCensusReader("https://rpc.example");
        const events = await reader.listHomeCellRegisteredEvents({ packageId: "0xpackage" });

        expect(events).toEqual([
            { lineage: "0xlineage1", homeCell: "10", registeredAtMs: 900 },
        ]);
        expect(requests).toHaveLength(2);
        expect(requests).toEqual([
            expect.objectContaining({
                method: "suix_queryEvents",
                params: [{ MoveEventType: "0xpackage::membership::HomeCellRegistered" }, null, 50, false],
            }),
            expect.objectContaining({
                method: "suix_queryEvents",
                params: [{ MoveEventType: "0xpackage::membership::HomeCellRegistered" }, null, 50, false],
            }),
        ]);
    });

    it("does not retry non-rate-limited client errors", async () => {
        let requests = 0;
        globalThis.fetch = async () => {
            requests += 1;
            return jsonResponse({}, { status: 400 });
        };

        const reader = new JsonRpcFloorCensusReader("https://rpc.example");
        await expect(reader.listHomeCellRegisteredEvents({ packageId: "0xpackage" })).rejects.toThrow(
            "Sui RPC suix_queryEvents failed with HTTP 400",
        );
        expect(requests).toBe(1);
    });
});

describe("GraphqlFloorCensusReader", () => {
    it("reads active membership lineages from GraphQL dynamic fields", async () => {
        const activeLineage = `0x${"11".repeat(32)}`;
        const inactiveLineage = `0x${"22".repeat(32)}`;
        const missingLineage = `0x${"33".repeat(32)}`;
        globalThis.fetch = async () =>
            jsonResponse({
                data: {
                    object: {
                        multiGetDynamicFields: [
                            { contents: { json: { status: 1 } } },
                            { contents: { json: { status: 0 } } },
                            null,
                        ],
                    },
                },
            });

        const reader = new GraphqlFloorCensusReader("https://graphql.example");
        await expect(
            reader.listActiveLineages({
                membershipRegistryId: "0xmembership",
                lineages: [activeLineage, inactiveLineage, missingLineage],
            }),
        ).resolves.toEqual(new Set([activeLineage]));
    });

    it("passes the membership checkpoint to the GraphQL object lookup", async () => {
        const requests: Array<{ variables: Record<string, unknown> }> = [];
        globalThis.fetch = async (_input, init) => {
            const request = JSON.parse(String(init?.body)) as {
                variables: Record<string, unknown>;
            };
            requests.push(request);
            return jsonResponse({
                data: {
                    object: {
                        multiGetDynamicFields: [null],
                    },
                },
            });
        };

        const reader = new GraphqlFloorCensusReader("https://graphql.example");
        await reader.listActiveLineages({
            membershipRegistryId: "0xmembership",
            lineages: [`0x${"11".repeat(32)}`],
            checkpoint: 41,
        });

        expect(requests[0]?.variables).toMatchObject({
            membershipRegistryId: "0xmembership",
            checkpoint: 41,
        });
    });

    it("reads active membership status from GraphQL dynamic field value objects", async () => {
        const activeLineage = `0x${"11".repeat(32)}`;
        globalThis.fetch = async () =>
            jsonResponse({
                data: {
                    object: {
                        multiGetDynamicFields: [
                            {
                                contents: {
                                    json: {
                                        id: "0xfield",
                                        name: activeLineage,
                                        value: {
                                            status: 1,
                                        },
                                    },
                                },
                            },
                        ],
                    },
                },
            });

        const reader = new GraphqlFloorCensusReader("https://graphql.example");
        await expect(
            reader.listActiveLineages({
                membershipRegistryId: "0xmembership",
                lineages: [activeLineage],
            }),
        ).resolves.toEqual(new Set([activeLineage]));
    });

    it("encodes lineage object IDs as GraphQL dynamic field key BCS bytes", async () => {
        const requests: Array<{ variables: Record<string, unknown> }> = [];
        globalThis.fetch = async (_input, init) => {
            const request = JSON.parse(String(init?.body)) as {
                variables: Record<string, unknown>;
            };
            requests.push(request);
            return jsonResponse({
                data: {
                    object: {
                        multiGetDynamicFields: [null],
                    },
                },
            });
        };

        const lineage = `0x${"11".repeat(32)}`;
        const reader = new GraphqlFloorCensusReader("https://graphql.example");
        await reader.listActiveLineages({
            membershipRegistryId: "0xmembership",
            lineages: [lineage],
        });

        expect(requests[0]?.variables.keys).toEqual([
            {
                type: "0x2::object::ID",
                bcs: Buffer.from("11".repeat(32), "hex").toString("base64"),
            },
        ]);
    });

    it("fails closed when a GraphQL membership dynamic field status is malformed", async () => {
        globalThis.fetch = async () =>
            jsonResponse({
                data: {
                    object: {
                        multiGetDynamicFields: [{ contents: { json: { status: "active" } } }],
                    },
                },
            });

        const reader = new GraphqlFloorCensusReader("https://graphql.example");
        await expect(
            reader.listActiveLineages({
                membershipRegistryId: "0xmembership",
                lineages: [`0x${"11".repeat(32)}`],
            }),
        ).rejects.toThrow("membership dynamic field status is malformed");
    });

    it("paginates HomeCellRegistered events and includes the checkpoint boundary", async () => {
        const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
        globalThis.fetch = async (_input, init) => {
            const request = JSON.parse(String(init?.body)) as {
                query: string;
                variables: Record<string, unknown>;
            };
            requests.push(request);
            if (request.variables.cursor === null) {
                return jsonResponse({
                    data: {
                        events: {
                            nodes: [
                                {
                                    contents: {
                                        json: {
                                            lineage: "0xlineage1",
                                            home_cell: "10",
                                            registered_at: "900",
                                        },
                                    },
                                },
                            ],
                            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                        },
                    },
                });
            }
            return jsonResponse({
                data: {
                    events: {
                        nodes: [
                            {
                                contents: {
                                    json: {
                                        lineage: { id: "0xlineage2" },
                                        home_cell: 20,
                                        registered_at: 950,
                                    },
                                },
                            },
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null },
                    },
                },
            });
        };

        const reader = new GraphqlFloorCensusReader("https://graphql.example");
        const events = await reader.listHomeCellRegisteredEvents({
            packageId: "0xpackage",
            checkpoint: 41,
        });

        expect(events).toEqual([
            { lineage: "0xlineage1", homeCell: "10", registeredAtMs: 900 },
            { lineage: "0xlineage2", homeCell: "20", registeredAtMs: 950 },
        ]);
        expect(requests).toHaveLength(2);
        expect(requests[0]?.query).toContain("beforeCheckpoint");
        expect(requests.map((request) => request.variables)).toEqual([
            {
                eventType: "0xpackage::membership::HomeCellRegistered",
                beforeCheckpoint: 42,
                cursor: null,
            },
            {
                eventType: "0xpackage::membership::HomeCellRegistered",
                beforeCheckpoint: 42,
                cursor: "cursor-1",
            },
        ]);
    });

    it("fails closed when a HomeCellRegistered GraphQL event is malformed", async () => {
        globalThis.fetch = async () =>
            jsonResponse({
                data: {
                    events: {
                        nodes: [{ contents: { json: { lineage: "0xlineage1", home_cell: "bad" } } }],
                        pageInfo: { hasNextPage: false, endCursor: null },
                    },
                },
            });

        const reader = new GraphqlFloorCensusReader("https://graphql.example");
        await expect(reader.listHomeCellRegisteredEvents({ packageId: "0xpackage" })).rejects.toThrow(
            "HomeCellRegistered event is malformed",
        );
    });

    it("fails closed on HTTP errors, GraphQL errors, and malformed pages", async () => {
        const reader = new GraphqlFloorCensusReader("https://graphql.example");

        globalThis.fetch = async () => jsonResponse({}, { status: 500 });
        await expect(reader.listHomeCellRegisteredEvents({ packageId: "0xpackage" })).rejects.toThrow(
            "Sui GraphQL query failed with HTTP 500",
        );

        globalThis.fetch = async () =>
            jsonResponse({ errors: [{ message: "indexer unavailable" }] });
        await expect(reader.listHomeCellRegisteredEvents({ packageId: "0xpackage" })).rejects.toThrow(
            "Sui GraphQL query failed: indexer unavailable",
        );

        globalThis.fetch = async () =>
            jsonResponse({
                data: {
                    events: {
                        nodes: [],
                        pageInfo: { hasNextPage: true, endCursor: null },
                    },
                },
            });
        await expect(reader.listHomeCellRegisteredEvents({ packageId: "0xpackage" })).rejects.toThrow(
            "GraphQL events pageInfo is malformed",
        );
    });

    it("reads campaign id and checkpoint from a paginated CampaignCreated GraphQL event", async () => {
        const requests: Array<{ variables: Record<string, unknown> }> = [];
        globalThis.fetch = async (_input, init) => {
            const request = JSON.parse(String(init?.body)) as {
                variables: Record<string, unknown>;
            };
            requests.push(request);
            if (request.variables.eventsCursor === null) {
                return jsonResponse({
                    data: {
                        transaction: {
                            effects: {
                                checkpoint: { sequenceNumber: "41" },
                                events: {
                                    nodes: [],
                                    pageInfo: { hasNextPage: true, endCursor: "events-1" },
                                },
                                objectChanges: {
                                    nodes: [],
                                    pageInfo: { hasNextPage: false, endCursor: null },
                                },
                            },
                        },
                    },
                });
            }
            return jsonResponse({
                data: {
                    transaction: {
                        effects: {
                            checkpoint: { sequenceNumber: "41" },
                            events: {
                                nodes: [
                                    {
                                        contents: {
                                            json: {
                                                campaign_id: "0xcampaign-event",
                                                event_uid: Buffer.from(
                                                    eventUid.slice(2),
                                                    "hex",
                                                ).toString("base64"),
                                                event_revision: 7,
                                            },
                                        },
                                    },
                                ],
                                pageInfo: { hasNextPage: false, endCursor: null },
                            },
                            objectChanges: {
                                nodes: [],
                                pageInfo: { hasNextPage: false, endCursor: null },
                            },
                        },
                    },
                },
            });
        };

        const reader = new GraphqlFloorCensusReader("https://graphql.example");
        await expect(
            reader.findCampaignId({
                digest: "tx-digest",
                eventUid,
                eventRevision: 7,
            }),
        ).resolves.toEqual({ campaignId: "0xcampaign-event", checkpoint: 41 });
        expect(requests.map((request) => request.variables.eventsCursor)).toEqual([
            null,
            "events-1",
        ]);
    });

    it("falls back to a unique paginated Campaign object change candidate", async () => {
        const requests: Array<{ variables: Record<string, unknown> }> = [];
        globalThis.fetch = async (_input, init) => {
            const request = JSON.parse(String(init?.body)) as {
                variables: Record<string, unknown>;
            };
            requests.push(request);
            if (request.variables.objectChangesCursor === null) {
                return jsonResponse({
                    data: {
                        transaction: {
                            effects: {
                                checkpoint: { sequenceNumber: 41 },
                                events: {
                                    nodes: [],
                                    pageInfo: { hasNextPage: false, endCursor: null },
                                },
                                objectChanges: {
                                    nodes: [],
                                    pageInfo: { hasNextPage: true, endCursor: "changes-1" },
                                },
                            },
                        },
                    },
                });
            }
            return jsonResponse({
                data: {
                    transaction: {
                        effects: {
                            checkpoint: { sequenceNumber: 41 },
                            events: {
                                nodes: [],
                                pageInfo: { hasNextPage: false, endCursor: null },
                            },
                            objectChanges: {
                                nodes: [
                                    {
                                        address: "0xcampaign-object",
                                        outputState: {
                                            address: "0xcampaign-object",
                                            asMoveObject: {
                                                contents: {
                                                    type: {
                                                        repr: "0xabc::campaign::Campaign",
                                                    },
                                                },
                                            },
                                        },
                                    },
                                ],
                                pageInfo: { hasNextPage: false, endCursor: null },
                            },
                        },
                    },
                },
            });
        };

        const reader = new GraphqlFloorCensusReader("https://graphql.example");
        await expect(
            reader.findCampaignId({
                digest: "tx-digest",
                eventUid,
                eventRevision: 7,
            }),
        ).resolves.toEqual({ campaignId: "0xcampaign-object", checkpoint: 41 });
        expect(requests.map((request) => request.variables.objectChangesCursor)).toEqual([
            null,
            "changes-1",
        ]);
    });

    it("fails closed when a campaign transaction has no checkpoint", async () => {
        globalThis.fetch = async () =>
            jsonResponse({
                data: {
                    transaction: {
                        effects: {
                            checkpoint: null,
                            events: {
                                nodes: [],
                                pageInfo: { hasNextPage: false, endCursor: null },
                            },
                            objectChanges: {
                                nodes: [],
                                pageInfo: { hasNextPage: false, endCursor: null },
                            },
                        },
                    },
                },
            });

        const reader = new GraphqlFloorCensusReader("https://graphql.example");
        await expect(
            reader.findCampaignId({
                digest: "tx-digest",
                eventUid,
                eventRevision: 7,
            }),
        ).rejects.toThrow("relayer transaction checkpoint is missing");
    });

    it("fails closed when multiple Campaign object change candidates exist", async () => {
        globalThis.fetch = async () =>
            jsonResponse({
                data: {
                    transaction: {
                        effects: {
                            checkpoint: { sequenceNumber: 41 },
                            events: {
                                nodes: [],
                                pageInfo: { hasNextPage: false, endCursor: null },
                            },
                            objectChanges: {
                                nodes: [
                                    campaignObjectChange("0xcampaign-1"),
                                    campaignObjectChange("0xcampaign-2"),
                                ],
                                pageInfo: { hasNextPage: false, endCursor: null },
                            },
                        },
                    },
                },
            });

        const reader = new GraphqlFloorCensusReader("https://graphql.example");
        await expect(
            reader.findCampaignId({
                digest: "tx-digest",
                eventUid,
                eventRevision: 7,
            }),
        ).rejects.toThrow("relayer transaction included multiple Campaign object changes");
    });
});

describe("DirectFloorCensusAdapter", () => {
    it("looks up the campaign and signs census with the payload revision", async () => {
        const result = finalizedResultForCensus();
        const reader = new RecordingFloorCensusReader();
        const signer = new RecordingSigner();
        const client = new RecordingFloorCensusSubmitClient();
        const adapter = new DirectFloorCensusAdapter({
            target: "0xabc::accessor::set_floor_census",
            pauseState: "0xpause",
            verifierRegistry: "0xverifier",
            categoryPool: "0xcategory",
            mainPool: "0xmain",
            membershipRegistry: membershipRegistryId,
            cellCountIndex: cellCountIndexId,
            signer: signer.asSigner(),
            reader,
            client,
            now: () => 1_800_000_001_000,
        });

        await expect(
            adapter.run({
                sourceEventId: "us7000sonari",
                result,
                relayerDigest: "tx-digest",
                disasterEventId: `0x${"88".repeat(32)}`,
            }),
        ).resolves.toMatchObject({
            status: "succeeded",
            campaignId: `0x${"77".repeat(32)}`,
        });

        expect(reader.campaignLookups).toEqual([
            {
                digest: "tx-digest",
                eventUid,
                eventRevision: 7,
            },
        ]);
        expect(reader.homeCellLookups).toEqual([{ packageId: "0xabc", checkpoint: 41 }]);
        expect(reader.activeLineageLookups).toEqual([
            {
                membershipRegistryId,
                lineages: ["0xlineage"],
                checkpoint: 41,
            },
        ]);
        const signedHex = Buffer.from(signer.signedBytes ?? []).toString("hex");
        expect(signedHex).toContain("07000000");
        expect(signedHex).toContain(
            computeCountedCellsRootForTest([
                { h3: 10n, band: 1, count: 0n },
                { h3: 20n, band: 2, count: 1n },
                { h3: 30n, band: 3, count: 0n },
            ]).slice(2),
        );
        expect(client.submissions).toHaveLength(1);
    });
});

describe("TeeFloorCensusAdapter", () => {
    it("passes non-replay context into the Census TEE input bundle", async () => {
        const result = finalizedResultForCensus();
        const reader = new RecordingFloorCensusReader();
        const client = new RecordingFloorCensusSubmitClient();
        const tee = new RecordingFloorCensusTeeClient();
        const packageId = `0x${"99".repeat(32)}`;
        const adapter = new TeeFloorCensusAdapter(
            {
                target: `${packageId}::accessor::set_floor_census`,
                pauseState: "0xpause",
                verifierRegistry: "0xverifier",
                categoryPool: "0xcategory",
                mainPool: "0xmain",
                membershipRegistry: membershipRegistryId,
                cellCountIndex: cellCountIndexId,
                signer: new RecordingSigner().asSigner(),
                reader,
                client,
                now: () => 1_800_000_001_000,
            },
            tee,
            censusRegistrationMetadata,
        );

        await expect(
            adapter.run({
                sourceEventId: "us7000sonari",
                result,
                relayerDigest: "tx-digest",
                disasterEventId: `0x${"88".repeat(32)}`,
            }),
        ).resolves.toMatchObject({ status: "succeeded" });

        expect(tee.inputs).toHaveLength(1);
        expect(tee.inputs[0]?.payload.package_id).toBe(packageId);
        expect(tee.inputs[0]?.payload.membership_registry_id).toBe(membershipRegistryId);
        expect("home_cell_events" in (tee.inputs[0]?.payload ?? {})).toBe(false);
        expect("active_lineages" in (tee.inputs[0]?.payload ?? {})).toBe(false);
        expect("counted_cells_root" in (tee.inputs[0]?.payload ?? {})).toBe(false);
        expect(reader.homeCellLookups).toEqual([]);
        expect(reader.activeLineageLookups).toEqual([]);
    });
});

function expectedRoot(): string {
    const root = computeAffectedCellsRootForTest(affectedCells);
    if (root === null) {
        throw new Error("fixture should produce root");
    }
    return root;
}

function computeCountedCellsRootForTest(
    cells: readonly { h3: bigint; band: number; count: bigint }[],
): string {
    const hashes = [...cells]
        .sort((left, right) => (left.h3 < right.h3 ? -1 : left.h3 > right.h3 ? 1 : 0))
        .map((cell) =>
            createHashSync(
                concat([
                    Uint8Array.of(0),
                    u64(cell.h3),
                    Uint8Array.of(cell.band),
                    u64(cell.h3 % 4_096n),
                    u64(cell.count),
                ]),
            ),
        );
    if (hashes.length === 0) {
        throw new Error("counted root fixture must have leaves");
    }
    let level = hashes;
    while (level.length > 1) {
        const next: Uint8Array[] = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = level[i + 1];
            if (left === undefined) {
                throw new Error("missing counted root leaf");
            }
            next.push(right === undefined ? left : createHashSync(concat([Uint8Array.of(1), left, right])));
        }
        level = next;
    }
    const root = level[0];
    if (root === undefined) {
        throw new Error("missing counted root");
    }
    return `0x${Buffer.from(root).toString("hex")}`;
}

function jsonResponse(
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
): Response {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json", ...init.headers },
    });
}

function campaignObjectChange(address: string): unknown {
    return {
        address,
        outputState: {
            address,
            asMoveObject: {
                contents: {
                    type: {
                        repr: "0xabc::campaign::Campaign",
                    },
                },
            },
        },
    };
}

function computeAffectedCellsRootForTest(input: typeof affectedCells): string | null {
    // Keep this fixture root independent from computeFloorCensusCounts; the production
    // implementation uses @sonari/earthquake-shared.
    const hashes = input.affected_cells.map((cell) => {
        const bytes = [
            Uint8Array.of(0),
            Buffer.from(input.event_uid.slice(2), "hex"),
            u32(input.event_revision),
            u64(BigInt(cell.h3_index)),
            Uint8Array.of(input.geo_resolution),
            Uint8Array.of(1),
            u16(cell.intensity_value),
            Uint8Array.of(1),
            Uint8Array.of(cell.cell_band),
            Uint8Array.of(1),
            u64(BigInt(input.oracle_version)),
        ];
        return createHashSync(concat(bytes));
    });
    if (hashes.length === 0) {
        return null;
    }
    let level = hashes;
    while (level.length > 1) {
        const next: Uint8Array[] = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = level[i + 1];
            if (left === undefined) {
                return null;
            }
            if (right === undefined) {
                next.push(left);
            } else {
                next.push(createHashSync(concat([Uint8Array.of(1), left, right])));
            }
        }
        level = next;
    }
    const root = level[0];
    return root === undefined ? null : `0x${Buffer.from(root).toString("hex")}`;
}

function createHashSync(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

function u16(value: number): Uint8Array {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return bytes;
}

function u32(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
}

function u64(value: bigint): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}

class RecordingSigner {
    signedBytes: Uint8Array | undefined;

    async sign(bytes: Uint8Array): Promise<Uint8Array> {
        this.signedBytes = bytes;
        return Uint8Array.from({ length: 64 }, () => 0x11);
    }

    asSigner(): RelayerSigner {
        return this as unknown as RelayerSigner;
    }

    getPublicKey() {
        return {
            toRawBytes: () => Uint8Array.from({ length: 32 }, () => 0x22),
        };
    }

    toSuiAddress(): string {
        return "0xsender";
    }
}

class RecordingFloorCensusReader implements FloorCensusOnchainReader {
    readonly campaignLookups: Array<{ digest: string; eventUid: string; eventRevision: number }> =
        [];
    readonly homeCellLookups: Array<{ packageId: string; checkpoint?: number | undefined }> = [];
    readonly activeLineageLookups: Array<{
        membershipRegistryId: string;
        lineages: readonly string[];
        checkpoint?: number | undefined;
    }> = [];

    async listHomeCellRegisteredEvents(input: {
        packageId: string;
        checkpoint?: number | undefined;
    }): Promise<HomeCellRegisteredEvent[]> {
        this.homeCellLookups.push(input);
        return [{ lineage: "0xlineage", homeCell: "20", registeredAtMs: 900 }];
    }

    async listActiveLineages(input: {
        membershipRegistryId: string;
        lineages: readonly string[];
        checkpoint?: number | undefined;
    }): Promise<ReadonlySet<string>> {
        this.activeLineageLookups.push(input);
        return new Set(["0xlineage"]);
    }

    async findCampaignId(input: {
        digest: string;
        eventUid: string;
        eventRevision: number;
    }): Promise<{ campaignId: string; checkpoint: number } | undefined> {
        this.campaignLookups.push(input);
        return input.eventRevision === 7
            ? { campaignId: `0x${"77".repeat(32)}`, checkpoint: 41 }
            : undefined;
    }
}

class RecordingFloorCensusSubmitClient implements FloorCensusSubmitClient {
    readonly submissions: unknown[] = [];

    async signAndExecuteTransaction(input: unknown) {
        this.submissions.push(input);
        return {
            $kind: "Transaction" as const,
            Transaction: {
                digest: "census-digest",
                status: { success: true },
            },
        };
    }
}

class RecordingFloorCensusTeeClient {
    readonly inputs: Array<{
        action: "process_data";
        payload: { package_id: string; membership_registry_id: string };
        registration_metadata: EnclaveVerificationMetadata;
    }> = [];

    async processData(input: unknown): Promise<unknown> {
        this.inputs.push(
            input as {
                action: "process_data";
                payload: { package_id: string; membership_registry_id: string };
                registration_metadata: EnclaveVerificationMetadata;
            },
        );
        return {
            status: "finalized",
            payload: {
                event_uid: eventUid,
                event_revision: 7,
                affected_cells_root: expectedRoot(),
                membership_registry_id: membershipRegistryId,
                cell_count_index_id: cellCountIndexId,
                census_checkpoint: 41,
                registered_members_by_band: [0, 1, 0],
            },
            payload_bcs_hex: `0x${"aa".repeat(8)}`,
            signature: `0x${"11".repeat(64)}`,
            public_key: censusRegistrationMetadata.enclave_instance_public_key,
        };
    }
}

class RecordingAffectedCellsResolver implements FloorCensusAffectedCellsResolver {
    readonly inputs: Array<{
        affectedCellsRef?: unknown;
        evidenceManifest?: unknown;
    }> = [];

    async resolveAffectedCells(input: {
        affectedCellsRef?: unknown;
        evidenceManifest?: unknown;
    }): Promise<typeof affectedCells> {
        this.inputs.push(input);
        return { ...affectedCells, event_revision: 7 };
    }
}

function finalizedResultForCensus() {
    const root = expectedRoot();
    const payload: EarthquakeOraclePayload = {
        intent: BCS_ENUMS.intent.SONARI_EARTHQUAKE_ORACLE,
        oracle_version: 1,
        event_uid: eventUid,
        event_revision: 7,
        source_event_id: "us7000sonari",
        title: "M 7.1 - Sonari Fixture Earthquake",
        region: "Sonari Fixture Region",
        occurred_at_ms: 1_000,
        hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
        status: BCS_ENUMS.onchainStatus.FINALIZED,
        severity_band: 2,
        affected_cells_root: root,
        affected_cell_count: 3,
        evidence_manifest_uri: "walrus://blob/manifestBlob_123456",
        evidence_manifest_hash: `0x${"55".repeat(32)}`,
        verified_at_ms: 1_000,
        freshness_deadline_ms: 21_601_000,
    };
    return {
        status: "finalized" as const,
        payload,
        payload_bcs_hex: encodeEarthquakeOraclePayloadBcsHex(payload),
        signature: `0x${"11".repeat(64)}`,
        public_key: `0x${"22".repeat(32)}`,
        verifier_config_key: 1,
        verifier_config_version: 1,
        enclave_instance_public_key: `0x${"22".repeat(32)}`,
        affected_cells: { ...affectedCells, event_revision: 7 },
    };
}
