"use client";

import { useCurrentNetwork, useWalletConnection } from "@mysten/dapp-kit-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toWalletStatusView } from "./wallet-view-model";

// 接続中の wallet について short address / network / wallet name を表示する。
// 表示の整形は wallet-view-model.ts の純粋関数に委ね、ここは hook の値を渡すだけにする。
export function WalletStatus() {
    const connection = useWalletConnection();
    const network = useCurrentNetwork();
    const t = useTranslations("wallet");
    const [copied, setCopied] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
            }
        };
    }, []);

    const view = toWalletStatusView(
        {
            status: connection.status,
            address: connection.account?.address ?? null,
            walletName: connection.wallet?.name ?? null,
            network,
        },
        {
            disconnected: t("connect"),
            connecting: t("connecting"),
            reconnecting: t("reconnecting"),
            connectedFallback: t("connected"),
        },
    );

    if (view.status !== "connected") {
        return null;
    }

    const fullAddress = connection.account?.address ?? null;

    async function handleClick() {
        if (!fullAddress) return;
        try {
            await navigator.clipboard.writeText(fullAddress);
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
            }
            setCopied(true);
            timerRef.current = setTimeout(() => {
                setCopied(false);
                timerRef.current = null;
            }, 2000);
        } catch {
            // clipboard 非対応 / 権限拒否の場合は何もしない
        }
    }

    return (
        <button
            type="button"
            className="wallet-status"
            title={view.label}
            aria-label={t("copyAddressAria")}
            onClick={handleClick}
        >
            {copied ? t("copied") : view.label}
        </button>
    );
}
