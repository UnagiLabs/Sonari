"use client";

import { DAppKitProvider } from "@mysten/dapp-kit-react";
import type { ReactNode } from "react";
import { dAppKit } from "./dapp-kit";

// dApp Kit の context を全ページへ供給する provider。
// createDAppKit は server でも安全に動く（wallet 検出は client の effect で行われる）ため、
// この provider 自体は SSR 可能で children をそのまま server render できる。
// 一方 ConnectButton など Wallet Standard の web component は server で window に触れるため、
// それらは connect-wallet-button 側で dynamic(ssr:false) に閉じる。
export function WalletProvider({ children }: { children: ReactNode }) {
    return <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>;
}
