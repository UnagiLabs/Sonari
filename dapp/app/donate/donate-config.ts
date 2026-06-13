import type { WalletNetwork } from "../wallet/wallet-network";

// USDC の coin type は Sui の network ごとに異なる package に publish されている
// Circle 公式 USDC のアドレス。mainnet と testnet で別アドレスなので network で分岐する。
// 環境変数ではなくコード定数として持ち、値を変えるときは contracts/Move.toml の
// addr_subst（publish 対象 network の値）と同時に更新する cross-language contract。
// デプロイ済み funding package の donate_*_usdc が要求する Coin<...::usdc::USDC> 型と
// 一致させること。
export const USDC_TYPE_BY_NETWORK = {
    mainnet: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    testnet: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
} as const;

// 接続中の network に対応する USDC coin type を解決する。localnet は dev 用に
// testnet と同じ Circle USDC を使う。WalletNetwork に mainnet を追加した場合は
// switch の網羅性チェックがここでの配線漏れを検出する（mainnet → USDC_TYPE_BY_NETWORK.mainnet）。
export function resolveUsdcType(network: WalletNetwork): string {
    switch (network) {
        case "testnet":
        case "localnet":
            return USDC_TYPE_BY_NETWORK.testnet;
    }
}

// 環境変数から読むのは packageID だけにする。pause_state / pool は packageID 起点で
// genesis イベントから導出し、usdcType は上記の定数を使う。
export type DonateEnvConfig = {
    readonly fundingPackageId: string;
};

// env から読むのは packageID だけ。usdcType は network から resolveUsdcType で導出する。
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

// env 由来の packageID と、導出した pool / pause、network から解決した usdcType を
// 合成して完全な設定にする pure 関数。
export function combineDonateConfig(
    env: DonateEnvConfig,
    pools: DonatePoolObjects,
    network: WalletNetwork,
): DonateConfig {
    return {
        fundingPackageId: env.fundingPackageId,
        donationPauseStateId: pools.donationPauseStateId,
        mainPoolId: pools.mainPoolId,
        operationsPoolId: pools.operationsPoolId,
        usdcType: resolveUsdcType(network),
    };
}
