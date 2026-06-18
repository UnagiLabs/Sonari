"use client";

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
    const issueButtonLabel = isIssued ? t("issue.buttonIssued") : t("issue.button");
    const isPrimaryActionDisabled = actionState.disabled;

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

    function membershipStatusValue(): string {
        if (issuance === "issued") {
            return t("card.statusIssued");
        }
        if (issueState.kind === "submitting") {
            return t("card.statusSubmitting");
        }
        if (issuance === "checking") {
            return t("card.statusChecking");
        }
        if (lookup.kind === "multiple") {
            return t("card.statusMultiple");
        }
        if (
            selectedCellDecimal !== null &&
            owner.length > 0 &&
            isConfigured &&
            lookup.kind === "none"
        ) {
            return t("card.statusReady");
        }
        return t("card.statusValue");
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
                    <strong>
                        {owner.length > 0 ? shortAddress(owner) : t("card.ownerPlaceholder")}
                    </strong>
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
                        {issuance === "issued" ? (
                            <span className="tag tag-ok wizard-summary-tag">
                                {t("card.statusIssued")}
                            </span>
                        ) : null}
                    </strong>
                </div>
            </div>

            <div className="field-note" role="note">
                <strong>{t("issue.sponsorNoteTitle")}</strong>
                <small>{t("issue.sponsorNoteBody")}</small>
                <small>{t("issue.signatureNote")}</small>
            </div>

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
            {actionState.disabled ? (
                <p className="wizard-cta-hint" role="note">
                    {t(disabledReasonMessageKey(actionState.reason))}
                </p>
            ) : null}
        </section>
    );
}
