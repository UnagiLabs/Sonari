"use client";

import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { useTranslations } from "next-intl";
import { NetworkBadge } from "./network-badge";

// 共通の wallet 接続 UI。Wallet Standard の ConnectButton（web component）は
// 接続・切断・wallet 選択 modal を内蔵する。instance は provider の context から
// 自動解決されるため明示指定しない。
//
// このファイルは @mysten/dapp-kit-react/ui を import する。/ui は server で window へ
// 触れて throw するため、必ず dynamic(ssr:false) 経由（wallet-connect.tsx）で読み込む。
//
// デザイン「Header - Wallet Final」に合わせ、未接続ボタンはウォレットアイコン付きの
// アウトライン（白背景・緑枠・濃緑文字）にする。アイコンとラベルは ConnectButton の
// default slot（未接続時のみ表示）へ差し込む。配色・枠・形は globals.css 側で指定する。
// slot 内は light DOM なので currentColor はボタンの文字色（--primary-foreground）を継ぐ。
export function ConnectWalletButton() {
    const t = useTranslations("wallet");
    return (
        <span className="wallet-connect">
            <ConnectButton>
                <span className="wallet-connect-label">
                    <svg
                        aria-hidden="true"
                        className="wallet-connect-icon"
                        fill="none"
                        height="18"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.7"
                        viewBox="0 0 24 24"
                        width="18"
                    >
                        <path d="M3 8.5A2 2 0 0 1 5 6.5h12.5a1.5 1.5 0 0 1 1.5 1.5V9" />
                        <rect height="12" rx="2.5" width="18" x="3" y="7" />
                        <circle cx="16.5" cy="13" fill="currentColor" r="1.2" stroke="none" />
                    </svg>
                    {t("connect")}
                </span>
            </ConnectButton>
            <NetworkBadge />
        </span>
    );
}
