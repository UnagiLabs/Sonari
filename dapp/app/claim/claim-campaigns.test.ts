import { describe, expect, it, vi } from "vitest";
import {
    type ClaimCampaignEventCursor,
    type ClaimCampaignReadClient,
    deriveClaimCampaignState,
    parseCampaignCreatedEvent,
    parseCampaignObject,
    parseDisasterEventObject,
    readClaimCampaigns,
} from "./claim-campaigns";

const PACKAGE_ID = `0x${"ab".repeat(32)}`;
const CAMPAIGN_TYPE = `${PACKAGE_ID}::campaign::CampaignCreated`;
const CAMPAIGN_ID = `0x${"11".repeat(32)}`;
const DISASTER_EVENT_ID = `0x${"22".repeat(32)}`;
const EVENT_UID = `0x${"cd".repeat(32)}`;
const AFFECTED_CELLS_ROOT = `0x${"ef".repeat(32)}`;

function campaignCreatedParsedJson(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        campaign_id: CAMPAIGN_ID,
        disaster_event_id: DISASTER_EVENT_ID,
        event_uid: EVENT_UID,
        event_revision: 3,
        category_pool_id: `0x${"33".repeat(32)}`,
        claim_end_ms: "2000",
        ...overrides,
    };
}

function campaignObjectJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        disaster_event_id: DISASTER_EVENT_ID,
        event_uid: EVENT_UID,
        event_revision: "3",
        census_set: true,
        floor_budget_returned: false,
        donation_end_ms: "1500",
        claim_end_ms: "2000",
        current_round: "1",
        round_finalized_at_ms: "1800",
        floor_amount_by_band: ["100", "200", "300"],
        round_payout_by_band: ["1000", "2000", "3000"],
        closed: false,
        ...overrides,
    };
}

function disasterEventObjectJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        event_uid: EVENT_UID,
        event_revision: "3",
        title: "Test Earthquake",
        region: "Test Region",
        severity_band: 2,
        affected_cells_root: AFFECTED_CELLS_ROOT,
        affected_cell_count: "42",
        ...overrides,
    };
}

describe("claim campaign parsing", () => {
    it("parses CampaignCreated event fields used by the claim page", () => {
        expect(parseCampaignCreatedEvent(campaignCreatedParsedJson())).toEqual({
            campaignId: CAMPAIGN_ID,
            disasterEventId: DISASTER_EVENT_ID,
            eventUid: EVENT_UID,
            eventRevision: 3,
        });
    });

    it("parses vector<u8> event_uid and affected_cells_root into 0x hex", () => {
        const bytes = Array.from({ length: 32 }, (_, index) => index);

        expect(parseCampaignCreatedEvent(campaignCreatedParsedJson({ event_uid: bytes })))
            .toMatchObject({ eventUid: "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" });

        expect(parseDisasterEventObject(DISASTER_EVENT_ID, disasterEventObjectJson({
            affected_cells_root: bytes,
        }))).toMatchObject({
            affectedCellsRoot:
                "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        });
    });

    it("returns null for malformed Campaign or DisasterEvent object JSON", () => {
        expect(parseCampaignObject(CAMPAIGN_ID, campaignObjectJson({ claim_end_ms: "bad" })))
            .toBeNull();
        expect(parseDisasterEventObject(DISASTER_EVENT_ID, disasterEventObjectJson({
            affected_cells_root: "0x1234",
        }))).toBeNull();
    });
});

describe("deriveClaimCampaignState", () => {
    it("derives open, floor, and payout states from Campaign fields", () => {
        const campaign = parseCampaignObject(CAMPAIGN_ID, campaignObjectJson());
        const disaster = parseDisasterEventObject(DISASTER_EVENT_ID, disasterEventObjectJson());
        if (campaign === null || disaster === null) {
            throw new Error("fixtures must parse");
        }

        expect(deriveClaimCampaignState(campaign, disaster, "1900")).toEqual({
            campaignId: CAMPAIGN_ID,
            disasterEventId: DISASTER_EVENT_ID,
            eventUid: EVENT_UID,
            eventRevision: 3,
            affectedCellsRoot: AFFECTED_CELLS_ROOT,
            title: "Test Earthquake",
            region: "Test Region",
            severityBand: 2,
            affectedCellCount: "42",
            donationEndMs: "1500",
            claimEndMs: "2000",
            claimWindowOpen: true,
            floorClaimAvailable: true,
            payoutFinalized: true,
            currentRound: "1",
        });
    });

    it("marks payout unavailable before finalize and floor unavailable after floor return", () => {
        const campaign = parseCampaignObject(
            CAMPAIGN_ID,
            campaignObjectJson({
                census_set: true,
                floor_budget_returned: true,
                current_round: "0",
            }),
        );
        const disaster = parseDisasterEventObject(DISASTER_EVENT_ID, disasterEventObjectJson());
        if (campaign === null || disaster === null) {
            throw new Error("fixtures must parse");
        }

        const state = deriveClaimCampaignState(campaign, disaster, "2500");

        expect(state?.claimWindowOpen).toBe(false);
        expect(state?.floorClaimAvailable).toBe(false);
        expect(state?.payoutFinalized).toBe(false);
    });
});

describe("readClaimCampaigns", () => {
    it("queries CampaignCreated events, follows pages, dedupes, and reads objects", async () => {
        const nextCursor: ClaimCampaignEventCursor = { txDigest: "digest", eventSeq: "1" };
        const queryEvents = vi.fn(async (input: {
            query: { MoveEventType: string };
            cursor?: ClaimCampaignEventCursor | null;
        }) => {
            expect(input.query.MoveEventType).toBe(CAMPAIGN_TYPE);
            if (input.cursor === nextCursor) {
                return {
                    data: [{ parsedJson: campaignCreatedParsedJson({ claim_end_ms: "1000" }) }],
                    hasNextPage: false,
                };
            }
            return {
                data: [
                    { parsedJson: campaignCreatedParsedJson() },
                    { parsedJson: campaignCreatedParsedJson() },
                ],
                hasNextPage: true,
                nextCursor,
            };
        });
        const getObjects = vi.fn(async (input: { objectIds: string[] }) => ({
            objects: input.objectIds.map((objectId) => ({
                objectId,
                json:
                    objectId === CAMPAIGN_ID
                        ? campaignObjectJson()
                        : disasterEventObjectJson(),
            })),
        }));
        const client: ClaimCampaignReadClient = { queryEvents, getObjects };

        const result = await readClaimCampaigns(client, {
            packageId: PACKAGE_ID,
            nowMs: "1900",
        });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            throw new Error(result.message);
        }
        expect(result.campaigns).toHaveLength(1);
        expect(result.campaigns[0]?.campaignId).toBe(CAMPAIGN_ID);
        expect(queryEvents).toHaveBeenCalledTimes(2);
        expect(getObjects).toHaveBeenCalledTimes(2);
    });

    it("returns error when the package id is missing or RPC fails", async () => {
        const client: ClaimCampaignReadClient = {
            queryEvents: vi.fn(async () => {
                throw new Error("rpc unavailable");
            }),
            getObjects: vi.fn(),
        };

        await expect(readClaimCampaigns(client, { packageId: " ", nowMs: "1" })).resolves.toEqual({
            kind: "error",
            message: "Package id is required to read claim campaigns.",
        });
        await expect(readClaimCampaigns(client, { packageId: PACKAGE_ID, nowMs: "1" }))
            .resolves.toEqual({ kind: "error", message: "rpc unavailable" });
    });
});
