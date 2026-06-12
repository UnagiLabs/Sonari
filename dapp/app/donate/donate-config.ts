export type DonateConfig = {
    readonly fundingPackageId: string;
    readonly donationPauseStateId: string;
    readonly mainPoolId: string;
    readonly operationsPoolId: string;
    readonly categoryRegistryId: string;
    readonly usdcType: string;
};

type DonateConfigOkResult = {
    readonly kind: "ok";
    readonly config: DonateConfig;
};

type DonateConfigMissingResult = {
    readonly kind: "missing_keys";
    readonly missingKeys: readonly string[];
};

export type DonateConfigResult = DonateConfigOkResult | DonateConfigMissingResult;

const DONATE_CONFIG_ENTRIES = [
    ["NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID", "fundingPackageId"],
    ["NEXT_PUBLIC_SONARI_DONATION_PAUSE_STATE_ID", "donationPauseStateId"],
    ["NEXT_PUBLIC_SONARI_MAIN_POOL_ID", "mainPoolId"],
    ["NEXT_PUBLIC_SONARI_OPERATIONS_POOL_ID", "operationsPoolId"],
    ["NEXT_PUBLIC_SONARI_CATEGORY_REGISTRY_ID", "categoryRegistryId"],
    ["NEXT_PUBLIC_SONARI_USDC_TYPE", "usdcType"],
] as const;

type DonateConfigEnvKey = (typeof DONATE_CONFIG_ENTRIES)[number][0];

type DonateConfigEnv = Readonly<Record<DonateConfigEnvKey, string | undefined>>;

export function readDonateConfigFromEnv(env: DonateConfigEnv): DonateConfigResult {
    const values: Record<keyof DonateConfig, string> = {
        fundingPackageId: "",
        donationPauseStateId: "",
        mainPoolId: "",
        operationsPoolId: "",
        categoryRegistryId: "",
        usdcType: "",
    };
    const missingKeys: string[] = [];

    for (const [key, target] of DONATE_CONFIG_ENTRIES) {
        const value = (env[key] ?? "").trim();
        if (value.length === 0) {
            missingKeys.push(key);
            continue;
        }
        values[target] = value;
    }

    if (missingKeys.length > 0) {
        return {
            kind: "missing_keys",
            missingKeys,
        };
    }

    return {
        kind: "ok",
        config: values,
    };
}

export function readDonateConfig(): DonateConfigResult {
    return readDonateConfigFromEnv({
        NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID: process.env.NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID,
        NEXT_PUBLIC_SONARI_DONATION_PAUSE_STATE_ID:
            process.env.NEXT_PUBLIC_SONARI_DONATION_PAUSE_STATE_ID,
        NEXT_PUBLIC_SONARI_MAIN_POOL_ID: process.env.NEXT_PUBLIC_SONARI_MAIN_POOL_ID,
        NEXT_PUBLIC_SONARI_OPERATIONS_POOL_ID:
            process.env.NEXT_PUBLIC_SONARI_OPERATIONS_POOL_ID,
        NEXT_PUBLIC_SONARI_CATEGORY_REGISTRY_ID:
            process.env.NEXT_PUBLIC_SONARI_CATEGORY_REGISTRY_ID,
        NEXT_PUBLIC_SONARI_USDC_TYPE: process.env.NEXT_PUBLIC_SONARI_USDC_TYPE,
    });
}
