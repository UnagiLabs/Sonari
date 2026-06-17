import { describe, expect, it } from "vitest";
import type { EnokiConfigResult } from "./enoki-config";
import {
    hasSponsoredMembershipSigner,
    shouldUseSponsoredMembershipTransaction,
} from "./enoki-wallet-detection";

const enabledConfig: EnokiConfigResult = {
    kind: "enabled",
    config: {
        apiKey: "enoki_public_key",
        googleClientId: "google-client-id",
        network: "testnet",
    },
};

const disabledConfig: EnokiConfigResult = {
    kind: "disabled",
    reason: "missing_api_key",
};

function walletWithProvider(provider: string) {
    return {
        name: `${provider} wallet`,
        version: "1.0.0",
        icon: "data:image/svg+xml;base64,PHN2Zy8+",
        accounts: [],
        chains: ["sui:testnet"],
        features: {
            "enoki:getMetadata": {
                version: "1.0.0",
                getMetadata: () => ({ provider }),
            },
        },
    };
}

describe("hasSponsoredMembershipSigner", () => {
    it("requires a signTransaction function", () => {
        expect(hasSponsoredMembershipSigner({ signTransaction: async () => ({}) })).toBe(true);
        expect(hasSponsoredMembershipSigner({ signTransaction: "not a function" })).toBe(false);
        expect(hasSponsoredMembershipSigner(null)).toBe(false);
    });
});

describe("shouldUseSponsoredMembershipTransaction", () => {
    it("enables sponsored membership only for Google Enoki wallet with config and signing capability", () => {
        expect(
            shouldUseSponsoredMembershipTransaction({
                wallet: walletWithProvider("google"),
                enokiConfigResult: enabledConfig,
                signer: { signTransaction: async () => ({ bytes: "bytes", signature: "signature" }) },
            }),
        ).toBe(true);
    });

    it("falls back when Enoki feature config is disabled", () => {
        expect(
            shouldUseSponsoredMembershipTransaction({
                wallet: walletWithProvider("google"),
                enokiConfigResult: disabledConfig,
                signer: { signTransaction: async () => ({ bytes: "bytes", signature: "signature" }) },
            }),
        ).toBe(false);
    });

    it("falls back for non-Google Enoki wallets", () => {
        expect(
            shouldUseSponsoredMembershipTransaction({
                wallet: walletWithProvider("facebook"),
                enokiConfigResult: enabledConfig,
                signer: { signTransaction: async () => ({ bytes: "bytes", signature: "signature" }) },
            }),
        ).toBe(false);
    });

    it("falls back when signing capability is unavailable", () => {
        expect(
            shouldUseSponsoredMembershipTransaction({
                wallet: walletWithProvider("google"),
                enokiConfigResult: enabledConfig,
                signer: {},
            }),
        ).toBe(false);
    });

    it("falls back when no wallet is connected", () => {
        expect(
            shouldUseSponsoredMembershipTransaction({
                wallet: null,
                enokiConfigResult: enabledConfig,
                signer: { signTransaction: async () => ({ bytes: "bytes", signature: "signature" }) },
            }),
        ).toBe(false);
    });
});
