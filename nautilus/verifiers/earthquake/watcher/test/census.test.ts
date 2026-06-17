import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
    computeFloorCensusCounts,
    DirectFloorCensusAdapter,
    encodeFloorCensusResultBcs,
    type FloorCensusOnchainReader,
    type FloorCensusSubmitClient,
    GraphqlFloorCensusReader,
    JsonRpcFloorCensusReader,
    signFloorCensusResult,
    type HomeCellRegisteredEvent,
} from "../src/census.js";
import {
    BCS_ENUMS,
    encodeEarthquakeOraclePayloadBcsHex,
    type EarthquakeOraclePayload,
} from "@sonari/earthquake-shared";
import type { RelayerSigner } from "@sonari/earthquake-relayer";

const eventUid = `0x${"aa".repeat(32)}`;
const affectedCellsRoot = `0x${"bb".repeat(32)}`;
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
            registeredMembersByBand: [1n, 2n, 3n],
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
                "03",
                "0100000000000000",
                "0200000000000000",
                "0300000000000000",
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
            registeredMembersByBand: [1n, 2n, 3n],
            issuedAtMs: 1_234,
        });

        expect(recorder.signedBytes).toEqual(signed.censusBcs);
        expect(signed.signature).toHaveLength(64);
        expect(signed.publicKey).toHaveLength(32);
        expect(signed.signatureHex).toBe(`0x${"11".repeat(64)}`);
        expect(signed.publicKeyHex).toBe(`0x${"22".repeat(32)}`);
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
            membershipRegistry: "0xmembership",
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
                disasterEventId: "0xdisaster",
            }),
        ).resolves.toMatchObject({
            status: "succeeded",
            campaignId: "0xcampaign-revision-7",
        });

        expect(reader.campaignLookups).toEqual([
            {
                digest: "tx-digest",
                eventUid,
                eventRevision: 7,
            },
        ]);
        expect(Buffer.from(signer.signedBytes ?? []).toString("hex")).toContain("07000000");
        expect(client.submissions).toHaveLength(1);
    });
});

function expectedRoot(): string {
    const root = computeAffectedCellsRootForTest(affectedCells);
    if (root === null) {
        throw new Error("fixture should produce root");
    }
    return root;
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

    async listHomeCellRegisteredEvents(): Promise<HomeCellRegisteredEvent[]> {
        return [{ lineage: "0xlineage", homeCell: "20", registeredAtMs: 900 }];
    }

    async listActiveLineages(): Promise<ReadonlySet<string>> {
        return new Set(["0xlineage"]);
    }

    async findCampaignId(input: {
        digest: string;
        eventUid: string;
        eventRevision: number;
    }): Promise<string | undefined> {
        this.campaignLookups.push(input);
        return input.eventRevision === 7 ? "0xcampaign-revision-7" : undefined;
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
