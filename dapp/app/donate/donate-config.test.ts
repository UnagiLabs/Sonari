import { describe, expect, it } from "vitest";
import { readDonateConfigFromEnv } from "./donate-config";

describe("readDonateConfig", () => {
    it("returns ok when all required values are present", () => {
        const result = readDonateConfigFromEnv({
            NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID: "0xfunding",
            NEXT_PUBLIC_SONARI_DONATION_PAUSE_STATE_ID: " 0xpause ",
            NEXT_PUBLIC_SONARI_MAIN_POOL_ID: "0xmain",
            NEXT_PUBLIC_SONARI_OPERATIONS_POOL_ID: "0xoperations",
            NEXT_PUBLIC_SONARI_CATEGORY_REGISTRY_ID: " 0xcategory ",
            NEXT_PUBLIC_SONARI_USDC_TYPE: "0xusdc",
        });

        expect(result).toEqual({
            kind: "ok",
            config: {
                fundingPackageId: "0xfunding",
                donationPauseStateId: "0xpause",
                mainPoolId: "0xmain",
                operationsPoolId: "0xoperations",
                categoryRegistryId: "0xcategory",
                usdcType: "0xusdc",
            },
        });
    });

    it("returns missing_keys when one or more required keys are missing", () => {
        const result = readDonateConfigFromEnv({
            NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID: "",
            NEXT_PUBLIC_SONARI_DONATION_PAUSE_STATE_ID: undefined,
            NEXT_PUBLIC_SONARI_MAIN_POOL_ID: "0xmain",
            NEXT_PUBLIC_SONARI_USDC_TYPE: "0xusdc",
        });

        expect(result).toEqual({
            kind: "missing_keys",
            missingKeys: [
                "NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID",
                "NEXT_PUBLIC_SONARI_DONATION_PAUSE_STATE_ID",
                "NEXT_PUBLIC_SONARI_OPERATIONS_POOL_ID",
                "NEXT_PUBLIC_SONARI_CATEGORY_REGISTRY_ID",
            ],
        });
    });
});
