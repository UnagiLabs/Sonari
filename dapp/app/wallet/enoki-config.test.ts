import { describe, expect, it } from "vitest";
import { readEnokiConfig } from "./enoki-config";

describe("readEnokiConfig", () => {
    const validEnv = {
        NEXT_PUBLIC_SUI_NETWORK: "testnet",
        NEXT_PUBLIC_ENOKI_API_KEY: " enoki_public_key ",
        NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID: " google-client-id ",
    };

    it("enables Enoki only when raw Sui network is explicitly testnet and public env is present", () => {
        expect(readEnokiConfig(validEnv)).toEqual({
            kind: "enabled",
            config: {
                apiKey: "enoki_public_key",
                googleClientId: "google-client-id",
                network: "testnet",
            },
        });
    });

    it("does not enable Enoki when Sui network env is unset even though the dapp network falls back to testnet", () => {
        expect(
            readEnokiConfig({
                ...validEnv,
                NEXT_PUBLIC_SUI_NETWORK: undefined,
            }),
        ).toEqual({
            kind: "disabled",
            reason: "sui_network_not_explicit_testnet",
        });
    });

    it("does not enable Enoki when Sui network env is invalid even though the dapp network falls back to testnet", () => {
        expect(
            readEnokiConfig({
                ...validEnv,
                NEXT_PUBLIC_SUI_NETWORK: "foo",
            }),
        ).toEqual({
            kind: "disabled",
            reason: "sui_network_not_explicit_testnet",
        });
    });

    it("does not enable Enoki on mainnet", () => {
        expect(
            readEnokiConfig({
                ...validEnv,
                NEXT_PUBLIC_SUI_NETWORK: "mainnet",
            }),
        ).toEqual({
            kind: "disabled",
            reason: "sui_network_not_explicit_testnet",
        });
    });

    it("does not enable Enoki on localnet", () => {
        expect(
            readEnokiConfig({
                ...validEnv,
                NEXT_PUBLIC_SUI_NETWORK: "localnet",
            }),
        ).toEqual({
            kind: "disabled",
            reason: "sui_network_not_explicit_testnet",
        });
    });

    it("does not enable Enoki when the API key is empty", () => {
        expect(
            readEnokiConfig({
                ...validEnv,
                NEXT_PUBLIC_ENOKI_API_KEY: " ",
            }),
        ).toEqual({
            kind: "disabled",
            reason: "missing_api_key",
        });
    });

    it("does not enable Enoki when the Google client ID is empty", () => {
        expect(
            readEnokiConfig({
                ...validEnv,
                NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID: "",
            }),
        ).toEqual({
            kind: "disabled",
            reason: "missing_google_client_id",
        });
    });

    it("does not throw when env is unset", () => {
        expect(readEnokiConfig({})).toEqual({
            kind: "disabled",
            reason: "sui_network_not_explicit_testnet",
        });
    });
});
