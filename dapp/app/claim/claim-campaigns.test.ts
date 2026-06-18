import { describe, expect, it, vi } from "vitest";
import {
    type ClaimCampaignEventCursor,
    type ClaimCampaignReadClient,
    deriveClaimCampaignState,
    deriveClaimEligibility,
    parseCampaignCreatedEvent,
    parseClaimApplicationObject,
    parseCampaignObject,
    parseDisasterEventObject,
    readClaimEligibility,
    readClaimCampaigns,
} from "./claim-campaigns";

const PACKAGE_ID = `0x${"ab".repeat(32)}`;
const CAMPAIGN_TYPE = `${PACKAGE_ID}::campaign::CampaignCreated`;
const CAMPAIGN_ID = `0x${"11".repeat(32)}`;
const DISASTER_EVENT_ID = `0x${"22".repeat(32)}`;
const PASS_LINEAGE_ID = `0x${"44".repeat(32)}`;
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
        terms: { round_interval_ms: "100" },
        floor_amount_by_band: ["100", "200", "300"],
        round_payout_by_band: ["1000", "2000", "3000"],
        balance: { value: "5000000" },
        total_donated_usdc: "8000000",
        total_paid_usdc: "3000000",
        closed: false,
        paused: false,
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

function claimApplicationJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        value: {
            band: "2",
            applied_at_ms: "1200",
            verified: true,
            verified_in_round: "0",
            floor_claimed: false,
            excluded: false,
            ...overrides,
        },
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

    it("parses ClaimApplication dynamic field values", () => {
        expect(parseClaimApplicationObject(claimApplicationJson())).toEqual({
            band: 2,
            appliedAtMs: "1200",
            verified: true,
            verifiedInRound: "0",
            floorClaimed: false,
            excluded: false,
        });
        expect(parseClaimApplicationObject(claimApplicationJson({ verified: "yes" }))).toBeNull();
    });

    it("parses balance in { value } struct form into balanceUsdc as number", () => {
        const result = parseCampaignObject(
            CAMPAIGN_ID,
            campaignObjectJson({ balance: { value: "1000000" } }),
        );
        expect(result).not.toBeNull();
        expect(result?.balanceUsdc).toBe(1000000);
    });

    it("parses balance in direct u64 string form into balanceUsdc as number", () => {
        const result = parseCampaignObject(
            CAMPAIGN_ID,
            campaignObjectJson({ balance: "1000000" }),
        );
        expect(result).not.toBeNull();
        expect(result?.balanceUsdc).toBe(1000000);
    });

    it("parses balance in direct u64 number form into balanceUsdc as number", () => {
        const result = parseCampaignObject(
            CAMPAIGN_ID,
            campaignObjectJson({ balance: 1000000 }),
        );
        expect(result).not.toBeNull();
        expect(result?.balanceUsdc).toBe(1000000);
    });

    it("sets balanceUsdc to null when balance is missing, but Campaign object is still returned", () => {
        const json = campaignObjectJson();
        const { balance: _balance, ...withoutBalance } = json;
        const result = parseCampaignObject(CAMPAIGN_ID, withoutBalance);
        expect(result).not.toBeNull();
        expect(result?.balanceUsdc).toBeNull();
    });

    it("sets totalDonatedUsdc and totalPaidUsdc to null when missing, but Campaign is still returned", () => {
        const json = campaignObjectJson();
        const { total_donated_usdc: _donated, total_paid_usdc: _paid, ...withoutTotals } = json;
        const result = parseCampaignObject(CAMPAIGN_ID, withoutTotals);
        expect(result).not.toBeNull();
        expect(result?.totalDonatedUsdc).toBeNull();
        expect(result?.totalPaidUsdc).toBeNull();
    });

    it("parses closed and paused as booleans", () => {
        const result = parseCampaignObject(
            CAMPAIGN_ID,
            campaignObjectJson({ closed: true, paused: true }),
        );
        expect(result).not.toBeNull();
        expect(result?.closed).toBe(true);
        expect(result?.paused).toBe(true);
    });

    it("sets closed and paused to null when missing, but Campaign is still returned", () => {
        const json = campaignObjectJson();
        const { closed: _closed, paused: _paused, ...withoutFlags } = json;
        const result = parseCampaignObject(CAMPAIGN_ID, withoutFlags);
        expect(result).not.toBeNull();
        expect(result?.closed).toBeNull();
        expect(result?.paused).toBeNull();
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
            censusSet: true,
            floorBudgetReturned: false,
            claimWindowOpen: true,
            floorClaimAvailable: true,
            payoutFinalized: true,
            currentRound: "1",
            roundFinalizedAtMs: "1800",
            roundIntervalMs: "100",
            balanceUsdc: 5000000,
            totalDonatedUsdc: 8000000,
            totalPaidUsdc: 3000000,
            closed: false,
            paused: false,
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

    it("excludes campaign state when campaign and disaster revisions do not match", () => {
        const campaign = parseCampaignObject(CAMPAIGN_ID, campaignObjectJson({ event_revision: "2" }));
        const disaster = parseDisasterEventObject(
            DISASTER_EVENT_ID,
            disasterEventObjectJson({ event_revision: "3" }),
        );
        if (campaign === null || disaster === null) {
            throw new Error("fixtures must parse");
        }

        expect(deriveClaimCampaignState(campaign, disaster, "1900")).toBeNull();
    });
});

describe("deriveClaimEligibility", () => {
    it("allows first-time claim while the claim window is open even before payouts exist", () => {
        const campaign = parseCampaignObject(
            CAMPAIGN_ID,
            campaignObjectJson({
                census_set: false,
                floor_budget_returned: false,
                current_round: "0",
            }),
        );
        if (campaign === null) {
            throw new Error("campaign fixture must parse");
        }

        expect(
            deriveClaimEligibility({
                campaign,
                application: null,
                payoutClaimed: false,
                nowMs: "1900",
            }),
        ).toEqual({
            kind: "claimable",
            claimProofKind: "initial",
            requiresIdentity: true,
            willPayFloor: false,
            willPayPayout: false,
        });
    });

    it("requires identity for a continuing claim when floor payment remains", () => {
        const campaign = parseCampaignObject(CAMPAIGN_ID, campaignObjectJson());
        const application = parseClaimApplicationObject(claimApplicationJson());
        if (campaign === null || application === null) {
            throw new Error("fixtures must parse");
        }

        expect(
            deriveClaimEligibility({
                campaign,
                application,
                payoutClaimed: false,
                nowMs: "2500",
            }),
        ).toEqual({
            kind: "claimable",
            claimProofKind: "continuing",
            requiresIdentity: true,
            willPayFloor: true,
            willPayPayout: true,
        });
    });

    it("allows payout-only continuing claim without identity material", () => {
        const campaign = parseCampaignObject(
            CAMPAIGN_ID,
            campaignObjectJson({
                census_set: true,
                floor_budget_returned: false,
                current_round: "2",
            }),
        );
        const application = parseClaimApplicationObject(
            claimApplicationJson({
                verified_in_round: "1",
                floor_claimed: true,
            }),
        );
        if (campaign === null || application === null) {
            throw new Error("fixtures must parse");
        }

        expect(
            deriveClaimEligibility({
                campaign,
                application,
                payoutClaimed: false,
                nowMs: "2500",
            }),
        ).toEqual({
            kind: "claimable",
            claimProofKind: "continuing",
            requiresIdentity: false,
            willPayFloor: false,
            willPayPayout: true,
        });
    });

    it("allows continuing claim when lazy finalize will open round 1", () => {
        const campaign = parseCampaignObject(
            CAMPAIGN_ID,
            campaignObjectJson({
                census_set: true,
                floor_budget_returned: false,
                current_round: "0",
                donation_end_ms: "1500",
                round_finalized_at_ms: "0",
                terms: { round_interval_ms: "100" },
            }),
        );
        const application = parseClaimApplicationObject(
            claimApplicationJson({
                verified_in_round: "0",
                floor_claimed: true,
            }),
        );
        if (campaign === null || application === null) {
            throw new Error("fixtures must parse");
        }

        expect(
            deriveClaimEligibility({
                campaign,
                application,
                payoutClaimed: false,
                nowMs: "1600",
            }),
        ).toEqual({
            kind: "claimable",
            claimProofKind: "continuing",
            requiresIdentity: false,
            willPayFloor: false,
            willPayPayout: true,
        });
    });

    it("allows continuing claim when lazy finalize will open the next round", () => {
        const campaign = parseCampaignObject(
            CAMPAIGN_ID,
            campaignObjectJson({
                current_round: "1",
                round_finalized_at_ms: "1800",
                terms: { round_interval_ms: "100" },
            }),
        );
        const application = parseClaimApplicationObject(
            claimApplicationJson({
                verified_in_round: "1",
                floor_claimed: true,
            }),
        );
        if (campaign === null || application === null) {
            throw new Error("fixtures must parse");
        }

        expect(
            deriveClaimEligibility({
                campaign,
                application,
                payoutClaimed: false,
                nowMs: "1900",
            }),
        ).toEqual({
            kind: "claimable",
            claimProofKind: "continuing",
            requiresIdentity: false,
            willPayFloor: false,
            willPayPayout: true,
        });
    });

    it("returns none when a continuing claim has nothing payable", () => {
        const campaign = parseCampaignObject(
            CAMPAIGN_ID,
            campaignObjectJson({
                current_round: "2",
            }),
        );
        const application = parseClaimApplicationObject(
            claimApplicationJson({
                verified_in_round: "2",
                floor_claimed: true,
            }),
        );
        if (campaign === null || application === null) {
            throw new Error("fixtures must parse");
        }

        expect(
            deriveClaimEligibility({
                campaign,
                application,
                payoutClaimed: true,
                nowMs: "2500",
            }),
        ).toEqual({ kind: "none", reason: "nothing_to_claim" });
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

describe("readClaimEligibility", () => {
    it("reads ClaimApplication and PayoutKey dynamic fields", async () => {
        const campaign = parseCampaignObject(CAMPAIGN_ID, campaignObjectJson());
        if (campaign === null) {
            throw new Error("campaign fixture must parse");
        }

        const getObjects = vi
            .fn()
            .mockResolvedValueOnce({
                objects: [{ objectId: `0x${"55".repeat(32)}`, json: claimApplicationJson() }],
            })
            .mockResolvedValueOnce({ objects: [] });
        const client: ClaimCampaignReadClient = {
            queryEvents: vi.fn(),
            getObjects,
        };

        await expect(
            readClaimEligibility(client, {
                packageId: PACKAGE_ID,
                campaign,
                passLineageId: PASS_LINEAGE_ID,
                nowMs: "2500",
            }),
        ).resolves.toEqual({
            kind: "ok",
            eligibility: {
                kind: "claimable",
                claimProofKind: "continuing",
                requiresIdentity: true,
                willPayFloor: true,
                willPayPayout: true,
            },
        });
        expect(getObjects).toHaveBeenCalledTimes(2);
        expect(getObjects.mock.calls[0]?.[0].objectIds).toHaveLength(1);
        expect(getObjects.mock.calls[1]?.[0].objectIds).toHaveLength(1);
    });
});
