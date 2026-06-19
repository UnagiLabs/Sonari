"use client";

import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { WalletConnect } from "../../../wallet/wallet-connect";
import type { MembershipLookupResult } from "../../identity/membership-lookup";
import { lookupMembershipPass } from "../../identity/membership-lookup";
import { deriveMembershipPresenceView, type MembershipPresenceView } from "./membership-presence";

const membershipPackageId = process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID ?? "";

// Welcome ステップの「これから辿る道のり」プレビュー。番号付きの 3 行で
// 居住エリア選択 → Membership SBT 発行 → 本人確認（任意）の流れを示す。
const PATH_ITEMS = [
    { key: "residence", hasNote: true },
    { key: "membership", hasNote: true },
    { key: "identity", hasNote: false },
] as const;

// gas-free バッジと sponsor note で使う六角形アイコン。色は currentColor に従い、
// 大きさは配置先の CSS（svg セレクタ）で制御する。
function HexIcon() {
    return (
        <svg aria-hidden="true" className="wizard-hex-icon" viewBox="0 0 24 24">
            <polygon
                fill="none"
                points="12,3 20,7.5 20,16.5 12,21 4,16.5 4,7.5"
                stroke="currentColor"
                strokeWidth="2"
            />
        </svg>
    );
}

export function WelcomeStep({ onNext }: { readonly onNext: () => void }) {
    const t = useTranslations("register.wizard.welcome");

    const account = useCurrentAccount();
    const client = useCurrentClient();
    const owner = account?.address ?? "";
    const connected = account !== null;

    const [lookupResult, setLookupResult] = useState<MembershipLookupResult | null>(null);

    useEffect(() => {
        if (!connected || owner.length === 0) {
            setLookupResult(null);
            return;
        }

        if (membershipPackageId.length === 0) {
            // パッケージ ID が未設定の場合は照会しない（エラーも出さない）
            setLookupResult(null);
            return;
        }

        let cancelled = false;
        setLookupResult(null);

        void lookupMembershipPass(client, owner, membershipPackageId).then((result) => {
            if (cancelled) {
                return;
            }
            setLookupResult(result);
        });

        return () => {
            cancelled = true;
        };
    }, [client, connected, owner]);

    const presenceView: MembershipPresenceView = deriveMembershipPresenceView({
        connected,
        owner,
        lookupResult,
        lookupEnabled: membershipPackageId.length > 0,
    });

    return (
        <section
            aria-labelledby="wizard-welcome-title"
            className="wizard-step-content wizard-welcome"
        >
            <header className="wizard-heading wizard-welcome-heading">
                <p className="eyebrow">{t("eyebrow")}</p>
                <h1 className="wizard-title" id="wizard-welcome-title">
                    {t("title")}
                </h1>
            </header>

            <ol className="wizard-path">
                {PATH_ITEMS.map((item, index) => (
                    <li className="wizard-path-item" key={item.key}>
                        <span aria-hidden="true" className="wizard-path-number">
                            {index + 1}
                        </span>
                        <p className="wizard-path-title">
                            {t(`path.${item.key}.title`)}
                            {item.key === "identity" ? (
                                <span className="wizard-path-optional">
                                    · {t("path.identity.optional")}
                                </span>
                            ) : null}
                        </p>
                        {item.hasNote ? (
                            <span className="wizard-path-note">{t(`path.${item.key}.note`)}</span>
                        ) : null}
                    </li>
                ))}
            </ol>

            <div className="wizard-card wizard-connect-card">
                <div className="wizard-connect-head">
                    <span className="wizard-connect-title">{t("walletHint")}</span>
                    <span className="wizard-gasfree-badge">
                        <HexIcon />
                        {t("gasFree")}
                    </span>
                </div>
                <WalletConnect />
                <p className="wizard-sponsor-note">
                    <HexIcon />
                    <span>{t("walletSponsorNote")}</span>
                </p>
            </div>

            {presenceView.kind === "checking" ? (
                <div className="field-note" role="note">
                    <small>{t("membership.checking")}</small>
                </div>
            ) : null}

            {presenceView.kind === "registered" ? (
                <div className="wizard-card wizard-membership-notice">
                    <p className="wizard-membership-notice-title">
                        {t("membership.registeredTitle")}
                    </p>
                    <p className="muted">
                        {t("membership.registeredBody", { ownerShort: presenceView.ownerShort })}
                    </p>
                    <div className="wizard-cta-bar">
                        <Link className="btn btn-primary btn-lg" href="/dashboard">
                            {t("membership.dashboardCta")}
                        </Link>
                    </div>
                </div>
            ) : null}

            {presenceView.kind === "error" ? (
                <div className="field-note" role="note">
                    <small>{t("membership.errorNote")}</small>
                </div>
            ) : null}

            <div className="wizard-cta-bar">
                <button
                    className="btn btn-primary btn-lg wizard-cta wizard-welcome-cta"
                    disabled={!connected}
                    onClick={onNext}
                    type="button"
                >
                    {t("cta")}
                </button>
            </div>
        </section>
    );
}
