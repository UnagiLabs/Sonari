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
        <section aria-labelledby="wizard-welcome-title" className="wizard-step-content">
            <header className="wizard-heading">
                <div className="eyebrow">{t("eyebrow")}</div>
                <h1 className="wizard-title" id="wizard-welcome-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            <div className="wizard-card wizard-wallet-card">
                <p className="muted">{t("walletHint")}</p>
                <WalletConnect />
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
                    className="btn btn-primary btn-lg wizard-cta"
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
