import { describe, expect, it } from "vitest";
import {
    buildDonateSplitRows,
    buildDonateTxResultView,
    resolveDonateSubmitDisabledReason,
    type DonateDonorPassReadState,
    type DonateDestinationReadState,
    type DonateTxState,
} from "./donate-view-state";

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
