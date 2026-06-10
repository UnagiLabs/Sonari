"use client";

import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { dAppKit } from "../../../wallet/dapp-kit";
import {
    executeWalletTransaction,
    WalletTransactionError,
} from "../../../wallet/wallet-transaction-adapter";
import { lookupMembershipPass } from "../../identity/membership-lookup";
import { h3DecimalToHex } from "../../residence/h3-geo";
import {
    buildRegisterMemberTransaction,
    fetchResidenceProof,
    MEMBERSHIP_TERMS_VERSION,
    MembershipIssueError,
} from "./membership-issue";

interface MembershipStepProps {
    readonly accepted: readonly boolean[];
    readonly membershipIssued: boolean;
    readonly selectedCellDecimal: string | null;
    readonly onToggle: (index: number, checked: boolean) => void;
    readonly onIssued: () => void;
    readonly onBack: () => void;
    readonly onNext: () => void;
}

type MembershipLookupViewState =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "ok"; readonly membershipId: string }
    | { readonly kind: "none" }
    | { readonly kind: "multiple"; readonly count: number }
    | { readonly kind: "error"; readonly message: string };

type MembershipIssueViewState =
    | { readonly kind: "idle" }
    | { readonly kind: "submitting" }
    | { readonly kind: "failed"; readonly message: string };

const membershipPackageId = process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID ?? "";
const residenceProofWorkerUrl = process.env.NEXT_PUBLIC_SONARI_RESIDENCE_PROOF_WORKER_URL ?? "";
const pauseStateId = process.env.NEXT_PUBLIC_SONARI_IDENTITY_PAUSE_STATE_ID ?? "";
const membershipRegistryId = process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_REGISTRY_ID ?? "";
const allowedResidenceCellRegistryId =
    process.env.NEXT_PUBLIC_SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID ?? "";

export function MembershipStep({
    accepted,
    membershipIssued,
    selectedCellDecimal,
    onToggle,
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

    const allStatementsAccepted = accepted.length > 0 && accepted.every((value) => value);
    const isConfigured =
        membershipPackageId.length > 0 &&
        residenceProofWorkerUrl.length > 0 &&
        pauseStateId.length > 0 &&
        membershipRegistryId.length > 0 &&
        allowedResidenceCellRegistryId.length > 0;
    const isIssued = membershipIssued || lookup.kind === "ok";
    const issueButtonLabel = isIssued ? t("issue.buttonIssued") : t("issue.button");
    const isPrimaryActionDisabled =
        !allStatementsAccepted ||
        selectedCellDecimal === null ||
        owner.length === 0 ||
        issueState.kind === "submitting" ||
        (!isIssued && (!isConfigured || lookup.kind !== "none"));

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
        if (!allStatementsAccepted) {
            return;
        }
        if (selectedCellDecimal === null) {
            setIssueState({ kind: "failed", message: t("issue.residenceRequired") });
            return;
        }
        if (owner.length === 0) {
            setIssueState({ kind: "failed", message: t("issue.connectWallet") });
            return;
        }
        if (isIssued) {
            onIssued();
            onNext();
            return;
        }
        if (!isConfigured) {
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

        void runMembershipIssuance(owner, selectedCellDecimal);
    }

    async function runMembershipIssuance(senderAddress: string, homeCell: string) {
        setIssueState({ kind: "submitting" });

        try {
            const residenceProof = await fetchResidenceProof({
                workerUrl: residenceProofWorkerUrl,
                homeCell,
            });
            const { transaction } = buildRegisterMemberTransaction({
                senderAddress,
                packageId: membershipPackageId,
                objects: {
                    pauseState: pauseStateId,
                    membershipRegistry: membershipRegistryId,
                    allowedResidenceCellRegistry: allowedResidenceCellRegistryId,
                },
                homeCell,
                residenceProof,
                termsVersion: MEMBERSHIP_TERMS_VERSION,
            });
            await executeWalletTransaction(dAppKit, { transaction });
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
        if (error instanceof WalletTransactionError) {
            return error.message.length > 0 ? error.message : t("issue.transactionFailed");
        }
        return t("issue.transactionFailed");
    }

    function membershipStatusValue(): string {
        if (isIssued) {
            return t("card.statusIssued");
        }
        if (issueState.kind === "submitting") {
            return t("card.statusSubmitting");
        }
        if (lookup.kind === "loading") {
            return t("card.statusChecking");
        }
        if (lookup.kind === "multiple") {
            return t("card.statusMultiple");
        }
        if (
            allStatementsAccepted &&
            selectedCellDecimal !== null &&
            owner.length > 0 &&
            isConfigured &&
            lookup.kind === "none"
        ) {
            return t("card.statusReady");
        }
        return t("card.statusValue");
    }

    function membershipNotice(): { readonly message: string; readonly tone: "note" | "alert" } {
        if (issueState.kind === "failed") {
            return { message: issueState.message, tone: "alert" };
        }
        if (issueState.kind === "submitting") {
            return { message: t("issue.submitting"), tone: "note" };
        }
        if (owner.length === 0) {
            return { message: t("issue.connectWallet"), tone: "note" };
        }
        if (selectedCellDecimal === null) {
            return { message: t("issue.residenceRequired"), tone: "note" };
        }
        if (!allStatementsAccepted) {
            return { message: t("nextHint"), tone: "note" };
        }
        if (isIssued) {
            return { message: t("issue.alreadyIssued"), tone: "note" };
        }
        if (lookup.kind === "loading") {
            return { message: t("issue.checking"), tone: "note" };
        }
        if (lookup.kind === "multiple") {
            return { message: t("issue.multiple"), tone: "alert" };
        }
        if (lookup.kind === "error") {
            return { message: lookup.message, tone: "alert" };
        }
        if (!isConfigured) {
            return { message: t("issue.notConfigured"), tone: "alert" };
        }
        return { message: t("issue.ready"), tone: "note" };
    }

    const membershipNoticeState = membershipNotice();

    return (
        <section aria-labelledby="wizard-membership-title" className="wizard-step-content">
            <header className="wizard-heading">
                <div className="eyebrow">{t("eyebrow")}</div>
                <h1 className="wizard-title" id="wizard-membership-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            <div className="wizard-card wizard-sbt-card">
                <div className="wizard-sbt-row">
                    <span>{t("card.objectType")}</span>
                    <strong>{t("card.objectTypeValue")}</strong>
                </div>
                <div className="wizard-sbt-row">
                    <span>{t("card.owner")}</span>
                    <strong>{owner.length > 0 ? owner : t("card.ownerPlaceholder")}</strong>
                </div>
                <div className="wizard-sbt-row">
                    <span>{t("card.residence")}</span>
                    <strong className="mono-value">
                        {selectedCellDecimal === null
                            ? t("card.residencePlaceholder")
                            : h3DecimalToHex(selectedCellDecimal)}
                    </strong>
                </div>
                <div className="wizard-sbt-row">
                    <span>{t("card.transfer")}</span>
                    <strong>{t("card.transferValue")}</strong>
                </div>
                <div className="wizard-sbt-row">
                    <span>{t("card.status")}</span>
                    <strong>
                        {membershipStatusValue()}
                        {isIssued ? (
                            <span className="tag tag-ok wizard-summary-tag">
                                {t("card.statusIssued")}
                            </span>
                        ) : null}
                    </strong>
                </div>
            </div>

            <fieldset className="control-group">
                <legend>{t("statementsLegend")}</legend>
                <div className="terms-list">
                    {accepted.map((checked, index) => (
                        <label
                            className="terms-row"
                            // 固定長の承諾フラグ配列なので index キーで安定する。
                            // biome-ignore lint/suspicious/noArrayIndexKey: 配列は固定長・並べ替えなし
                            key={index}
                        >
                            <input
                                checked={checked}
                                name="membershipTerms"
                                onChange={(event) => onToggle(index, event.target.checked)}
                                type="checkbox"
                            />
                            <span>{t(`statements.${index}`)}</span>
                        </label>
                    ))}
                </div>
            </fieldset>

            <div
                className="field-note"
                role={membershipNoticeState.tone === "alert" ? "alert" : "note"}
            >
                <small>{membershipNoticeState.message}</small>
            </div>

            <div className="wizard-cta-bar">
                <button className="btn btn-ghost btn-lg" onClick={onBack} type="button">
                    {tCommon("back")}
                </button>
                <button
                    className="btn btn-primary btn-lg wizard-cta"
                    disabled={isPrimaryActionDisabled}
                    onClick={handlePrimaryAction}
                    type="button"
                >
                    {issueButtonLabel}
                </button>
            </div>
            {!allStatementsAccepted ? (
                <p className="wizard-cta-hint" role="note">
                    {t("nextHint")}
                </p>
            ) : null}
        </section>
    );
}
