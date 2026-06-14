import { describe, expect, it } from "vitest";
import {
    buildDonateSplitRows,
    buildDonateDonorPassReadState,
    buildDonateTxResultView,
    resolveDonateSubmitDisabledReason,
    findActiveEmergencyCampaign,
    isDonateSubmitDisabled,
    selectEmergencyBannerCampaign,
    buildCategoryListItems,
    type DonateDonorPassReadState,
    type DonateDestinationReadState,
    type DonateTxState,
} from "./donate-view-state";
import type { CampaignDestination, CategoryDestination } from "./donate-destinations";

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

const t = (key: string) => key;

describe("buildDonateSplitRows", () => {
    it("describes general donations as 95% main and 5% operations", () => {
        const rows = buildDonateSplitRows({
            mode: "general",
            campaignLabel: "Campaign",
            categoryLabel: "Category",
            t,
        });

        expect(rows.map((row) => [row.key, row.value])).toEqual([
            ["main", "split.value.generalMainShare"],
            ["operations", "split.value.operationsShare"],
        ]);
    });

    it("describes campaign donations without claiming a fixed amount split", () => {
        const rows = buildDonateSplitRows({
            mode: "campaign",
            campaignLabel: "Campaign A",
            categoryLabel: "Category",
            t,
        });

        expect(rows).toEqual([
            {
                key: "campaign",
                label: "Campaign A",
                detail: "split.campaign.detail",
                value: "split.value.campaignTerms",
            },
            {
                key: "main",
                label: "split.main.label",
                detail: "split.main.campaignDetail",
                value: "split.value.campaignRemainder",
            },
            {
                key: "operations",
                label: "split.operations.label",
                detail: "split.operations.campaignDetail",
                value: "split.value.campaignOperations",
            },
        ]);
    });

    it("describes category donations as 90% category, 5% main, and 5% operations", () => {
        const rows = buildDonateSplitRows({
            mode: "category",
            campaignLabel: "Campaign",
            categoryLabel: "Category A",
            t,
        });

        expect(rows.map((row) => [row.key, row.value])).toEqual([
            ["category", "split.value.categoryShare"],
            ["main", "split.value.categoryMainShare"],
            ["operations", "split.value.operationsShare"],
        ]);
    });
});

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

describe("findActiveEmergencyCampaign", () => {
    const makeCampaign = (donationEndMs: string): CampaignDestination => ({
        kind: "campaign",
        id: `0x${"a".repeat(64)}`,
        label: "Test Campaign",
        campaignId: `0x${"a".repeat(64)}`,
        categoryPoolId: `0x${"b".repeat(64)}`,
        category: 1,
        donationEndMs,
    });

    it("returns the campaign when its deadline is in the future", () => {
        const nowMs = 1_000_000n;
        const campaign = makeCampaign("2000000");
        expect(findActiveEmergencyCampaign([campaign], nowMs)).toBe(campaign);
    });

    it("returns null when the campaign deadline is in the past", () => {
        const nowMs = 3_000_000n;
        const campaign = makeCampaign("1000000");
        expect(findActiveEmergencyCampaign([campaign], nowMs)).toBeNull();
    });

    it("returns null when the campaign deadline equals nowMs (boundary: deadline reached)", () => {
        const nowMs = 1_000_000n;
        const campaign = makeCampaign("1000000");
        expect(findActiveEmergencyCampaign([campaign], nowMs)).toBeNull();
    });

    it("returns null when there are no campaigns", () => {
        expect(findActiveEmergencyCampaign([], 0n)).toBeNull();
    });

    it("returns the first active campaign when multiple campaigns are mixed", () => {
        const nowMs = 5_000_000n;
        const expired = makeCampaign("1000000");
        const active1 = { ...makeCampaign("6000000"), id: `0x${"c".repeat(64)}`, campaignId: `0x${"c".repeat(64)}` };
        const active2 = { ...makeCampaign("7000000"), id: `0x${"d".repeat(64)}`, campaignId: `0x${"d".repeat(64)}` };
        const result = findActiveEmergencyCampaign([expired, active1, active2], nowMs);
        expect(result).toBe(active1);
    });

    it("returns null when all campaigns have expired", () => {
        const nowMs = 9_000_000n;
        const campaigns = [makeCampaign("1000000"), makeCampaign("2000000")];
        expect(findActiveEmergencyCampaign(campaigns, nowMs)).toBeNull();
    });
});

describe("selectEmergencyBannerCampaign", () => {
    const activeCampaign: CampaignDestination = {
        kind: "campaign",
        id: "0xcampaign1",
        label: "Earthquake Relief Pool",
        campaignId: "0xcampaign1",
        categoryPoolId: "0xcategorypool",
        category: 1,
        donationEndMs: "9999999999999",
    };

    it("returns null when status is idle", () => {
        const state: DonateDestinationReadState = {
            status: "idle",
            campaigns: [activeCampaign],
            categories: [],
            errorMessage: null,
        };
        expect(selectEmergencyBannerCampaign(state, 1000n)).toBeNull();
    });

    it("returns null when status is loading", () => {
        const state: DonateDestinationReadState = {
            status: "loading",
            campaigns: [activeCampaign],
            categories: [],
            errorMessage: null,
        };
        expect(selectEmergencyBannerCampaign(state, 1000n)).toBeNull();
    });

    it("returns null when status is error", () => {
        const state: DonateDestinationReadState = {
            status: "error",
            campaigns: [activeCampaign],
            categories: [],
            errorMessage: "network error",
        };
        expect(selectEmergencyBannerCampaign(state, 1000n)).toBeNull();
    });

    it("returns the active campaign when status is ready and a campaign is active", () => {
        const state: DonateDestinationReadState = {
            status: "ready",
            campaigns: [activeCampaign],
            categories: [],
            errorMessage: null,
        };
        const nowMs = 1000n;
        expect(selectEmergencyBannerCampaign(state, nowMs)).toBe(activeCampaign);
    });

    it("returns null when status is ready but no campaign is active", () => {
        const expiredCampaign: CampaignDestination = {
            kind: "campaign",
            id: "0xcampaign2",
            label: "Expired Campaign",
            campaignId: "0xcampaign2",
            categoryPoolId: "0xcategorypool",
            category: 1,
            donationEndMs: "500",
        };
        const state: DonateDestinationReadState = {
            status: "ready",
            campaigns: [expiredCampaign],
            categories: [],
            errorMessage: null,
        };
        const nowMs = 1000n;
        expect(selectEmergencyBannerCampaign(state, nowMs)).toBeNull();
    });

    it("returns null when status is ready and campaigns array is empty", () => {
        const state: DonateDestinationReadState = {
            status: "ready",
            campaigns: [],
            categories: [],
            errorMessage: null,
        };
        expect(selectEmergencyBannerCampaign(state, 1000n)).toBeNull();
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
        const availableItems = items.filter((item) => item.kind === "available");
        expect(availableItems[0]).toMatchObject({ kind: "available", category: 1 });
    });

    it("places coming soon items after available items", () => {
        const categories = [earthquakeCategory];
        const items = buildCategoryListItems(categories);
        const firstComingSoonIndex = items.findIndex((item) => item.kind === "comingSoon");
        // All items before the first comingSoon must be available
        const itemsBeforeComingSoon = items.slice(0, firstComingSoonIndex);
        expect(itemsBeforeComingSoon.every((item) => item.kind === "available")).toBe(true);
        expect(firstComingSoonIndex).toBeGreaterThan(-1);
    });

    it("coming soon items have no categoryPoolId and are not selectable", () => {
        const categories = [earthquakeCategory];
        const items = buildCategoryListItems(categories);
        const comingSoonItems = items.filter((item) => item.kind === "comingSoon");
        expect(comingSoonItems.length).toBeGreaterThan(0);
        for (const item of comingSoonItems) {
            expect(item.kind).toBe("comingSoon");
            if (item.kind === "comingSoon") {
                // comingSoon items must not have categoryPoolId
                expect(item).not.toHaveProperty("categoryPoolId");
            }
        }
    });

    it("returns coming soon items even when categories array is empty", () => {
        const items = buildCategoryListItems([]);
        const comingSoonItems = items.filter((item) => item.kind === "comingSoon");
        expect(comingSoonItems.length).toBeGreaterThan(0);
    });

    it("preserves original order for non-earthquake categories after the earthquake entry", () => {
        const cat2 = makeCategory(2, "0x" + "c".repeat(64));
        const cat3 = makeCategory(3, "0x" + "d".repeat(64));
        const categories = [cat3, earthquakeCategory, cat2];
        const items = buildCategoryListItems(categories);
        const availableItems = items.filter((item) => item.kind === "available");
        expect(availableItems[0]).toMatchObject({ kind: "available", category: 1 });
        // cat3 (index 0 in input) and cat2 (index 2 in input) maintain relative order after earthquake
        const nonEarthquake = availableItems.slice(1);
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
        const available = items.find((item) => item.kind === "available");
        expect(available).toBeDefined();
        if (available?.kind === "available") {
            expect(available.label).toBe("Earthquake Relief Pool");
        }
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
            explorerUrl: `https://testnet.suivision.xyz/txblock/${digest}`,
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
