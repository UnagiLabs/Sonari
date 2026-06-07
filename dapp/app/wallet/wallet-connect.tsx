"use client";

import dynamic from "next/dynamic";

// 各ページが import する公開エントリ。
// ConnectWalletButton は @mysten/dapp-kit-react/ui（server 非対応の web component）を
// 含むため、dynamic(ssr:false) で client 専用に閉じる。
// loading は SSR の静的 HTML とチャンク読み込み中に表示する placeholder で、
// topbar / panel の既存レイアウトを崩さないための見た目を保つ。
export const WalletConnect = dynamic(
    () => import("./connect-wallet-button").then((mod) => mod.ConnectWalletButton),
    {
        ssr: false,
        loading: () => (
            <span className="wallet-connect-fallback" aria-hidden="true">
                <span className="wallet-dot" />
                Connect wallet
            </span>
        ),
    },
);
