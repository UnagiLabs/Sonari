import { describe, expect, it } from "vitest";
import type { ClaimCampaignState } from "./claim/claim-campaigns";
import { selectClaimBannerCta } from "./home-claim-banner-state";

// ClaimCampaignState は必須フィールドが多いため、テストで使う最小限の値を
// 埋めるファクトリを用意する。判定に関わるのは campaignId / disasterEventId と
// claimWindowOpen だけなので、それ以外はダミー値で固定し、必要な値だけ上書きする。
function makeCampaign(overrides: Partial<ClaimCampaignState>): ClaimCampaignState {
    return {
        campaignId: "0x00000000000000000000000000000000000000000000000000000000000000c1",
        disasterEventId: "0x00000000000000000000000000000000000000000000000000000000000000d1",
        eventUid: "0x00000000000000000000000000000000000000000000000000000000000000e1",
        eventRevision: 1,
        affectedCellsRoot: "0x00000000000000000000000000000000000000000000000000000000000000f1",
        title: "Test Disaster",
        region: "Test Region",
        severityBand: 1,
        affectedCellCount: "10",
        donationEndMs: "1000",
        claimEndMs: "2000",
        censusSet: true,
        floorBudgetReturned: false,
        claimWindowOpen: true,
        floorClaimAvailable: true,
        payoutFinalized: false,
        currentRound: "0",
        roundFinalizedAtMs: "0",
        roundIntervalMs: "100",
        ...overrides,
    };
}

describe("selectClaimBannerCta", () => {
    const openCampaign = makeCampaign({
        campaignId: "0x00000000000000000000000000000000000000000000000000000000000000a1",
        claimWindowOpen: true,
    });

    it("returns null when the wallet is not connected", () => {
        expect(
            selectClaimBannerCta({
                walletConnected: false,
                registered: true,
                campaigns: [openCampaign],
            }),
        ).toBeNull();
    });

    it("returns null when the user is not registered", () => {
        expect(
            selectClaimBannerCta({
                walletConnected: true,
                registered: false,
                campaigns: [openCampaign],
            }),
        ).toBeNull();
    });

    it("returns null when connected and registered but there are no campaigns", () => {
        expect(
            selectClaimBannerCta({
                walletConnected: true,
                registered: true,
                campaigns: [],
            }),
        ).toBeNull();
    });

    it("returns null when no campaign has an open claim window", () => {
        expect(
            selectClaimBannerCta({
                walletConnected: true,
                registered: true,
                campaigns: [
                    makeCampaign({ claimWindowOpen: false }),
                    makeCampaign({ claimWindowOpen: false }),
                ],
            }),
        ).toBeNull();
    });

    it("returns the disasterEventId when connected, registered, and a claim window is open", () => {
        const cta = selectClaimBannerCta({
            walletConnected: true,
            registered: true,
            campaigns: [openCampaign],
        });
        expect(cta).not.toBeNull();
        expect(cta?.disasterEventId).toBe(openCampaign.disasterEventId);
        expect(cta?.campaignId).toBe(openCampaign.campaignId);
    });

    it("picks the first campaign with an open claim window, skipping closed ones", () => {
        const closed = makeCampaign({
            campaignId: "0x00000000000000000000000000000000000000000000000000000000000000b2",
            claimWindowOpen: false,
        });
        const firstOpen = makeCampaign({
            campaignId: "0x00000000000000000000000000000000000000000000000000000000000000b3",
            disasterEventId: "0x00000000000000000000000000000000000000000000000000000000000000d3",
            claimWindowOpen: true,
        });
        const secondOpen = makeCampaign({
            campaignId: "0x00000000000000000000000000000000000000000000000000000000000000b4",
            claimWindowOpen: true,
        });
        const cta = selectClaimBannerCta({
            walletConnected: true,
            registered: true,
            campaigns: [closed, firstOpen, secondOpen],
        });
        expect(cta?.disasterEventId).toBe(firstOpen.disasterEventId);
    });

    it("returns a stable shape: { disasterEventId, campaignId }", () => {
        const cta = selectClaimBannerCta({
            walletConnected: true,
            registered: true,
            campaigns: [openCampaign],
        });
        expect(Object.keys(cta ?? {})).toStrictEqual(["disasterEventId", "campaignId"]);
    });
});
