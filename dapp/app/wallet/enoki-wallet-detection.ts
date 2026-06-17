import { isEnokiWallet, isGoogleWallet } from "@mysten/enoki";
import type { UiWallet } from "@mysten/dapp-kit-react";
import type { EnokiConfigResult } from "./enoki-config";

type SponsoredMembershipSignerCapability = {
    readonly signTransaction?: unknown;
};

export interface SponsoredMembershipWalletDecisionInput {
    readonly wallet: UiWallet | null;
    readonly enokiConfigResult: EnokiConfigResult;
    readonly signer: SponsoredMembershipSignerCapability;
}

export function hasSponsoredMembershipSigner(
    signer: unknown,
): signer is { readonly signTransaction: (...args: readonly unknown[]) => unknown } {
    return (
        typeof signer === "object" &&
        signer !== null &&
        typeof (signer as SponsoredMembershipSignerCapability).signTransaction === "function"
    );
}

export function shouldUseSponsoredMembershipTransaction({
    wallet,
    enokiConfigResult,
    signer,
}: SponsoredMembershipWalletDecisionInput): boolean {
    if (enokiConfigResult.kind !== "enabled") {
        return false;
    }
    if (wallet === null) {
        return false;
    }
    if (!hasSponsoredMembershipSigner(signer)) {
        return false;
    }

    return isEnokiWallet(wallet) && isGoogleWallet(wallet);
}
