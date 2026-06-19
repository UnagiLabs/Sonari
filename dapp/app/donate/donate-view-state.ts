import type { ClaimCampaignState } from "../claim/claim-campaigns";
import { suiExplorerTxUrl } from "../wallet/sui-explorer";
import type { WalletNetwork } from "../wallet/wallet-network";
import type { CampaignDestination, CategoryDestination } from "./donate-destinations";
import type { DonationAmountErrorCode, DonationAmountValidationResult } from "./donate-amount";
import type { EmergencyBannerCampaign } from "./emergency-banner-state";

export type CategoryListItem =
    {
        readonly kind: "available";
        readonly id: string;
        readonly label: string;
        readonly categoryPoolId: string;
        readonly category: number;
    };

const EARTHQUAKE_CATEGORY = 1;

export function buildCategoryListItems(
    categories: readonly CategoryDestination[],
): readonly CategoryListItem[] {
    // Stable-sort: earthquake (category 1) first, rest preserve original order
    const sorted = [...categories].sort((a, b) => {
        if (a.category === EARTHQUAKE_CATEGORY && b.category !== EARTHQUAKE_CATEGORY) {
            return -1;
        }
        if (a.category !== EARTHQUAKE_CATEGORY && b.category === EARTHQUAKE_CATEGORY) {
            return 1;
        }
        return 0;
    });

    const available: CategoryListItem[] = sorted.map((cat) => ({
        kind: "available",
        id: cat.id,
        label: cat.label,
        categoryPoolId: cat.categoryPoolId,
        category: cat.category,
    }));

    return available;
}

export type DonateDestinationMode = "general" | "campaign" | "category";

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

/**
 * 寄付ボタンを無効化すべきか判定する。
 * demoMode が true のときは、ほかの条件によらず常に無効化する。
 * これはデモページから実送金が走らないことを保証する単一の判定点。
 */
export function isDonateSubmitDisabled(input: {
    readonly demoMode: boolean;
    readonly disabledReason: DonateSubmitDisabledReason | null;
    readonly isInFlight: boolean;
}): boolean {
    return input.demoMode || input.disabledReason !== null || input.isInFlight;
}

/**
 * 災害 Campaign 一覧（DisasterEvent 紐付け済み）から緊急バナー用の情報を選ぶ。
 * 寄付受付中（donationEndMs > now）の先頭を 1 件選び、表示名には災害イベント名
 * （ClaimCampaignState.title）を使う。CampaignCreated イベントだけでは title を
 * 取れないため、title を持つ ClaimCampaignState から選定する。
 * 受付中が無ければ null（バナー非表示）。
 */
export function selectEmergencyBannerFromClaimCampaigns(
    campaigns: readonly ClaimCampaignState[],
    nowMs: bigint,
): EmergencyBannerCampaign | null {
    for (const campaign of campaigns) {
        if (BigInt(campaign.donationEndMs) > nowMs) {
            return {
                id: campaign.campaignId,
                disasterEventId: campaign.disasterEventId,
                label: campaign.title,
            };
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
