"use client";

import { useCurrentNetwork, useWalletConnection } from "@mysten/dapp-kit-react";
import { shouldShowTestnetBadge } from "./wallet-network";

export function NetworkBadge() {
    const connection = useWalletConnection();
    const network = useCurrentNetwork();

    if (!shouldShowTestnetBadge(connection.status, network)) {
        return null;
    }

    return <span className="wallet-network-badge">testnet</span>;
}
