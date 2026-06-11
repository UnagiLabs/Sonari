"use client";

import { useCurrentNetwork, useWalletConnection } from "@mysten/dapp-kit-react";
import { toWalletStatusView } from "./wallet-view-model";
import type { WalletStatusLabels } from "./wallet-view-model";

// TODO(STEP3): i18n 対応後、翻訳ラベルを渡す形に置き換える
const EN_LABELS: WalletStatusLabels = {
    disconnected: "Connect wallet",
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    connectedFallback: "Connected",
};

// 接続中の wallet について short address / network / wallet name を表示する。
// 表示の整形は wallet-view-model.ts の純粋関数に委ね、ここは hook の値を渡すだけにする。
export function WalletStatus() {
    const connection = useWalletConnection();
    const network = useCurrentNetwork();

    const view = toWalletStatusView(
        {
            status: connection.status,
            address: connection.account?.address ?? null,
            walletName: connection.wallet?.name ?? null,
            network,
        },
        EN_LABELS,
    );

    if (view.status !== "connected") {
        return null;
    }

    return (
        <span className="wallet-status" title={view.label}>
            {view.label}
        </span>
    );
}
