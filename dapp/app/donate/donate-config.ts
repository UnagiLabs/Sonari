// USDC は Sui 上で一意に決まる coin type。contracts/Move.toml の addr_subst
// (usdc = 0xdba34672…) と一致させる cross-language contract。publish のたびに
// 変わる値ではないため、環境変数ではなくコード定数として持つ。
// 値を変えるときは Move.toml の addr_subst と同時に更新する。
export const SONARI_USDC_TYPE =
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

// 環境変数から読むのは packageID だけにする。pause_state / pool は packageID 起点で
// genesis イベントから導出し、usdcType は上記の定数を使う。
export type DonateEnvConfig = {
    readonly fundingPackageId: string;
};

// packageID 起点で導出する寄付先オブジェクト群。
export type DonatePoolObjects = {
    readonly donationPauseStateId: string;
    readonly mainPoolId: string;
    readonly operationsPoolId: string;
};

export type DonateConfig = {
    readonly fundingPackageId: string;
    readonly donationPauseStateId: string;
    readonly mainPoolId: string;
    readonly operationsPoolId: string;
    readonly usdcType: string;
};

type DonateEnvConfigOkResult = {
    readonly kind: "ok";
    readonly config: DonateEnvConfig;
};

type DonateEnvConfigMissingResult = {
    readonly kind: "missing_keys";
    readonly missingKeys: readonly string[];
};

export type DonateEnvConfigResult = DonateEnvConfigOkResult | DonateEnvConfigMissingResult;

const DONATE_ENV_ENTRIES = [
    ["NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID", "fundingPackageId"],
] as const;

type DonateEnvKey = (typeof DONATE_ENV_ENTRIES)[number][0];

type DonateConfigEnv = Readonly<Record<DonateEnvKey, string | undefined>>;

export function readDonateEnvConfigFromEnv(env: DonateConfigEnv): DonateEnvConfigResult {
    const values: Record<keyof DonateEnvConfig, string> = {
        fundingPackageId: "",
    };
    const missingKeys: string[] = [];

    for (const [key, target] of DONATE_ENV_ENTRIES) {
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

export function readDonateEnvConfig(): DonateEnvConfigResult {
    return readDonateEnvConfigFromEnv({
        NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID: process.env.NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID,
    });
}

// env 由来の packageID と、導出した pool / pause を合成して完全な設定にする pure 関数。
export function combineDonateConfig(
    env: DonateEnvConfig,
    pools: DonatePoolObjects,
): DonateConfig {
    return {
        fundingPackageId: env.fundingPackageId,
        donationPauseStateId: pools.donationPauseStateId,
        mainPoolId: pools.mainPoolId,
        operationsPoolId: pools.operationsPoolId,
        usdcType: SONARI_USDC_TYPE,
    };
}
