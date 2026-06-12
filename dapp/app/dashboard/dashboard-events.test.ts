import { describe, expect, it, vi } from "vitest";
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

function eventEnvelope(parsedJson: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return {
        id: { txDigest: "digest", eventSeq: "1" },
        timestampMs: "1700000000000",
        parsedJson,
        ...overrides,
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
        const queryEvents = vi.fn(async (input: { query: { MoveEventType: string } }) => {
            if (input.query.MoveEventType === donationType) {
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
            if (input.query.MoveEventType === floorType) {
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
            if (input.query.MoveEventType === disasterType) {
                return {
                    data: [
                        eventEnvelope(
                            {
                                disaster_event_id: EVENT_ID,
                                source_event_id: "usgs-1",
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
        const client: DashboardEventReadClient = { queryEvents };

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
            latestEvent: {
                id: EVENT_ID,
                sourceEventId: "usgs-1",
                title: "M6.8 earthquake",
                region: "Offshore Iwate, Japan",
                hazardLabel: "earthquake",
                affectedCellCount: 1284n,
                occurredAtMs: 2000,
                status: "finalized",
            },
        });
        expect(queryEvents.mock.calls.map((call) => call[0].query.MoveEventType)).toContain(
            donationType,
        );
        expect(queryEvents.mock.calls.map((call) => call[0].query.MoveEventType)).toContain(
            floorType,
        );
        expect(queryEvents.mock.calls.map((call) => call[0].query.MoveEventType)).toContain(
            disasterType,
        );
    });

    it("follows paginated queryEvents responses", async () => {
        const nextCursor = { txDigest: "cursor", eventSeq: "1" };
        const queryEvents = vi.fn(async (input: {
            query: { MoveEventType: string };
            cursor?: typeof nextCursor | null;
        }) => {
            if (!input.query.MoveEventType.endsWith("::donation::DonationSplit")) {
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

        const result = await readDashboardEvents({ queryEvents }, { packageId: PACKAGE_ID });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(result.donations).toHaveLength(1);
        expect(queryEvents.mock.calls.some((call) => call[0].cursor === nextCursor)).toBe(true);
    });

    it("returns error for missing package id or RPC failure", async () => {
        await expect(
            readDashboardEvents({ queryEvents: vi.fn() }, { packageId: "" }),
        ).resolves.toEqual({
            kind: "error",
            message: "Package id is required to read dashboard events.",
        });

        await expect(
            readDashboardEvents(
                {
                    queryEvents: vi.fn(async () => {
                        throw new Error("rpc unavailable");
                    }),
                },
                { packageId: PACKAGE_ID },
            ),
        ).resolves.toEqual({ kind: "error", message: "rpc unavailable" });
    });
});
