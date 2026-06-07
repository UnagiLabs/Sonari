export type WalletNetwork = "testnet" | "localnet";

const ALLOWED_NETWORKS: readonly WalletNetwork[] = ["testnet", "localnet"] as const;

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

// gRPC エンドポイントは env から読まず、network ごとにハードコードして分岐する。
export function resolveGrpcBaseUrl(network: WalletNetwork): string {
    switch (network) {
        case "testnet":
            return "https://fullnode.testnet.sui.io:443";
        case "localnet":
            return "http://127.0.0.1:9000";
    }
}

export function readWalletNetwork(
    raw: string | undefined = process.env.NEXT_PUBLIC_SUI_NETWORK,
): WalletNetwork {
    return resolveNetwork(raw);
}
