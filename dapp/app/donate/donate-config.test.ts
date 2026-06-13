import { describe, expect, it } from "vitest";
import {
    combineDonateConfig,
    readDonateEnvConfigFromEnv,
    resolveUsdcType,
    USDC_TYPE_BY_NETWORK,
} from "./donate-config";

const MAINNET_USDC =
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const TESTNET_USDC =
    "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

describe("readDonateEnvConfigFromEnv", () => {
    it("returns ok when the funding package id is present", () => {
        const result = readDonateEnvConfigFromEnv({
            NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID: " 0xfunding ",
        });

        expect(result).toEqual({
            kind: "ok",
            config: {
                fundingPackageId: "0xfunding",
            },
        });
    });

    it("returns missing_keys when the funding package id is missing", () => {
        const result = readDonateEnvConfigFromEnv({
            NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID: "",
        });

        expect(result).toEqual({
            kind: "missing_keys",
            missingKeys: ["NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID"],
        });
    });
});

describe("resolveUsdcType", () => {
    it("uses the testnet Circle USDC on testnet", () => {
        expect(resolveUsdcType("testnet")).toBe(TESTNET_USDC);
    });

    it("uses the testnet Circle USDC on localnet (dev fallback)", () => {
        expect(resolveUsdcType("localnet")).toBe(TESTNET_USDC);
    });

    it("maps mainnet/testnet to their network-specific Circle USDC addresses", () => {
        expect(USDC_TYPE_BY_NETWORK.mainnet).toBe(MAINNET_USDC);
        expect(USDC_TYPE_BY_NETWORK.testnet).toBe(TESTNET_USDC);
    });

    it("never reuses the mainnet USDC address on a non-mainnet network", () => {
        expect(resolveUsdcType("testnet")).not.toBe(MAINNET_USDC);
        expect(resolveUsdcType("localnet")).not.toBe(MAINNET_USDC);
    });
});

describe("combineDonateConfig", () => {
    it("merges env config, derived pools, and the network-resolved usdc type", () => {
        const config = combineDonateConfig(
            { fundingPackageId: "0xfunding" },
            {
                donationPauseStateId: "0xpause",
                mainPoolId: "0xmain",
                operationsPoolId: "0xoperations",
            },
            "testnet",
        );

        expect(config).toEqual({
            fundingPackageId: "0xfunding",
            donationPauseStateId: "0xpause",
            mainPoolId: "0xmain",
            operationsPoolId: "0xoperations",
            usdcType: TESTNET_USDC,
        });
    });
});
