export type WalletNetwork = "testnet" | "localnet";

const ALLOWED_NETWORKS: readonly WalletNetwork[] = ["testnet", "localnet"] as const;

const DEFAULT_GRPC_URLS = {
    testnet: "https://fullnode.testnet.sui.io:443",
    localnet: "http://127.0.0.1:9000",
} as const;

export function isAllowedNetwork(value: string): value is WalletNetwork {
    return (ALLOWED_NETWORKS as readonly string[]).includes(value);
}

export function resolveNetwork(raw?: string | undefined): WalletNetwork {
    const trimmed = (raw ?? "").trim();
    if (isAllowedNetwork(trimmed)) {
        return trimmed;
    }
    return "testnet";
}

export function resolveGrpcBaseUrl(
    network: WalletNetwork,
    env?: { testnet?: string | undefined; localnet?: string | undefined },
): string {
    const override = env?.[network];
    if (override !== undefined && override.length > 0) {
        return override;
    }
    return DEFAULT_GRPC_URLS[network];
}

export function readWalletNetwork(
    raw: string | undefined = process.env.NEXT_PUBLIC_SUI_NETWORK,
): WalletNetwork {
    return resolveNetwork(raw);
}

export function readGrpcBaseUrl(network: WalletNetwork): string {
    return resolveGrpcBaseUrl(network, {
        testnet: process.env.NEXT_PUBLIC_SUI_GRPC_TESTNET_URL,
        localnet: process.env.NEXT_PUBLIC_SUI_GRPC_LOCALNET_URL,
    });
}
