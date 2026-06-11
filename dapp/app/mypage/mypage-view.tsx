"use client";

import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoadingIndicator } from "../components/loading-indicator";
import type { SonariLocale } from "../register/wizard/locale";
import { LocaleSwitcher } from "../register/wizard/locale-switcher";
import { NetworkMismatchBanner } from "../wallet/network-mismatch-banner";
import { WalletConnect } from "../wallet/wallet-connect";
import { HomeCellMap } from "./home-cell-map";
import {
    type MembershipPassData,
    type MembershipPassReadResult,
    readMembershipPass,
} from "./membership-pass-read";
import { deriveMypageView, formatTimestamp, providerLabelKeys, statusLabelKey } from "./pass-view";

const membershipPackageId = process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID ?? "";
const identityRegistryId = process.env.NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID ?? "";

export function MypageView({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("mypage");

    const account = useCurrentAccount();
    const client = useCurrentClient();
    const owner = account?.address ?? "";
    const connected = account !== null;

    const [result, setResult] = useState<MembershipPassReadResult | null>(null);
    // Cancels the most recent in-flight read so a slower earlier request (e.g.
    // from a rapid retry) can never overwrite a newer result.
    const cancelRef = useRef<() => void>(() => {});

    // Single read routine reused by the initial effect and the retry button,
    // so the linter sees no spurious dependency and retry needs no token state.
    const load = useCallback((): (() => void) => {
        cancelRef.current();

        if (!connected || owner.length === 0 || membershipPackageId.length === 0) {
            setResult(null);
            return () => {};
        }

        let cancelled = false;
        const cancel = () => {
            cancelled = true;
        };
        cancelRef.current = cancel;
        setResult(null);

        void readMembershipPass(client, owner, membershipPackageId, identityRegistryId).then(
            (next) => {
                if (!cancelled) {
                    setResult(next);
                }
            },
        );

        return cancel;
    }, [client, connected, owner]);

    useEffect(() => load(), [load]);

    const retry = useCallback(() => {
        load();
    }, [load]);

    const view = deriveMypageView({
        connected,
        owner,
        result,
        lookupEnabled: membershipPackageId.length > 0,
    });

    return (
        <div className="mypage">
            <header className="topbar">
                <div className="topbar-inner">
                    <a aria-label={t("topbar.brandHomeAria")} className="brand" href="/">
                        <span className="brand-mark">
                            <Image
                                alt="Sonari"
                                height={36}
                                priority
                                src="/assets/sonari_logo.png"
                                width={36}
                            />
                        </span>
                        <span className="brand-name">Sonari</span>
                    </a>
                    <nav aria-label="Primary" className="nav">
                        <a className="nav-item" href="/">
                            {t("topbar.home")}
                        </a>
                        <a className="nav-item" href="/register">
                            {t("topbar.register")}
                        </a>
                        <span className="nav-item active">{t("topbar.label")}</span>
                    </nav>
                    <div className="topbar-spacer" />
                    <LocaleSwitcher current={locale} />
                    <WalletConnect />
                </div>
            </header>
            <NetworkMismatchBanner />

            <section aria-labelledby="mypage-title" className="wizard-step-content">
                <header className="wizard-heading">
                    <h1 className="wizard-title" id="mypage-title">
                        {t("title")}
                    </h1>
                    <p className="wizard-lead">{t("subtitle")}</p>
                </header>

                {view.kind === "disconnected" && (
                    <div className="mypage-state">
                        <h2>{t("states.disconnectedTitle")}</h2>
                        <p>{t("states.disconnectedBody")}</p>
                        <WalletConnect />
                    </div>
                )}

                {view.kind === "unconfigured" && (
                    <div className="mypage-state">
                        <h2>{t("states.unconfiguredTitle")}</h2>
                        <p>{t("states.unconfiguredBody")}</p>
                    </div>
                )}

                {view.kind === "loading" && (
                    <div className="mypage-state">
                        <LoadingIndicator label={t("states.loadingBody")} />
                    </div>
                )}

                {view.kind === "not_registered" && (
                    <div className="mypage-state">
                        <h2>{t("states.notRegisteredTitle")}</h2>
                        <p>{t("states.notRegisteredBody")}</p>
                        <a className="btn btn-primary" href="/register">
                            {t("states.notRegisteredCta")}
                        </a>
                    </div>
                )}

                {view.kind === "error" && (
                    <div className="mypage-state" role="alert">
                        <h2>{t("states.errorTitle")}</h2>
                        <p>
                            {view.code === "multiple"
                                ? t("states.errorMultiple")
                                : t("states.errorBody")}
                        </p>
                        <button className="btn btn-primary" onClick={retry} type="button">
                            {t("states.errorRetry")}
                        </button>
                    </div>
                )}

                {view.kind === "ready" && <PassDetails locale={locale} pass={view.pass} />}
            </section>
        </div>
    );
}

function PassDetails({
    pass,
    locale,
}: {
    readonly pass: MembershipPassData;
    readonly locale: SonariLocale;
}) {
    const t = useTranslations("mypage");

    const providerKeys = providerLabelKeys(pass.identityProviderMask);
    const providerText =
        providerKeys.length === 0
            ? t("providerLabels.none")
            : providerKeys.map((key) => t(`providerLabels.${key}`)).join(" + ");

    const date = (ms: number): string => formatTimestamp(ms, locale) ?? t("unset");

    return (
        <div className="mypage-groups">
            <section className="mypage-group">
                <h2>{t("residence.heading")}</h2>
                <dl>
                    <dt>{t("residence.cellLabel")}</dt>
                    <dd>{pass.homeCell}</dd>
                    <dt>{t("residence.registeredAtLabel")}</dt>
                    <dd>{date(pass.homeCellRegisteredAtMs)}</dd>
                </dl>
                <HomeCellMap cell={pass.homeCell} />
            </section>

            <section className="mypage-group">
                <h2>{t("identity.heading")}</h2>
                <dl>
                    <dt>{t("identity.verifiedLabel")}</dt>
                    <dd>
                        {pass.identityVerified
                            ? t("identity.verifiedYes")
                            : t("identity.verifiedNo")}
                    </dd>
                    <dt>{t("identity.providerLabel")}</dt>
                    <dd>{providerText}</dd>
                    <dt>{t("identity.verifiedAtLabel")}</dt>
                    <dd>{date(pass.identityVerifiedAtMs)}</dd>
                    <dt>{t("identity.expiresAtLabel")}</dt>
                    <dd>{date(pass.identityExpiresAtMs)}</dd>
                </dl>
            </section>

            <section className="mypage-group">
                <h2>{t("status.heading")}</h2>
                <dl>
                    <dt>{t("status.stateLabel")}</dt>
                    <dd>{t(`statusLabels.${statusLabelKey(pass.status)}`)}</dd>
                    <dt>{t("status.issuedAtLabel")}</dt>
                    <dd>{date(pass.issuedAtMs)}</dd>
                </dl>
            </section>
        </div>
    );
}
