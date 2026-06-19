"use client";

// Claude Design の "My Page" を取り込んだデザイン。発行済みの MembershipPass を
// パスポート風に見せる 2 カラム構成（モバイルは縦積み）。左カラムは縦型ソウルバウンド
// パス＋クイック状態＋救済 CTA、右カラムは居住地・本人確認・オンチェーン台帳の詳細。
// 見た目だけの変更で、SBT 照会・本人確認状況・各状態の出し分けなどの機能は従来の
// readMembershipPass / deriveMypageView / pass-view に委譲したまま不変。色・影・角丸・
// フォントはすべて既存のデザイントークンに揃える（membership ステップと同じ流儀）。

import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveMembershipDappGenesisObjects } from "../chain/genesis-objects";
import { createJsonRpcEventClient } from "../chain/json-rpc-event-client";
import { LoadingIndicator } from "../components/loading-indicator";
import type { SonariLocale } from "../register/wizard/locale";
import { shortAddress } from "../register/wizard/steps/membership-presence";
import { WalletConnect } from "../wallet/wallet-connect";
import { HomeCellMap } from "./home-cell-map";
import { fetchIdentityJobStatus } from "./identity-job-status";
import {
    type MembershipPassData,
    type MembershipPassReadResult,
    readMembershipPass,
} from "./membership-pass-read";
import {
    deriveMypageView,
    formatTimestamp,
    identityStatusLabelKey,
    providerLabelKeys,
    statusLabelKey,
} from "./pass-view";

// ---------------------------------------------------------------------------
// 装飾アイコン（すべて aria-hidden・色は CSS の currentColor／指定色に従う）。
// membership ステップと同じ六角形ロゴ／チェック／稲妻を共有の見た目で使う。
// ---------------------------------------------------------------------------

// パスのロゴ・透かしで使う六角形（アウトライン）。
function HexGlyph({ className }: { readonly className: string }) {
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
            <polygon
                fill="none"
                points="12,2 21,7 21,17 12,22 3,17 3,7"
                stroke="currentColor"
                strokeWidth="2"
            />
        </svg>
    );
}

// 本人確認済み・有効フラグのチェックマーク。
function CheckGlyph({ className }: { readonly className: string }) {
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
            <path
                d="M20 6 9 17l-5-5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3.2"
            />
        </svg>
    );
}

// 救済を受け取る導線（稲妻）。
function BoltGlyph({ className }: { readonly className: string }) {
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
            <path
                d="M13 2 4 14h6l-1 8 9-12h-6z"
                fill="none"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="1.8"
            />
        </svg>
    );
}

// 居住地（ピン）。
function PinGlyph({ className }: { readonly className: string }) {
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
            <path
                d="M12 21s7-5.2 7-11a7 7 0 0 0-14 0c0 5.8 7 11 7 11z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
            />
            <circle cx="12" cy="10" fill="none" r="2.4" stroke="currentColor" strokeWidth="1.7" />
        </svg>
    );
}

// 本人確認（人物）。
function PersonGlyph({ className }: { readonly className: string }) {
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
            <circle cx="12" cy="8.5" fill="none" r="3.4" stroke="currentColor" strokeWidth="1.7" />
            <path
                d="M5.5 19c1.2-3.2 3.7-4.6 6.5-4.6s5.3 1.4 6.5 4.6"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.7"
            />
        </svg>
    );
}

const membershipPackageId = process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID ?? "";
const identityStatusUrl = process.env.NEXT_PUBLIC_SONARI_IDENTITY_STATUS_URL ?? "";

type GenesisObjectsState =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "ok"; readonly identityRegistry: string }
    | { readonly kind: "error"; readonly message: string };

/**
 * デモ用 My Page が登録済み状態を固定で見せるための設定。
 * 本番は demo を渡さないため、チェーンから MembershipPass を読み取る。
 */
export interface MypageDemoConfig {
    readonly pass: MembershipPassData;
}

export function MypageView({
    locale,
    demo,
}: {
    readonly locale: SonariLocale;
    readonly demo?: MypageDemoConfig;
}) {
    const t = useTranslations("mypage");

    const account = useCurrentAccount();
    const client = useCurrentClient();
    const dAppKit = useDAppKit();
    const owner = account?.address ?? "";
    const connected = account !== null;

    const [result, setResult] = useState<MembershipPassReadResult | null>(null);
    const [genesisObjects, setGenesisObjects] = useState<GenesisObjectsState>({ kind: "idle" });
    // Cancels the most recent in-flight read so a slower earlier request (e.g.
    // from a rapid retry) can never overwrite a newer result.
    const cancelRef = useRef<() => void>(() => {});
    const identityRegistry = genesisObjects.kind === "ok" ? genesisObjects.identityRegistry : "";

    useEffect(() => {
        if (demo !== undefined || membershipPackageId.length === 0) {
            setGenesisObjects({ kind: "idle" });
            return;
        }
        let cancelled = false;
        setGenesisObjects({ kind: "loading" });
        resolveMembershipDappGenesisObjects(createJsonRpcEventClient(), {
            packageId: membershipPackageId,
        })
            .then((resolved) => {
                if (cancelled) {
                    return;
                }
                if (resolved.kind === "ok") {
                    setGenesisObjects({
                        kind: "ok",
                        identityRegistry: resolved.objects.identityRegistry,
                    });
                    return;
                }
                setGenesisObjects({ kind: "error", message: resolved.message });
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setGenesisObjects({
                        kind: "error",
                        message: error instanceof Error ? error.message : "",
                    });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [demo]);

    // Single read routine reused by the initial effect and the retry button,
    // so the linter sees no spurious dependency and retry needs no token state.
    const load = useCallback((): (() => void) => {
        cancelRef.current();

        // デモ表示では固定の登録済み状態を見せるため、チェーンを一切読まない。
        if (demo !== undefined) {
            return () => {};
        }

        if (!connected || owner.length === 0 || membershipPackageId.length === 0) {
            setResult(null);
            return () => {};
        }

        if (genesisObjects.kind === "loading" || genesisObjects.kind === "idle") {
            setResult(null);
            return () => {};
        }

        if (genesisObjects.kind === "error") {
            setResult({
                kind: "error",
                code: "read",
                message:
                    genesisObjects.message.length > 0
                        ? genesisObjects.message
                        : "Failed to resolve genesis objects.",
            });
            return () => {};
        }

        let cancelled = false;
        const cancel = () => {
            cancelled = true;
        };
        cancelRef.current = cancel;
        setResult(null);

        void readMembershipPass(client, owner, membershipPackageId, identityRegistry)
            .then(async (next): Promise<MembershipPassReadResult> => {
                if (next.kind !== "ok" || next.pass.identityVerified) {
                    return next;
                }
                const identityJobStatus = await fetchIdentityJobStatus({
                    endpointUrl: identityStatusUrl,
                    owner,
                    membershipId: next.pass.objectId,
                    signPersonalMessage: ({ message }) => dAppKit.signPersonalMessage({ message }),
                });
                return { kind: "ok", pass: { ...next.pass, identityJobStatus } };
            })
            .then((next) => {
                if (!cancelled) {
                    setResult(next);
                }
            });

        return cancel;
    }, [client, connected, dAppKit, owner, demo, genesisObjects, identityRegistry]);

    useEffect(() => load(), [load]);

    const retry = useCallback(() => {
        load();
    }, [load]);

    // デモ表示は固定の登録済み状態（ready）を直接使い、チェーン判定を通さない。
    const view =
        demo !== undefined
            ? { kind: "ready" as const, pass: demo.pass }
            : deriveMypageView({
                  connected,
                  owner,
                  result,
                  lookupEnabled: membershipPackageId.length > 0,
              });

    return (
        <div className="mypage">
            <section aria-labelledby="mypage-title" className="wizard-step-content">
                <header className="wizard-heading mypage-heading">
                    <p className="eyebrow">{t("eyebrow")}</p>
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

                {view.kind === "ready" && (
                    <PassDetails locale={locale} owner={owner} pass={view.pass} />
                )}
            </section>
        </div>
    );
}

function PassDetails({
    pass,
    locale,
    owner,
}: {
    readonly pass: MembershipPassData;
    readonly locale: SonariLocale;
    readonly owner: string;
}) {
    const t = useTranslations("mypage");

    const providerKeys = providerLabelKeys(pass.identityProviderMask);
    const providerText =
        providerKeys.length === 0
            ? t("providerLabels.none")
            : providerKeys.map((key) => t(`providerLabels.${key}`)).join(" + ");

    const date = (ms: number): string => formatTimestamp(ms, locale) ?? t("unset");

    // 表示状態の確定値（CSS のトーン分岐と表示ラベルにだけ使う純粋な導出）。
    const statusKey = statusLabelKey(pass.status);
    const statusLabel = t(`statusLabels.${statusKey}`);
    const isActive = statusKey === "active";
    const identityLabel = t(`identityStatusLabels.${identityStatusLabelKey(pass)}`);
    const isVerified = pass.identityVerified;
    const walletText = owner.length > 0 ? shortAddress(owner) : t("pass.walletPlaceholder");

    const statusPillClass = isActive
        ? "mypage-status-pill mypage-status-pill--active"
        : "mypage-status-pill";
    const identityPillClass = isVerified
        ? "mypage-identity-pill mypage-identity-pill--verified"
        : "mypage-identity-pill";
    const identityBadgeClass = isVerified ? "mypage-badge mypage-badge--verified" : "mypage-badge";
    const passStatusClass = isActive
        ? "mypage-pass-status mypage-pass-status--active"
        : "mypage-pass-status";

    return (
        <div className="mypage-passport">
            {/* 左カラム：パス＋クイック状態＋救済 CTA（デスクトップでは sticky） */}
            <aside className="mypage-aside">
                <div className="mypage-pass">
                    <HexGlyph className="mypage-pass-watermark mypage-pass-watermark--lg" />
                    <HexGlyph className="mypage-pass-watermark mypage-pass-watermark--sm" />

                    <div className="mypage-pass-head">
                        <span className="mypage-pass-brand">
                            <span className="mypage-pass-logo">
                                <HexGlyph className="mypage-pass-logo-glyph" />
                            </span>
                            Sonari
                        </span>
                        <span className={passStatusClass}>
                            <span className="mypage-status-dot" />
                            {statusLabel}
                        </span>
                    </div>

                    <div className="mypage-pass-title">
                        <span className="mypage-pass-kicker">{t("pass.kicker")}</span>
                        <span className="mypage-pass-name">{t("pass.name")}</span>
                        <span className="mypage-pass-subtitle">{t("pass.subtitle")}</span>
                    </div>

                    <dl className="mypage-pass-fields">
                        <div className="mypage-pass-field mypage-pass-field--wide">
                            <dt>{t("pass.residenceLabel")}</dt>
                            <dd className="mypage-mono">{pass.homeCell}</dd>
                        </div>
                        <div className="mypage-pass-field">
                            <dt>{t("pass.walletLabel")}</dt>
                            <dd className="mypage-mono">{walletText}</dd>
                        </div>
                        <div className="mypage-pass-field">
                            <dt>{t("pass.networkLabel")}</dt>
                            <dd className="mypage-mono">{t("pass.networkValue")}</dd>
                        </div>
                    </dl>
                </div>

                <div className="mypage-quickstatus">
                    <div className="mypage-quickstatus-row">
                        <span className="mypage-quickstatus-label">
                            {t("quick.passStateLabel")}
                        </span>
                        <span className={statusPillClass}>
                            <span className="mypage-status-dot" />
                            {statusLabel}
                        </span>
                    </div>
                    <div className="mypage-quickstatus-divider" />
                    <div className="mypage-quickstatus-row">
                        <span className="mypage-quickstatus-label">{t("quick.identityLabel")}</span>
                        <span className={identityPillClass}>
                            {isVerified ? <CheckGlyph className="mypage-pill-icon" /> : null}
                            {identityLabel}
                        </span>
                    </div>
                </div>

                <div className="mypage-relief">
                    <div className="mypage-relief-head">
                        <BoltGlyph className="mypage-relief-icon" />
                        <span className="mypage-relief-title">{t("claim.heading")}</span>
                    </div>
                    <p className="mypage-relief-body">{t("claim.body")}</p>
                    <a className="btn btn-primary" href="/claim">
                        {t("claim.cta")}
                    </a>
                </div>
            </aside>

            {/* 右カラム：居住地・本人確認・オンチェーン台帳の詳細 */}
            <div className="mypage-detail">
                <section className="mypage-card">
                    <header className="mypage-card-head">
                        <span className="mypage-card-heading">
                            <span className="mypage-card-icon">
                                <PinGlyph className="mypage-card-icon-glyph" />
                            </span>
                            <h2 className="mypage-card-title">{t("residence.heading")}</h2>
                        </span>
                    </header>
                    <div className="mypage-residence-body">
                        <dl className="mypage-facts">
                            <div className="mypage-fact">
                                <dt>{t("residence.cellLabel")}</dt>
                                <dd className="mypage-mono">{pass.homeCell}</dd>
                            </div>
                            <div className="mypage-fact">
                                <dt>{t("residence.registeredAtLabel")}</dt>
                                <dd>{date(pass.homeCellRegisteredAtMs)}</dd>
                            </div>
                        </dl>
                        <HomeCellMap cell={pass.homeCell} />
                    </div>
                </section>

                <section className="mypage-card">
                    <header className="mypage-card-head">
                        <span className="mypage-card-heading">
                            <span className="mypage-card-icon">
                                <PersonGlyph className="mypage-card-icon-glyph" />
                            </span>
                            <h2 className="mypage-card-title">{t("identity.heading")}</h2>
                        </span>
                        <span className={identityBadgeClass}>
                            {isVerified ? <CheckGlyph className="mypage-pill-icon" /> : null}
                            {identityLabel}
                        </span>
                    </header>
                    <dl className="mypage-card-grid">
                        <div className="mypage-fact">
                            <dt>{t("identity.providerLabel")}</dt>
                            <dd>{providerText}</dd>
                        </div>
                        <div className="mypage-fact">
                            <dt>{t("identity.verifiedAtLabel")}</dt>
                            <dd>{date(pass.identityVerifiedAtMs)}</dd>
                        </div>
                        <div className="mypage-fact">
                            <dt>{t("identity.expiresAtLabel")}</dt>
                            <dd>{date(pass.identityExpiresAtMs)}</dd>
                        </div>
                    </dl>
                </section>

                <section className="mypage-card">
                    <p className="mypage-card-eyebrow">{t("status.onchainEyebrow")}</p>
                    <div className="mypage-ledger-row">
                        <span>{t("status.stateLabel")}</span>
                        <span className={statusPillClass}>
                            <span className="mypage-status-dot" />
                            {statusLabel}
                        </span>
                    </div>
                    <div className="mypage-ledger-row">
                        <span>{t("status.issuedAtLabel")}</span>
                        <strong>{date(pass.issuedAtMs)}</strong>
                    </div>
                    <div className="mypage-ledger-row">
                        <span>{t("status.networkLabel")}</span>
                        <strong className="mypage-mono">{t("status.networkValue")}</strong>
                    </div>
                </section>
            </div>
        </div>
    );
}
