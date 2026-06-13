import { suiExplorerTxUrl } from "../wallet/sui-explorer";
import type { WalletNetwork } from "../wallet/wallet-network";
import type { CampaignDestination, CategoryDestination } from "./donate-destinations";
import type { DonationAmountErrorCode, DonationAmountValidationResult } from "./donate-amount";

export type DonateDestinationMode = "general" | "campaign" | "category";

export interface DonateSplitRow {
    readonly key: string;
    readonly label: string;
    readonly detail: string;
    readonly value: string;
}

export function buildDonateSplitRows(input: {
    readonly mode: DonateDestinationMode;
    readonly campaignLabel: string;
    readonly categoryLabel: string;
    readonly t: (key: string) => string;
}): readonly DonateSplitRow[] {
    if (input.mode === "general") {
        return [
            {
                key: "main",
                label: input.t("split.main.label"),
                detail: input.t("split.main.detail"),
                value: input.t("split.value.generalMainShare"),
            },
            {
                key: "operations",
                label: input.t("split.operations.label"),
                detail: input.t("split.operations.detail"),
                value: input.t("split.value.operationsShare"),
            },
        ];
    }

    if (input.mode === "campaign") {
        return [
            {
                key: "campaign",
                label: input.campaignLabel,
                detail: input.t("split.campaign.detail"),
                value: input.t("split.value.campaignTerms"),
            },
            {
                key: "main",
                label: input.t("split.main.label"),
                detail: input.t("split.main.campaignDetail"),
                value: input.t("split.value.campaignRemainder"),
            },
            {
                key: "operations",
                label: input.t("split.operations.label"),
                detail: input.t("split.operations.campaignDetail"),
                value: input.t("split.value.campaignOperations"),
            },
        ];
    }

    return [
        {
            key: "category",
            label: input.categoryLabel,
            detail: input.t("split.category.detail"),
            value: input.t("split.value.categoryShare"),
        },
        {
            key: "main",
            label: input.t("split.main.label"),
            detail: input.t("split.main.detail"),
            value: input.t("split.value.categoryMainShare"),
        },
        {
            key: "operations",
            label: input.t("split.operations.label"),
            detail: input.t("split.operations.detail"),
            value: input.t("split.value.operationsShare"),
        },
    ];
}

export interface DonateDestinationReadState {
    readonly status: "idle" | "loading" | "ready" | "error";
    readonly campaigns: readonly CampaignDestination[];
    readonly categories: readonly CategoryDestination[];
    readonly errorMessage: string | null;
}

export type DonateDonorPassReadState =
    | { readonly status: "idle" }
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly passId: string | null }
    | { readonly status: "error"; readonly message: string };

export type DonateDonorPassLookupResult =
    | { readonly kind: "ok"; readonly passId: string }
    | { readonly kind: "none" }
    | { readonly kind: "error"; readonly message: string };

const DONOR_PASS_NOT_FOUND_AFTER_SUBMIT =
    "DonorPass was not found after donation submission. Please wait and try again.";

export function buildDonateDonorPassReadState(
    result: DonateDonorPassLookupResult,
    input: { readonly noneAsError: boolean },
): DonateDonorPassReadState {
    switch (result.kind) {
        case "ok":
            return { status: "ready", passId: result.passId };
        case "none":
            return input.noneAsError
                ? { status: "error", message: DONOR_PASS_NOT_FOUND_AFTER_SUBMIT }
                : { status: "ready", passId: null };
        case "error":
            return { status: "error", message: result.message };
    }
}

export interface DonateSubmitDisabledInput {
    readonly configReady: boolean;
    readonly walletConnected: boolean;
    readonly amountValidation: DonationAmountValidationResult;
    readonly donorPassState: DonateDonorPassReadState;
    readonly selectedMode: DonateDestinationMode;
    readonly destinationState: DonateDestinationReadState;
    readonly selectedCampaignId: string;
    readonly selectedCategoryPoolId: string;
}

export type DonateSubmitDisabledReason =
    | { readonly kind: "configMissing" }
    | { readonly kind: "walletDisconnected" }
    | { readonly kind: "amountInvalid"; readonly code: DonationAmountErrorCode }
    | { readonly kind: "donorPassLoading" }
    | { readonly kind: "donorPassError"; readonly message: string }
    | {
          readonly kind: "destinationsLoading";
          readonly mode: "campaign" | "category";
      }
    | {
          readonly kind: "destinationsError";
          readonly mode: "campaign" | "category";
          readonly message: string;
      }
    | {
          readonly kind: "destinationNotFound";
          readonly mode: "campaign" | "category";
      }
    | {
          readonly kind: "destinationNotSelected";
          readonly mode: "campaign" | "category";
      };

export function resolveDonateSubmitDisabledReason(
    input: DonateSubmitDisabledInput,
): DonateSubmitDisabledReason | null {
    if (!input.configReady) {
        return { kind: "configMissing" };
    }

    if (!input.walletConnected) {
        return { kind: "walletDisconnected" };
    }

    if (!input.amountValidation.ok) {
        return { kind: "amountInvalid", code: input.amountValidation.errorCode };
    }

    if (input.donorPassState.status === "loading") {
        return { kind: "donorPassLoading" };
    }

    if (input.donorPassState.status === "error") {
        return { kind: "donorPassError", message: input.donorPassState.message };
    }

    if (input.selectedMode === "campaign") {
        if (input.destinationState.status === "loading") {
            return { kind: "destinationsLoading", mode: "campaign" };
        }
        if (input.destinationState.status === "error") {
            return {
                kind: "destinationsError",
                mode: "campaign",
                message: input.destinationState.errorMessage ?? "Failed to load campaign destinations.",
            };
        }
        if (input.destinationState.campaigns.length === 0) {
            return { kind: "destinationNotFound", mode: "campaign" };
        }
        if (input.selectedCampaignId.length === 0) {
            return { kind: "destinationNotSelected", mode: "campaign" };
        }
    }

    if (input.selectedMode === "category") {
        if (input.destinationState.status === "loading") {
            return { kind: "destinationsLoading", mode: "category" };
        }
        if (input.destinationState.status === "error") {
            return {
                kind: "destinationsError",
                mode: "category",
                message: input.destinationState.errorMessage ?? "Failed to load category destinations.",
            };
        }
        if (input.destinationState.categories.length === 0) {
            return { kind: "destinationNotFound", mode: "category" };
        }
        if (input.selectedCategoryPoolId.length === 0) {
            return { kind: "destinationNotSelected", mode: "category" };
        }
    }

    return null;
}

export type DonateTxState =
    | { readonly status: "idle" }
    | { readonly status: "building" }
    | { readonly status: "submitting" }
    | { readonly status: "submitted"; readonly digest: string }
    | { readonly status: "failed"; readonly message: string };

export interface DonateTxResultView {
    readonly loading: boolean;
    readonly digest: string | null;
    readonly explorerUrl: string | null;
    readonly canRetry: boolean;
}

export function buildDonateTxResultView(
    state: DonateTxState,
    network: WalletNetwork,
): DonateTxResultView {
    if (state.status === "submitted") {
        return {
            loading: false,
            digest: state.digest,
            explorerUrl: suiExplorerTxUrl(network, state.digest),
            canRetry: false,
        };
    }

    return {
        loading: state.status === "building" || state.status === "submitting",
        digest: null,
        explorerUrl: null,
        canRetry: state.status === "failed",
    };
}
