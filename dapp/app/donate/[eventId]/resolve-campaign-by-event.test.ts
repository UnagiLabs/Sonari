import { describe, expect, it } from "vitest";
import type { ClaimCampaignState } from "../../claim/claim-campaigns";
import { resolveCampaignByEvent } from "./resolve-campaign-by-event";

// ---------------------------------------------------------------------------
// テスト用フィクスチャ
// ---------------------------------------------------------------------------

function makeCampaign(overrides: Partial<ClaimCampaignState>): ClaimCampaignState {
    return {
        campaignId: "0xcampaign1",
        disasterEventId: "0xevent1",
        eventUid: "uid1",
        eventRevision: 1,
        affectedCellsRoot: "0xroot1",
        title: "Test Earthquake",
        region: "Region A",
        severityBand: 2,
        affectedCellCount: "100",
        donationEndMs: "1700000000000",
        claimEndMs: "1710000000000",
        censusSet: true,
        floorBudgetReturned: false,
        claimWindowOpen: true,
        floorClaimAvailable: false,
        payoutFinalized: false,
        currentRound: "1",
        roundFinalizedAtMs: "0",
        roundIntervalMs: "86400000",
        balanceUsdc: 100_000_000,
        totalDonatedUsdc: 200_000_000,
        totalPaidUsdc: 50_000_000,
        closed: false,
        paused: false,
        ...overrides,
    };
}

describe("resolveCampaignByEvent", () => {
    it("一致する disasterEventId の Campaign を返す", () => {
        const campaign = makeCampaign({ disasterEventId: "0xevent1", campaignId: "0xcampaign1" });
        const result = resolveCampaignByEvent([campaign], "0xevent1");
        expect(result).not.toBeNull();
        expect(result?.campaignId).toBe("0xcampaign1");
    });

    it("一致しない eventId のとき null を返す", () => {
        const campaign = makeCampaign({ disasterEventId: "0xevent1", campaignId: "0xcampaign1" });
        const result = resolveCampaignByEvent([campaign], "0xevent_nonexistent");
        expect(result).toBeNull();
    });

    it("空配列のとき null を返す", () => {
        const result = resolveCampaignByEvent([], "0xevent1");
        expect(result).toBeNull();
    });

    it("同一 disasterEventId に複数 Campaign があるとき donationEndMs 降順で先頭を返す", () => {
        const campaign1 = makeCampaign({
            disasterEventId: "0xevent1",
            campaignId: "0xcampaign1",
            donationEndMs: "1700000000000",
        });
        const campaign2 = makeCampaign({
            disasterEventId: "0xevent1",
            campaignId: "0xcampaign2",
            donationEndMs: "1800000000000",
        });
        // campaign2 の方が donationEndMs が大きいので先頭
        const result = resolveCampaignByEvent([campaign1, campaign2], "0xevent1");
        expect(result?.campaignId).toBe("0xcampaign2");
    });

    it("donationEndMs が同値のとき campaignId 昇順で先頭を返す", () => {
        const campaign1 = makeCampaign({
            disasterEventId: "0xevent1",
            campaignId: "0xcampaignB",
            donationEndMs: "1700000000000",
        });
        const campaign2 = makeCampaign({
            disasterEventId: "0xevent1",
            campaignId: "0xcampaignA",
            donationEndMs: "1700000000000",
        });
        // campaignA < campaignB なので campaignA が先頭
        const result = resolveCampaignByEvent([campaign1, campaign2], "0xevent1");
        expect(result?.campaignId).toBe("0xcampaignA");
    });

    it("別 disasterEventId の Campaign は選ばない", () => {
        const campaign1 = makeCampaign({ disasterEventId: "0xevent1", campaignId: "0xcampaign1" });
        const campaign2 = makeCampaign({ disasterEventId: "0xevent2", campaignId: "0xcampaign2" });
        const result = resolveCampaignByEvent([campaign1, campaign2], "0xevent2");
        expect(result?.campaignId).toBe("0xcampaign2");
    });
});
