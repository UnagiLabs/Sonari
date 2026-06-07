"use client";

import { useCurrentNetwork, useWalletConnection } from "@mysten/dapp-kit-react";
import { toWalletStatusView } from "./wallet-view-model";

// 接続中の wallet について short address / network / wallet name を表示する。
// 表示の整形は wallet-view-model.ts の純粋関数に委ね、ここは hook の値を渡すだけにする。
export function WalletStatus() {
    const connection = useWalletConnection();
    const network = useCurrentNetwork();

    const view = toWalletStatusView({
        status: connection.status,
        address: connection.account?.address ?? null,
        walletName: connection.wallet?.name ?? null,
        network,
    });

    if (view.status !== "connected") {
        return null;
    }

    return (
        <span className="wallet-status" title={view.label}>
            {view.label}
        </span>
    );
}
