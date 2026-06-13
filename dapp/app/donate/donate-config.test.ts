import { describe, expect, it } from "vitest";
import {
    combineDonateConfig,
    readDonateEnvConfigFromEnv,
    SONARI_USDC_TYPE,
} from "./donate-config";

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

describe("combineDonateConfig", () => {
    it("merges env config, derived pools, and the usdc constant", () => {
        const config = combineDonateConfig(
            { fundingPackageId: "0xfunding" },
            {
                donationPauseStateId: "0xpause",
                mainPoolId: "0xmain",
                operationsPoolId: "0xoperations",
            },
        );

        expect(config).toEqual({
            fundingPackageId: "0xfunding",
            donationPauseStateId: "0xpause",
            mainPoolId: "0xmain",
            operationsPoolId: "0xoperations",
            usdcType: SONARI_USDC_TYPE,
        });
    });

    it("uses the canonical USDC coin type from Move.toml addr_subst", () => {
        expect(SONARI_USDC_TYPE).toBe(
            "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
        );
    });
});
