import { describe, expect, it, vi } from "vitest";
import type { MoveEvent } from "../chain/graphql-event-client";
import {
    type DashboardEventReadClient,
    parseDashboardDisasterEvent,
    parseDashboardDonationEvent,
    parseDashboardPayoutEvent,
    readDashboardEvents,
} from "./dashboard-events";

const PACKAGE_ID = `0x${"ab".repeat(32)}`;
const POOL_ID = `0x${"11".repeat(32)}`;
const CAMPAIGN_ID = `0x${"22".repeat(32)}`;
const EVENT_ID = `0x${"33".repeat(32)}`;
const RECIPIENT = `0x${"44".repeat(32)}`;
const DONOR = `0x${"55".repeat(32)}`;

function eventEnvelope(
    json: Record<string, unknown>,
    overrides: {
        readonly id?: string | { readonly txDigest: string; readonly eventSeq: string };
        readonly timestampMs?: string | number;
    } = {},
): MoveEvent {
    const rawId = overrides.id ?? "digest:1";
    return {
        id: typeof rawId === "string" ? rawId : `${rawId.txDigest}:${rawId.eventSeq}`,
        timestampMs: Number(overrides.timestampMs ?? 1_700_000_000_000),
        json,
    };
}

describe("dashboard event parsers", () => {
    it("parses donation events using envelope timestampMs", () => {
        expect(
            parseDashboardDonationEvent(
                eventEnvelope({
                    pool_id: POOL_ID,
                    amount: "2500000",
                    actor: DONOR,
                }),
                "general",
            ),
        ).toEqual({
            kind: "donation",
            id: "digest:1",
            source: "general",
            label: "Donor 0x5555...5555",
            amountUsdc: 2500000n,
            actor: DONOR,
            poolId: POOL_ID,
            occurredAtMs: 1700000000000,
            status: "confirmed",
        });
    });

    it("parses payout events with event timestamp when no event field timestamp exists", () => {
        expect(
            parseDashboardPayoutEvent(
                eventEnvelope({
                    campaign_id: CAMPAIGN_ID,
                    round: 2,
                    pass_lineage_id: EVENT_ID,
                    band: 3,
                    amount_usdc: "5000000",
                    recipient: RECIPIENT,
                }),
                "payout",
            ),
        ).toEqual({
            kind: "claim",
            id: "digest:1",
            source: "payout",
            label: "recipient · 0x4444...4444",
            amountUsdc: 5000000n,
            campaignId: CAMPAIGN_ID,
            recipient: RECIPIENT,
            occurredAtMs: 1700000000000,
            status: "finalized",
        });
    });

    it("parses floor paid events with paid_at_ms from the event body", () => {
        expect(
            parseDashboardPayoutEvent(
                eventEnvelope({
                    campaign_id: CAMPAIGN_ID,
                    pass_lineage_id: EVENT_ID,
                    band: 1,
                    amount_usdc: "1000000",
                    recipient: RECIPIENT,
                    paid_at_ms: "1700000000500",
                }),
                "floor",
            )?.occurredAtMs,
        ).toBe(1700000000500);
    });

    it("parses latest disaster event fields", () => {
        expect(
            parseDashboardDisasterEvent(
                eventEnvelope({
                    disaster_event_id: EVENT_ID,
                    source_event_id: "usgs-1",
                    event_revision: 2,
                    title: "M6.8 earthquake",
                    region: "Offshore Iwate, Japan",
                    hazard_label: "earthquake",
                    affected_cell_count: "1284",
                    created_at_ms: "1700000000100",
                }),
            ),
        ).toEqual({
            id: EVENT_ID,
            sourceEventId: "usgs-1",
            eventRevision: 2,
            title: "M6.8 earthquake",
            region: "Offshore Iwate, Japan",
            hazardLabel: "earthquake",
            affectedCellCount: 1284n,
            occurredAtMs: 1700000000100,
            status: "finalized",
        });
    });

    it("returns null for malformed event envelopes", () => {
        expect(parseDashboardDonationEvent({ parsedJson: { amount: "-1" } }, "general")).toBeNull();
        expect(parseDashboardPayoutEvent(eventEnvelope({ campaign_id: "bad" }), "payout")).toBeNull();
        expect(parseDashboardDisasterEvent(eventEnvelope({ disaster_event_id: "bad" }))).toBeNull();
    });
});

describe("readDashboardEvents", () => {
    it("queries event types, merges them, deduplicates by id, and sorts newest first", async () => {
        const donationType = `${PACKAGE_ID}::donation::GeneralDonationReceived`;
        const floorType = `${PACKAGE_ID}::campaign::FloorPaid`;
        const disasterType = `${PACKAGE_ID}::disaster_event::DisasterEventCreated`;
        const queryMoveEvents = vi.fn(async (input: { type: string }) => {
            if (input.type === donationType) {
                return {
                    data: [
                        eventEnvelope(
                            { pool_id: POOL_ID, amount: "2500000", actor: DONOR },
                            { id: { txDigest: "old", eventSeq: "1" }, timestampMs: "1000" },
                        ),
                    ],
                    hasNextPage: false,
                };
            }
            if (input.type === floorType) {
                return {
                    data: [
                        eventEnvelope(
                            {
                                campaign_id: CAMPAIGN_ID,
                                pass_lineage_id: EVENT_ID,
                                band: 1,
                                amount_usdc: "1000000",
                                recipient: RECIPIENT,
                                paid_at_ms: "3000",
                            },
                            { id: { txDigest: "new", eventSeq: "1" } },
                        ),
                        eventEnvelope(
                            {
                                campaign_id: CAMPAIGN_ID,
                                pass_lineage_id: EVENT_ID,
                                band: 1,
                                amount_usdc: "1000000",
                                recipient: RECIPIENT,
                                paid_at_ms: "3000",
                            },
                            { id: { txDigest: "new", eventSeq: "1" } },
                        ),
                    ],
                    hasNextPage: false,
                };
            }
            if (input.type === disasterType) {
                return {
                    data: [
                        eventEnvelope(
                            {
                                disaster_event_id: EVENT_ID,
                                source_event_id: "usgs-1",
                                event_revision: 2,
                                title: "M6.8 earthquake",
                                region: "Offshore Iwate, Japan",
                                hazard_label: "earthquake",
                                affected_cell_count: "1284",
                                created_at_ms: "2000",
                            },
                            { id: { txDigest: "event", eventSeq: "1" } },
                        ),
                    ],
                    hasNextPage: false,
                };
            }
            return { data: [], hasNextPage: false };
        });
        const client: DashboardEventReadClient = { queryMoveEvents };

        const result = await readDashboardEvents(client, { packageId: PACKAGE_ID, limit: 10 });

        expect(result).toEqual({
            kind: "ok",
            donations: [
                {
                    kind: "donation",
                    id: "old:1",
                    source: "general",
                    label: "Donor 0x5555...5555",
                    amountUsdc: 2500000n,
                    actor: DONOR,
                    poolId: POOL_ID,
                    occurredAtMs: 1000,
                    status: "confirmed",
                },
            ],
            claims: [
                {
                    kind: "claim",
                    id: "new:1",
                    source: "floor",
                    label: "recipient · 0x4444...4444",
                    amountUsdc: 1000000n,
                    campaignId: CAMPAIGN_ID,
                    recipient: RECIPIENT,
                    occurredAtMs: 3000,
                    status: "finalized",
                },
            ],
            aidDeliveredUsdc: 1000000n,
            totalClaimsCount: 1,
            latestEvent: {
                id: EVENT_ID,
                sourceEventId: "usgs-1",
                eventRevision: 2,
                title: "M6.8 earthquake",
                region: "Offshore Iwate, Japan",
                hazardLabel: "earthquake",
                affectedCellCount: 1284n,
                occurredAtMs: 2000,
                status: "finalized",
            },
        });
        expect(queryMoveEvents.mock.calls.map((call) => call[0].type)).toContain(
            donationType,
        );
        expect(queryMoveEvents.mock.calls.map((call) => call[0].type)).toContain(
            floorType,
        );
        expect(queryMoveEvents.mock.calls.map((call) => call[0].type)).toContain(
            disasterType,
        );
    });

    it("follows paginated event query responses", async () => {
        const nextCursor = "next-page";
        const queryMoveEvents = vi.fn(async (input: {
            type: string;
            cursor?: string | null;
        }) => {
            if (!input.type.endsWith("::donation::DonationSplit")) {
                return { data: [], hasNextPage: false };
            }
            if (input.cursor === nextCursor) {
                return {
                    data: [
                        eventEnvelope(
                            {
                                donation_target: 3,
                                primary_pool_id: null,
                                main_pool_id: POOL_ID,
                                ops_pool_id: POOL_ID,
                                total_amount: "2000000",
                                primary_amount: "0",
                                main_amount: "1900000",
                                ops_amount: "100000",
                                ops_cap_overflow_usdc: "0",
                                after_donation_end: false,
                                donor: DONOR,
                            },
                            { id: { txDigest: "second", eventSeq: "1" } },
                        ),
                    ],
                    hasNextPage: false,
                };
            }
            return { data: [], hasNextPage: true, nextCursor };
        });

        const result = await readDashboardEvents({ queryMoveEvents }, { packageId: PACKAGE_ID });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(result.donations).toHaveLength(1);
        expect(queryMoveEvents.mock.calls.some((call) => call[0].cursor === nextCursor)).toBe(true);
    });

    it("keeps total claim count separate from the visible claim limit", async () => {
        const queryMoveEvents = vi.fn(async (input: { type: string }) => {
            if (!input.type.endsWith("::campaign::PayoutClaimed")) {
                return { data: [], hasNextPage: false };
            }
            return {
                data: Array.from({ length: 12 }, (_, index) =>
                    eventEnvelope(
                        {
                            campaign_id: CAMPAIGN_ID,
                            round: 1,
                            pass_lineage_id: EVENT_ID,
                            band: 1,
                            amount_usdc: "1000000",
                            recipient: RECIPIENT,
                        },
                        {
                            id: { txDigest: `claim-${index}`, eventSeq: "1" },
                            timestampMs: String(1700000000000 - index),
                        },
                    ),
                ),
                hasNextPage: false,
            };
        });

        const result = await readDashboardEvents({ queryMoveEvents }, { packageId: PACKAGE_ID, limit: 10 });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(result.claims).toHaveLength(10);
        expect(result.totalClaimsCount).toBe(12);
    });

    it("prefers the latest revision when one source event has multiple disaster events", async () => {
        const disasterType = `${PACKAGE_ID}::disaster_event::DisasterEventCreated`;
        const queryMoveEvents = vi.fn(async (input: { type: string }) => {
            if (input.type !== disasterType) {
                return { data: [], hasNextPage: false };
            }
            return {
                data: [
                    eventEnvelope(
                        {
                            disaster_event_id: EVENT_ID,
                            source_event_id: "usgs-1",
                            event_revision: 1,
                            title: "Old revision",
                            region: "Old Region",
                            hazard_label: "earthquake",
                            affected_cell_count: "100",
                            created_at_ms: "3000",
                        },
                        { id: { txDigest: "old-revision", eventSeq: "1" } },
                    ),
                    eventEnvelope(
                        {
                            disaster_event_id: `0x${"66".repeat(32)}`,
                            source_event_id: "usgs-1",
                            event_revision: 2,
                            title: "Latest revision",
                            region: "Latest Region",
                            hazard_label: "earthquake",
                            affected_cell_count: "120",
                            created_at_ms: "2000",
                        },
                        { id: { txDigest: "latest-revision", eventSeq: "1" } },
                    ),
                ],
                hasNextPage: false,
            };
        });

        const result = await readDashboardEvents({ queryMoveEvents }, { packageId: PACKAGE_ID });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(result.latestEvent).toMatchObject({
            sourceEventId: "usgs-1",
            eventRevision: 2,
            title: "Latest revision",
        });
    });

    it("returns error for missing package id or RPC failure", async () => {
        await expect(
            readDashboardEvents({ queryMoveEvents: vi.fn() }, { packageId: "" }),
        ).resolves.toEqual({
            kind: "error",
            message: "Package id is required to read dashboard events.",
        });

        await expect(
            readDashboardEvents(
                {
                    queryMoveEvents: vi.fn(async () => {
                        throw new Error("rpc unavailable");
                    }),
                },
                { packageId: PACKAGE_ID },
            ),
        ).resolves.toEqual({ kind: "error", message: "rpc unavailable" });
    });
});
