export type EnokiNetwork = "testnet";

export type EnokiConfig = {
    readonly apiKey: string;
    readonly googleClientId: string;
    readonly network: EnokiNetwork;
};

export type EnokiDisabledReason =
    | "sui_network_not_explicit_testnet"
    | "missing_api_key"
    | "missing_google_client_id";

type EnokiConfigEnabledResult = {
    readonly kind: "enabled";
    readonly config: EnokiConfig;
};

type EnokiConfigDisabledResult = {
    readonly kind: "disabled";
    readonly reason: EnokiDisabledReason;
};

export type EnokiConfigResult = EnokiConfigEnabledResult | EnokiConfigDisabledResult;

type EnokiConfigEnv = Readonly<{
    NEXT_PUBLIC_SUI_NETWORK?: string | undefined;
    NEXT_PUBLIC_ENOKI_API_KEY?: string | undefined;
    NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID?: string | undefined;
}>;

export function readEnokiConfig(
    input: EnokiConfigEnv = {
        NEXT_PUBLIC_SUI_NETWORK: process.env.NEXT_PUBLIC_SUI_NETWORK,
        NEXT_PUBLIC_ENOKI_API_KEY: process.env.NEXT_PUBLIC_ENOKI_API_KEY,
        NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID: process.env.NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID,
    },
): EnokiConfigResult {
    const suiNetwork = (input.NEXT_PUBLIC_SUI_NETWORK ?? "").trim();
    if (suiNetwork !== "testnet") {
        return {
            kind: "disabled",
            reason: "sui_network_not_explicit_testnet",
        };
    }

    const apiKey = (input.NEXT_PUBLIC_ENOKI_API_KEY ?? "").trim();
    if (apiKey.length === 0) {
        return {
            kind: "disabled",
            reason: "missing_api_key",
        };
    }

    const googleClientId = (input.NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID ?? "").trim();
    if (googleClientId.length === 0) {
        return {
            kind: "disabled",
            reason: "missing_google_client_id",
        };
    }

    return {
        kind: "enabled",
        config: {
            apiKey,
            googleClientId,
            network: "testnet",
        },
    };
}
