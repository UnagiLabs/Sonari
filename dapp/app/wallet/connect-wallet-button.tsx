"use client";

import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { WalletStatus } from "./wallet-status";

// 共通の wallet 接続 UI。Wallet Standard の ConnectButton（web component）は
// 接続・切断・wallet 選択 modal を内蔵する。instance は provider の context から
// 自動解決されるため明示指定しない。
//
// このファイルは @mysten/dapp-kit-react/ui を import する。/ui は server で window へ
// 触れて throw するため、必ず dynamic(ssr:false) 経由（wallet-connect.tsx）で読み込む。
export function ConnectWalletButton() {
    return (
        <span className="wallet-connect">
            <WalletStatus />
            <ConnectButton />
        </span>
    );
}
