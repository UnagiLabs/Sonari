"use client";

// Claude Design の "Membership Step" を取り込んだデザイン。発行されるソウルバウンド
// パス（グラデーションのビジュアル）と、メンバーシップ特典・オンチェーン記録の台帳を
// 並べる 2 カラム構成（モバイルは縦積み）。見た目だけの変更で、SBT 照会・発行・ゲート
// 判定・段階別エラー・遷移などの機能は従来どおり membership-gate / membership-issue に
// 委譲したまま不変。色・影・角丸・フォントはすべて既存のデザイントークンに揃える。

import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
    type MembershipDappGenesisObjects,
    resolveMembershipDappGenesisObjects,
} from "../../../chain/genesis-objects";
import { createJsonRpcEventClient } from "../../../chain/json-rpc-event-client";
import { LoadingIndicator } from "../../../components/loading-indicator";
import { dAppKit } from "../../../wallet/dapp-kit";
import {
    executeSponsoredMembershipTransaction,
    SponsoredMembershipTransactionError,
} from "../../../wallet/sponsored-membership-transaction";
import { lookupMembershipPass } from "../../identity/membership-lookup";
import { h3DecimalToHex } from "../../residence/h3-geo";
import { MEMBERSHIP_TERMS_VERSION } from "../../terms-version";
import {
    deriveIssuanceStatus,
    deriveMembershipActionState,
    disabledReasonMessageKey,
    type MembershipLookupViewState,
} from "./membership-gate";
import { issueMembershipPass, MembershipIssueError } from "./membership-issue";
import {
    type MembershipIssueViewState,
    membershipIssueFailureMessageKey,
    membershipSubmittingMessageKey,
} from "./membership-issue-state";
import { shortAddress } from "./membership-presence";

interface MembershipStepProps {
    readonly membershipIssued: boolean;
    readonly selectedCellDecimal: string | null;
    readonly onIssued: () => void;
    readonly onBack: () => void;
    readonly onNext: () => void;
}

const membershipPackageId = process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID ?? "";
const residenceProofWorkerUrl = process.env.NEXT_PUBLIC_SONARI_RESIDENCE_PROOF_WORKER_URL ?? "";

type GenesisObjectsViewState =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "ok"; readonly objects: MembershipDappGenesisObjects }
    | { readonly kind: "error"; readonly message: string };

// ---------------------------------------------------------------------------
// 装飾アイコン（すべて aria-hidden・色は CSS の currentColor／指定色に従う）
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

// 発行済みバッジ／確定フラグのチェックマーク。
function CheckGlyph({ className }: { readonly className: string }) {
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
            <path
                d="M20 6 9 17l-5-5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3.4"
            />
        </svg>
    );
}

// 譲渡不可（鍵）アイコン。SBT バッジ・プライバシーノートで使う。
function LockGlyph({ className }: { readonly className: string }) {
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
            <rect
                fill="none"
                height="9"
                rx="2"
                stroke="currentColor"
                strokeWidth="2"
                width="14"
                x="5"
                y="11"
            />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
    );
}

// Relief Cash 対象資格（六角形＋チェック）。
function ReliefGlyph() {
    return (
        <svg aria-hidden="true" className="membership-benefit-glyph" viewBox="0 0 24 24">
            <polygon
                fill="none"
                points="12,2.5 20,7 20,17 12,21.5 4,17 4,7"
                stroke="currentColor"
                strokeWidth="1.7"
            />
            <path
                d="M9 12l2 2 4-4.5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.7"
            />
        </svg>
    );
}

// ソウルバウンドパス 1 つ（人物）。
function PersonGlyph() {
    return (
        <svg aria-hidden="true" className="membership-benefit-glyph" viewBox="0 0 24 24">
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

// 発行は無料／ガス代不要（稲妻）。
function BoltGlyph({ className }: { readonly className: string }) {
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
            <path
                d="M13 2 4 14h6l-1 8 9-12h-6z"
                fill="none"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="1.7"
            />
        </svg>
    );
}

export function MembershipStep({
    membershipIssued,
    selectedCellDecimal,
    onIssued,
    onBack,
    onNext,
}: MembershipStepProps) {
    const t = useTranslations("register.wizard.membership");
    const tCommon = useTranslations("register.wizard.common");

    const account = useCurrentAccount();
    const client = useCurrentClient();
    const owner = account?.address ?? "";

    const [lookup, setLookup] = useState<MembershipLookupViewState>({ kind: "idle" });
    const [issueState, setIssueState] = useState<MembershipIssueViewState>({ kind: "idle" });
    const [genesisObjects, setGenesisObjects] = useState<GenesisObjectsViewState>({
        kind: "idle",
    });

    const isConfigured =
        membershipPackageId.length > 0 &&
        residenceProofWorkerUrl.length > 0 &&
        genesisObjects.kind === "ok";

    const gateInput = {
        owner,
        selectedCellDecimal,
        isConfigured,
        membershipIssued,
        lookup,
        isSubmitting: issueState.kind === "submitting",
    } as const;

    const issuance = deriveIssuanceStatus(gateInput);
    const actionState = deriveMembershipActionState(gateInput);
    const isIssued = issuance === "issued";
    const isPrimaryActionDisabled = actionState.disabled;

    // パス／台帳に表示する確定値。未接続・未選択時はプレースホルダへフォールバックする。
    const residenceValue =
        selectedCellDecimal === null
            ? t("pass.residencePlaceholder")
            : h3DecimalToHex(selectedCellDecimal);
    const walletValue = owner.length > 0 ? shortAddress(owner) : t("pass.walletPlaceholder");

    useEffect(() => {
        if (membershipPackageId.length === 0) {
            setGenesisObjects({ kind: "error", message: t("issue.notConfigured") });
            return;
        }

        let cancelled = false;
        setGenesisObjects({ kind: "loading" });

        void resolveMembershipDappGenesisObjects(createJsonRpcEventClient(), {
            packageId: membershipPackageId,
        }).then((result) => {
            if (cancelled) {
                return;
            }
            if (result.kind === "ok") {
                setGenesisObjects({ kind: "ok", objects: result.objects });
                return;
            }
            setGenesisObjects({ kind: "error", message: t("issue.notConfigured") });
        });

        return () => {
            cancelled = true;
        };
    }, [t]);

    useEffect(() => {
        if (owner.length === 0) {
            setLookup({ kind: "idle" });
            setIssueState({ kind: "idle" });
            return;
        }

        if (membershipPackageId.length === 0) {
            setLookup({ kind: "error", message: t("issue.notConfigured") });
            setIssueState({ kind: "idle" });
            return;
        }

        let cancelled = false;
        setLookup({ kind: "loading" });
        setIssueState({ kind: "idle" });

        void lookupMembershipPass(client, owner, membershipPackageId).then((result) => {
            if (cancelled) {
                return;
            }

            switch (result.kind) {
                case "ok":
                    setLookup({ kind: "ok", membershipId: result.membershipId });
                    onIssued();
                    break;
                case "none":
                    setLookup({ kind: "none" });
                    break;
                case "multiple":
                    setLookup({ kind: "multiple", count: result.count });
                    break;
                case "error":
                    setLookup({ kind: "error", message: t("issue.lookupFailed") });
                    break;
            }
        });

        return () => {
            cancelled = true;
        };
    }, [client, onIssued, owner, t]);

    function handlePrimaryAction() {
        if (selectedCellDecimal === null) {
            setIssueState({ kind: "failed", message: t("issue.residenceRequired") });
            return;
        }
        if (owner.length === 0) {
            setIssueState({ kind: "failed", message: t("issue.connectWallet") });
            return;
        }
        if (issuance === "issued") {
            onIssued();
            onNext();
            return;
        }
        if (!isConfigured || genesisObjects.kind !== "ok") {
            setIssueState({ kind: "failed", message: t("issue.notConfigured") });
            return;
        }
        if (lookup.kind === "loading") {
            return;
        }
        if (lookup.kind === "multiple") {
            setIssueState({ kind: "failed", message: t("issue.multiple") });
            return;
        }
        if (lookup.kind === "error") {
            setIssueState({ kind: "failed", message: lookup.message });
            return;
        }
        if (lookup.kind !== "none") {
            setIssueState({ kind: "failed", message: t("issue.lookupFailed") });
            return;
        }

        void runMembershipIssuance(owner, selectedCellDecimal, genesisObjects.objects);
    }

    async function runMembershipIssuance(
        senderAddress: string,
        homeCell: string,
        objects: MembershipDappGenesisObjects,
    ) {
        setIssueState({ kind: "submitting", phase: "prepare" });

        try {
            await issueMembershipPass({
                client,
                senderAddress,
                homeCell,
                residenceProofWorkerUrl,
                packageId: membershipPackageId,
                objects: {
                    pauseState: objects.pauseState,
                    membershipRegistry: objects.membershipRegistry,
                    cellCountIndex: objects.cellCountIndex,
                    allowedResidenceCellRegistry: objects.allowedResidenceCellRegistry,
                },
                termsVersion: MEMBERSHIP_TERMS_VERSION,
                sponsoredExecutor: (input) =>
                    executeSponsoredMembershipTransaction({
                        client: input.client,
                        transaction: input.transaction,
                        sender: input.sender,
                        signer: dAppKit,
                        onStageChange: (stage) =>
                            setIssueState({ kind: "submitting", phase: stage }),
                    }),
            });
            onIssued();
            setIssueState({ kind: "idle" });
            onNext();
        } catch (error) {
            setIssueState({
                kind: "failed",
                message: membershipIssueErrorMessage(error),
            });
        }
    }

    function membershipIssueErrorMessage(error: unknown): string {
        if (error instanceof MembershipIssueError) {
            switch (error.code) {
                case "worker_url_missing":
                    return t("issue.proofWorkerMissing");
                case "proof_fetch_failed":
                    return t("issue.proofFetchFailed");
                case "invalid_proof_response":
                    return t("issue.invalidProofResponse");
                case "residence_cell_not_allowed":
                    return t("issue.residenceNotAllowed");
            }
        }
        if (error instanceof SponsoredMembershipTransactionError) {
            return t(membershipIssueFailureMessageKey(error.stage), {
                reason: error.message.length > 0 ? error.message : t("issue.transactionFailed"),
            });
        }
        return t("issue.transactionFailed");
    }

    function membershipNotice(): {
        readonly message: string;
        readonly tone: "note" | "alert";
        readonly loading?: boolean;
    } {
        if (issueState.kind === "failed") {
            return { message: issueState.message, tone: "alert" };
        }
        if (issueState.kind === "submitting") {
            return {
                message: t(membershipSubmittingMessageKey(issueState.phase)),
                tone: "note",
                loading: true,
            };
        }
        if (owner.length === 0) {
            return { message: t("issue.connectWallet"), tone: "note" };
        }
        if (selectedCellDecimal === null) {
            return { message: t("issue.residenceRequired"), tone: "note" };
        }
        if (issuance === "issued") {
            return { message: t("issue.alreadyIssued"), tone: "note" };
        }
        if (lookup.kind === "loading") {
            return { message: t("issue.checking"), tone: "note", loading: true };
        }
        if (lookup.kind === "multiple") {
            return { message: t("issue.multiple"), tone: "alert" };
        }
        if (lookup.kind === "error") {
            return { message: lookup.message, tone: "alert" };
        }
        if (genesisObjects.kind === "loading") {
            return { message: t("issue.checking"), tone: "note", loading: true };
        }
        if (!isConfigured) {
            return { message: t("issue.notConfigured"), tone: "alert" };
        }
        return { message: t("issue.ready"), tone: "note" };
    }

    const membershipNoticeState = membershipNotice();
    // 発行済みかつ通常ノートのときは、CTA の「発行済み」フラグと重複するため抑制する。
    // エラー（alert）や送信中は常に表示してフィードバックを保つ。
    const showNotice = !(isIssued && membershipNoticeState.tone === "note");

    return (
        <section
            aria-labelledby="wizard-membership-title"
            className="wizard-step-content wizard-step-content--membership wizard-membership"
        >
            <header className="wizard-heading wizard-membership-heading">
                <p className="eyebrow">{t("eyebrow")}</p>
                <h1 className="wizard-title" id="wizard-membership-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            <div className="membership-grid">
                {/* 発行されるソウルバウンドパス（ビジュアル） */}
                <div className="membership-pass">
                    <HexGlyph className="membership-pass-watermark membership-pass-watermark--lg" />
                    <HexGlyph className="membership-pass-watermark membership-pass-watermark--sm" />

                    <div className="membership-pass-head">
                        <span className="membership-pass-brand">
                            <span className="membership-pass-logo">
                                <HexGlyph className="membership-pass-logo-glyph" />
                            </span>
                            Sonari
                        </span>
                        <span className="membership-pass-badges">
                            {isIssued ? (
                                <span className="membership-pass-badge membership-pass-badge--issued">
                                    <CheckGlyph className="membership-pass-badge-icon" />
                                    {t("pass.issuedBadge")}
                                </span>
                            ) : null}
                            <span className="membership-pass-badge membership-pass-badge--sbt">
                                <LockGlyph className="membership-pass-badge-icon" />
                                {t("pass.sbtBadge")}
                            </span>
                        </span>
                    </div>

                    <div className="membership-pass-title">
                        <span className="membership-pass-kicker">{t("pass.kicker")}</span>
                        <span className="membership-pass-name">{t("pass.name")}</span>
                        <span className="membership-pass-subtitle">{t("pass.subtitle")}</span>
                    </div>

                    <dl className="membership-pass-fields">
                        <div className="membership-pass-field membership-pass-field--wide">
                            <dt>{t("pass.residenceLabel")}</dt>
                            <dd className="mono-value">{residenceValue}</dd>
                        </div>
                        <div className="membership-pass-field">
                            <dt>{t("pass.walletLabel")}</dt>
                            <dd className="mono-value">{walletValue}</dd>
                        </div>
                        <div className="membership-pass-field">
                            <dt>{t("pass.networkLabel")}</dt>
                            <dd className="mono-value">{t("pass.networkValue")}</dd>
                        </div>
                    </dl>
                </div>

                {/* 特典 ＋ オンチェーン記録の台帳 ＋ プライバシーノート */}
                <div className="membership-ledger">
                    <div className="membership-benefits">
                        <p className="membership-subhead">{t("benefits.label")}</p>
                        <ul className="membership-benefit-list">
                            <li className="membership-benefit">
                                <span className="membership-benefit-icon">
                                    <ReliefGlyph />
                                </span>
                                <span>
                                    <strong>{t("benefits.relief.title")}</strong>
                                    <small>{t("benefits.relief.body")}</small>
                                </span>
                            </li>
                            <li className="membership-benefit">
                                <span className="membership-benefit-icon">
                                    <PersonGlyph />
                                </span>
                                <span>
                                    <strong>{t("benefits.pass.title")}</strong>
                                    <small>{t("benefits.pass.body")}</small>
                                </span>
                            </li>
                            <li className="membership-benefit">
                                <span className="membership-benefit-icon">
                                    <BoltGlyph className="membership-benefit-glyph" />
                                </span>
                                <span>
                                    <strong>{t("benefits.free.title")}</strong>
                                    <small>{t("benefits.free.body")}</small>
                                </span>
                            </li>
                        </ul>
                    </div>

                    <div className="membership-onchain">
                        <p className="membership-onchain-head">{t("onchain.label")}</p>
                        <div className="membership-onchain-row">
                            <span>{t("onchain.type")}</span>
                            <strong>{t("onchain.typeValue")}</strong>
                        </div>
                        <div className="membership-onchain-row">
                            <span>{t("onchain.residence")}</span>
                            <strong className="mono-value">{residenceValue}</strong>
                        </div>
                        <div className="membership-onchain-row">
                            <span>{t("onchain.network")}</span>
                            <strong>{t("onchain.networkValue")}</strong>
                        </div>
                        <div className="membership-onchain-row">
                            <span>{t("onchain.cost")}</span>
                            <strong className="membership-onchain-cost">
                                {t("onchain.costValue")}
                            </strong>
                        </div>
                    </div>

                    <p className="membership-privacy">
                        <LockGlyph className="membership-privacy-icon" />
                        <span>{t("privacy")}</span>
                    </p>
                </div>
            </div>

            {showNotice ? (
                <div
                    className="field-note"
                    role={membershipNoticeState.tone === "alert" ? "alert" : "note"}
                >
                    {membershipNoticeState.loading ? (
                        <LoadingIndicator label={membershipNoticeState.message} />
                    ) : (
                        <small>{membershipNoticeState.message}</small>
                    )}
                </div>
            ) : null}

            {isIssued ? (
                <div className="wizard-cta-bar membership-cta">
                    <span className="membership-issued-flag">
                        <span className="membership-issued-check">
                            <CheckGlyph className="membership-issued-check-icon" />
                        </span>
                        {t("issuedFlag")}
                    </span>
                    <button
                        className="btn btn-primary btn-lg wizard-cta"
                        onClick={handlePrimaryAction}
                        type="button"
                    >
                        {t("issue.buttonIssued")}
                    </button>
                </div>
            ) : (
                <>
                    <div className="wizard-cta-bar membership-cta">
                        <span className="membership-gasfree-hint">
                            <BoltGlyph className="membership-gasfree-icon" />
                            {t("gasFreeHint")}
                        </span>
                        <button className="btn btn-ghost btn-lg" onClick={onBack} type="button">
                            {tCommon("back")}
                        </button>
                        <button
                            className="btn btn-primary btn-lg wizard-cta"
                            disabled={isPrimaryActionDisabled}
                            onClick={handlePrimaryAction}
                            type="button"
                        >
                            {t("issue.button")}
                        </button>
                    </div>
                    {actionState.disabled ? (
                        <p className="wizard-cta-hint" role="note">
                            {t(disabledReasonMessageKey(actionState.reason))}
                        </p>
                    ) : null}
                </>
            )}
        </section>
    );
}
