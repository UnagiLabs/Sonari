import { describe, expect, it } from "vitest";
import {
    buildDonateDonorPassReadState,
    buildDonateTxResultView,
    resolveDonateSubmitDisabledReason,
    isDonateSubmitDisabled,
    selectEmergencyBannerFromClaimCampaigns,
    buildCategoryListItems,
    type DonateDonorPassReadState,
    type DonateDestinationReadState,
    type DonateTxState,
} from "./donate-view-state";
import type { ClaimCampaignState } from "../claim/claim-campaigns";
import type { CategoryDestination } from "./donate-destinations";

function makeClaimCampaign(overrides: Partial<ClaimCampaignState> = {}): ClaimCampaignState {
    return {
        campaignId: "0xcampaign",
        disasterEventId: "0xevent",
        eventUid: `0x${"cd".repeat(32)}`,
        eventRevision: 1,
        affectedCellsRoot: `0x${"ef".repeat(32)}`,
        title: "M 6.3 - 260 km SSE of Dunhuang, China",
        region: "260 km SSE of Dunhuang, China",
        severityBand: 2,
        affectedCellCount: "113",
        donationEndMs: "9999999999999",
        claimEndMs: "9999999999999",
        censusSet: true,
        floorBudgetReturned: false,
        claimWindowOpen: true,
        floorClaimAvailable: true,
        payoutFinalized: false,
        currentRound: "0",
        roundFinalizedAtMs: "0",
        roundIntervalMs: "100",
        balanceUsdc: 0,
        totalDonatedUsdc: 0,
        totalPaidUsdc: 0,
        closed: false,
        paused: false,
        ...overrides,
    };
}

const readyDestinationState: DonateDestinationReadState = {
    status: "ready",
    campaigns: [{
        kind: "campaign",
        id: "0xcampaign",
        label: "Campaign",
        campaignId: "0xcampaign",
        categoryPoolId: "0xcategory",
        category: 1,
        donationEndMs: "1000",
    }],
    categories: [{
        kind: "category",
        id: "0xcategory",
        label: "Category",
        categoryPoolId: "0xcategory",
        category: 1,
    }],
    errorMessage: null,
};

const readyDonorPassState: DonateDonorPassReadState = {
    status: "ready",
    passId: null,
};

describe("resolveDonateSubmitDisabledReason", () => {
    it("returns configMissing when config is not ready", () => {
        const reason = resolveDonateSubmitDisabledReason({
            configReady: false,
            walletConnected: true,
            amountValidation: { ok: true, microUsdc: 1_000_000n },
            donorPassState: readyDonorPassState,
            selectedMode: "general",
            destinationState: readyDestinationState,
            selectedCampaignId: "",
            selectedCategoryPoolId: "",
        });

        expect(reason).toEqual({ kind: "configMissing" });
    });

    it("returns walletDisconnected when no wallet is connected", () => {
        const reason = resolveDonateSubmitDisabledReason({
            configReady: true,
            walletConnected: false,
            amountValidation: { ok: true, microUsdc: 1_000_000n },
            donorPassState: readyDonorPassState,
            selectedMode: "general",
            destinationState: readyDestinationState,
            selectedCampaignId: "",
            selectedCategoryPoolId: "",
        });

        expect(reason).toEqual({ kind: "walletDisconnected" });
    });

    it("returns amountInvalid for invalid amount", () => {
        const reason = resolveDonateSubmitDisabledReason({
            configReady: true,
            walletConnected: true,
            amountValidation: { ok: false, errorCode: "zero" },
            donorPassState: readyDonorPassState,
            selectedMode: "general",
            destinationState: readyDestinationState,
            selectedCampaignId: "",
            selectedCategoryPoolId: "",
        });

        expect(reason).toEqual({ kind: "amountInvalid", code: "zero" });
    });

    it("returns destinationLoading for campaign mode while loading destinations", () => {
        const reason = resolveDonateSubmitDisabledReason({
            configReady: true,
            walletConnected: true,
            amountValidation: { ok: true, microUsdc: 1_000_000n },
            donorPassState: readyDonorPassState,
            selectedMode: "campaign",
            destinationState: {
                status: "loading",
                campaigns: [],
                categories: [],
                errorMessage: null,
            },
            selectedCampaignId: "",
            selectedCategoryPoolId: "",
        });

        expect(reason).toEqual({ kind: "destinationsLoading", mode: "campaign" });
    });

    it("returns destinationNotFound for category mode when no categories exist", () => {
        const reason = resolveDonateSubmitDisabledReason({
            configReady: true,
            walletConnected: true,
            amountValidation: { ok: true, microUsdc: 1_000_000n },
            donorPassState: readyDonorPassState,
            selectedMode: "category",
            destinationState: {
                status: "ready",
                campaigns: [],
                categories: [],
                errorMessage: null,
            },
            selectedCampaignId: "",
            selectedCategoryPoolId: "",
        });

        expect(reason).toEqual({ kind: "destinationNotFound", mode: "category" });
    });

    it("returns null when all prerequisites are satisfied", () => {
        const reason = resolveDonateSubmitDisabledReason({
            configReady: true,
            walletConnected: true,
            amountValidation: { ok: true, microUsdc: 1_000_000n },
            donorPassState: readyDonorPassState,
            selectedMode: "campaign",
            destinationState: readyDestinationState,
            selectedCampaignId: "0xcampaign",
            selectedCategoryPoolId: "",
        });

        expect(reason).toBeNull();
    });

    it("returns donorPassLoading while the donor pass lookup is loading", () => {
        const reason = resolveDonateSubmitDisabledReason({
            configReady: true,
            walletConnected: true,
            amountValidation: { ok: true, microUsdc: 1_000_000n },
            donorPassState: { status: "loading" },
            selectedMode: "general",
            destinationState: readyDestinationState,
            selectedCampaignId: "",
            selectedCategoryPoolId: "",
        });

        expect(reason).toEqual({ kind: "donorPassLoading" });
    });

    it("returns donorPassError when the donor pass lookup fails", () => {
        const reason = resolveDonateSubmitDisabledReason({
            configReady: true,
            walletConnected: true,
            amountValidation: { ok: true, microUsdc: 1_000_000n },
            donorPassState: { status: "error", message: "registry down" },
            selectedMode: "general",
            destinationState: readyDestinationState,
            selectedCampaignId: "",
            selectedCategoryPoolId: "",
        });

        expect(reason).toEqual({ kind: "donorPassError", message: "registry down" });
    });
});

describe("buildDonateDonorPassReadState", () => {
    it("keeps none as ready before the first donation", () => {
        expect(buildDonateDonorPassReadState({ kind: "none" }, { noneAsError: false })).toEqual({
            status: "ready",
            passId: null,
        });
    });

    it("treats none as error after an initial donation submission", () => {
        expect(buildDonateDonorPassReadState({ kind: "none" }, { noneAsError: true })).toMatchObject({
            status: "error",
        });
    });

    it("returns the pass id when lookup succeeds", () => {
        expect(
            buildDonateDonorPassReadState(
                { kind: "ok", passId: "0xpass" },
                { noneAsError: true },
            ),
        ).toEqual({ status: "ready", passId: "0xpass" });
    });
});

describe("buildCategoryListItems", () => {
    const makeCategory = (category: number, categoryPoolId: string): CategoryDestination => ({
        kind: "category",
        id: categoryPoolId,
        label: category === 1 ? "Earthquake Relief Pool" : `Category ${category}`,
        categoryPoolId,
        category,
    });

    const earthquakeCategory = makeCategory(1, "0x" + "a".repeat(64));
    const floodCategory = makeCategory(3, "0x" + "b".repeat(64));

    it("places the earthquake category (category number 1) first when it exists", () => {
        const categories = [floodCategory, earthquakeCategory];
        const items = buildCategoryListItems(categories);
        expect(items[0]).toMatchObject({ kind: "available", category: 1 });
    });

    it("returns only selectable category items", () => {
        const categories = [earthquakeCategory];
        const items = buildCategoryListItems(categories);
        expect(items).toEqual([
            {
                kind: "available",
                id: earthquakeCategory.id,
                label: earthquakeCategory.label,
                categoryPoolId: earthquakeCategory.categoryPoolId,
                category: earthquakeCategory.category,
            },
        ]);
    });

    it("returns an empty list when no categories are available", () => {
        const items = buildCategoryListItems([]);
        expect(items).toEqual([]);
    });

    it("preserves original order for non-earthquake categories after the earthquake entry", () => {
        const cat2 = makeCategory(2, "0x" + "c".repeat(64));
        const cat3 = makeCategory(3, "0x" + "d".repeat(64));
        const categories = [cat3, earthquakeCategory, cat2];
        const items = buildCategoryListItems(categories);
        expect(items[0]).toMatchObject({ kind: "available", category: 1 });
        // cat3 (index 0 in input) and cat2 (index 2 in input) maintain relative order after earthquake
        const nonEarthquake = items.slice(1);
        expect(nonEarthquake[0]).toMatchObject({ kind: "available", category: 3 });
        expect(nonEarthquake[1]).toMatchObject({ kind: "available", category: 2 });
    });

    it("assigns stable id to each item", () => {
        const categories = [earthquakeCategory];
        const items = buildCategoryListItems(categories);
        for (const item of items) {
            expect(typeof item.id).toBe("string");
            expect(item.id.length).toBeGreaterThan(0);
        }
        const ids = items.map((item) => item.id);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(ids.length);
    });

    it("available item labelKey is the category label from CategoryDestination", () => {
        const categories = [earthquakeCategory];
        const items = buildCategoryListItems(categories);
        const available = items[0];
        expect(available).toBeDefined();
        expect(available?.label).toBe("Earthquake Relief Pool");
    });
});

describe("buildDonateTxResultView", () => {
    const digest = "8oM2nT3kQ4abcDEFghiJKLmnopQRstUVwxyz1234567";

    it("returns not loading and no CTA when idle", () => {
        const view = buildDonateTxResultView({ status: "idle" }, "testnet");
        expect(view).toEqual({
            loading: false,
            digest: null,
            explorerUrl: null,
            canRetry: false,
        });
    });

    it("returns loading while building", () => {
        const view = buildDonateTxResultView({ status: "building" }, "testnet");
        expect(view).toEqual({
            loading: true,
            digest: null,
            explorerUrl: null,
            canRetry: false,
        });
    });

    it("returns loading while submitting", () => {
        const view = buildDonateTxResultView({ status: "submitting" }, "testnet");
        expect(view.loading).toBe(true);
        expect(view.canRetry).toBe(false);
    });

    it("returns digest and explorer URL on testnet after submitted", () => {
        const state: DonateTxState = { status: "submitted", digest };
        const view = buildDonateTxResultView(state, "testnet");
        expect(view).toEqual({
            loading: false,
            digest,
            explorerUrl: `https://suiscan.xyz/testnet/tx/${digest}`,
            canRetry: false,
        });
    });

    it("returns digest with no explorer URL on localnet", () => {
        const state: DonateTxState = { status: "submitted", digest };
        const view = buildDonateTxResultView(state, "localnet");
        expect(view.explorerUrl).toBeNull();
    });

    it("returns retryable failure state", () => {
        const view = buildDonateTxResultView(
            { status: "failed", message: "Wallet rejected" },
            "testnet",
        );

        expect(view).toEqual({
            loading: false,
            digest: null,
            explorerUrl: null,
            canRetry: true,
        });
    });
});

describe("isDonateSubmitDisabled", () => {
    it("disables submit in demo mode regardless of other conditions", () => {
        expect(
            isDonateSubmitDisabled({
                demoMode: true,
                disabledReason: null,
                isInFlight: false,
            }),
        ).toBe(true);
    });

    it("enables submit when not in demo mode, no disabled reason, and not in flight", () => {
        expect(
            isDonateSubmitDisabled({
                demoMode: false,
                disabledReason: null,
                isInFlight: false,
            }),
        ).toBe(false);
    });

    it("disables submit when a disabled reason is present (non-demo)", () => {
        expect(
            isDonateSubmitDisabled({
                demoMode: false,
                disabledReason: { kind: "walletDisconnected" },
                isInFlight: false,
            }),
        ).toBe(true);
    });

    it("disables submit while a transaction is in flight (non-demo)", () => {
        expect(
            isDonateSubmitDisabled({
                demoMode: false,
                disabledReason: null,
                isInFlight: true,
            }),
        ).toBe(true);
    });
});

describe("selectEmergencyBannerFromClaimCampaigns", () => {
    it("実施中の Campaign の災害イベント名（title）を label に使う", () => {
        const campaign = makeClaimCampaign({
            campaignId: "0xc1",
            title: "M 6.3 - 260 km SSE of Dunhuang, China",
            donationEndMs: "9999999999999",
        });
        expect(selectEmergencyBannerFromClaimCampaigns([campaign], 1000n)).toEqual({
            id: "0xc1",
            label: "M 6.3 - 260 km SSE of Dunhuang, China",
        });
    });

    it("寄付受付が終了（donationEndMs <= now）なら null を返す", () => {
        const expired = makeClaimCampaign({ donationEndMs: "500" });
        expect(selectEmergencyBannerFromClaimCampaigns([expired], 1000n)).toBeNull();
    });

    it("0 件なら null を返す", () => {
        expect(selectEmergencyBannerFromClaimCampaigns([], 1000n)).toBeNull();
    });

    it("受付中が複数あるとき先頭を選ぶ", () => {
        const first = makeClaimCampaign({ campaignId: "0xa", title: "First" });
        const second = makeClaimCampaign({ campaignId: "0xb", title: "Second" });
        expect(selectEmergencyBannerFromClaimCampaigns([first, second], 1000n)).toEqual({
            id: "0xa",
            label: "First",
        });
    });
});
