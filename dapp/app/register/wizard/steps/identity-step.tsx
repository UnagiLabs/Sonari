"use client";

// 旧 /register/identity ページからの移植。lookup / submit / statements の
// state machine と World ID / KYC の動作ロジックは変えず、ウィザードの
// 1ステップとして表示と文言（i18n）のみ再構成している。

import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { computeIdentityStatementHash } from "@sonari/proof-core";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useState } from "react";
import { resolveMembershipDappGenesisObjects } from "../../../chain/genesis-objects";
import { createJsonRpcEventClient } from "../../../chain/json-rpc-event-client";
import {
    lookupMembershipPass,
    type MembershipLookupResult,
} from "../../identity/membership-lookup";
import {
    areIdentityStatementsAccepted,
    buildIdentitySubmitRequest,
    type IdentityProvider,
} from "../../identity/request";
import { MEMBERSHIP_TERMS_VERSION } from "../../terms-version";
import { shortAddress } from "./membership-presence";

const WorldIdVerifyButton = dynamic(
    () => import("../../identity/world-id-verify-button").then((m) => m.WorldIdVerifyButton),
    { ssr: false },
);

const submitUrl = process.env.NEXT_PUBLIC_SONARI_IDENTITY_SUBMIT_URL ?? "";
const membershipPackageId = process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID ?? "";

// Fixed terms version for the duplicate-account statement. The statement is no
// longer hand-entered; the dapp derives a deterministic signed_statement_hash
// from this version (see computeIdentityStatementHash). The enclave only feeds
// this value into the World ID signal_hash binding, so a fixed value is safe.
// The version must match the one the MembershipPass was minted with, so it is
// shared with the membership step via terms-version.ts.
const signedStatementHash = computeIdentityStatementHash(MEMBERSHIP_TERMS_VERSION);

const IDENTITY_STATEMENT_COUNT = 3;
const identityProviderIds: readonly IdentityProvider[] = ["kyc", "world_id"];

type SubmitState =
    | { readonly status: "idle" }
    | { readonly status: "submitting"; readonly message: string }
    | {
          readonly status: "success";
          readonly message: string;
          readonly jobId: string;
          readonly jobStatus: string;
      }
    | { readonly status: "failed"; readonly message: string };

// On-chain MembershipPass lookup state, including the pre-network "idle" and
// in-flight "loading" phases on top of the lookup's own discriminated result.
type MembershipLookupState =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | MembershipLookupResult;

type GenesisObjectsState =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "ok"; readonly identityRegistry: string }
    | { readonly kind: "error"; readonly message: string };

interface IdentityStepProps {
    readonly provider: IdentityProvider;
    readonly identityVerified: boolean;
    readonly onProviderChange: (provider: IdentityProvider) => void;
    readonly onVerified: () => void;
    readonly onBack: () => void;
    readonly onFinish: () => void;
}

export function IdentityStep({
    provider,
    identityVerified,
    onProviderChange,
    onVerified,
    onBack,
    onFinish,
}: IdentityStepProps) {
    const t = useTranslations("register.wizard.identity");
    const tCommon = useTranslations("register.wizard.common");

    const [submitState, setSubmitState] = useState<SubmitState>({ status: "idle" });
    const [worldIdResponse, setWorldIdResponse] = useState<Record<string, unknown> | null>(null);
    const [lookup, setLookup] = useState<MembershipLookupState>({ kind: "idle" });
    const [genesisObjects, setGenesisObjects] = useState<GenesisObjectsState>({ kind: "idle" });
    // One acceptance flag per duplicate-account statement. The member must affirm
    // every statement before any identity action (World ID verify / KYC submit) is
    // enabled, so verification is always preceded by the statement.
    const [acceptedStatements, setAcceptedStatements] = useState<readonly boolean[]>(() =>
        Array.from({ length: IDENTITY_STATEMENT_COUNT }, () => false),
    );

    const account = useCurrentAccount();
    const client = useCurrentClient();
    const owner = account?.address ?? "";
    const membershipId = lookup.kind === "ok" ? lookup.membershipId : "";
    const identityRegistry = genesisObjects.kind === "ok" ? genesisObjects.identityRegistry : "";
    const isSubmitConfigured = submitUrl.length > 0 && identityRegistry.length > 0;
    // owner + membership_id are both required to build a valid submit request;
    // owner non-empty implies a connected wallet, membershipId non-empty implies
    // a successful single-pass lookup.
    const isBindingReady = owner.length > 0 && membershipId.length > 0;
    // The duplicate-account statement must be fully affirmed before verification.
    const allStatementsAccepted = areIdentityStatementsAccepted(acceptedStatements);

    useEffect(() => {
        if (membershipPackageId.length === 0) {
            setGenesisObjects({ kind: "idle" });
            return;
        }
        let cancelled = false;
        setGenesisObjects({ kind: "loading" });
        resolveMembershipDappGenesisObjects(createJsonRpcEventClient(), {
            packageId: membershipPackageId,
        })
            .then((result) => {
                if (cancelled) {
                    return;
                }
                if (result.kind === "ok") {
                    setGenesisObjects({
                        kind: "ok",
                        identityRegistry: result.objects.identityRegistry,
                    });
                    return;
                }
                setGenesisObjects({ kind: "error", message: result.message });
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
    }, []);

    // Look up the connected wallet's MembershipPass on chain whenever the wallet
    // or network changes. A cancelled flag drops stale results so a slow lookup
    // for a previous wallet/network never overwrites the current one.
    useEffect(() => {
        if (owner.length === 0) {
            setLookup({ kind: "idle" });
            return;
        }
        let cancelled = false;
        setLookup({ kind: "loading" });
        lookupMembershipPass(client, owner, membershipPackageId)
            .then((result) => {
                if (!cancelled) {
                    setLookup(result);
                }
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setLookup({
                        kind: "error",
                        message: error instanceof Error ? error.message : "",
                    });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [owner, client]);

    function handleProviderChange(next: IdentityProvider) {
        onProviderChange(next);
        setWorldIdResponse(null);
    }

    function handleStatementToggle(index: number, checked: boolean) {
        setAcceptedStatements((current) =>
            current.map((value, position) => (position === index ? checked : value)),
        );
    }

    function runSubmit(worldIdResult: Record<string, unknown> | undefined) {
        setSubmitState({ status: "submitting", message: t("submit.submitting") });

        try {
            if (!isSubmitConfigured) {
                throw new Error(t("submit.notConfigured"));
            }
            const request = buildIdentitySubmitRequest(
                {
                    provider,
                    membershipId,
                    owner,
                    termsVersion: MEMBERSHIP_TERMS_VERSION,
                    signedStatementHash,
                },
                identityRegistry,
                worldIdResult,
            );
            fetch(submitUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(request),
            })
                .then(async (response) => {
                    const body = await readSubmitResponse(response);
                    if (!response.ok) {
                        throw new Error(readResponseMessage(body, response.status));
                    }
                    const jobId = readString(body.job_id, "job_id");
                    const jobStatus = readString(body.status, "status");
                    setSubmitState({
                        status: "success",
                        message: jobStatus === "queued" ? t("submit.queued") : t("submit.accepted"),
                        jobId,
                        jobStatus,
                    });
                    // 検証リクエストが受理されたらウィザード上は検証済み扱いにする。
                    onVerified();
                })
                .catch((error: unknown) => {
                    setSubmitState({
                        status: "failed",
                        message:
                            error instanceof Error && error.message.length > 0
                                ? error.message
                                : t("submit.failedFallback"),
                    });
                });
        } catch (error) {
            setSubmitState({
                status: "failed",
                message:
                    error instanceof Error && error.message.length > 0
                        ? error.message
                        : t("submit.failedFallback"),
            });
        }
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        // World ID submits automatically on verification; only KYC uses this form
        // submit path (it has no verification button of its own).
        if (provider !== "kyc") {
            return;
        }
        // Defense in depth against an Enter-key submit: the duplicate-account
        // statement must be affirmed before any identity submission.
        if (!allStatementsAccepted) {
            return;
        }
        runSubmit(undefined);
    }

    function handleWorldIdVerified(idkitResponse: Record<string, unknown>) {
        setWorldIdResponse(idkitResponse);
        runSubmit(idkitResponse);
    }

    return (
        <section aria-labelledby="wizard-identity-title" className="wizard-step-content">
            <header className="wizard-heading">
                <h1 className="wizard-title" id="wizard-identity-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            <div className="field-note" role="note">
                {t("optionalNotice")}
            </div>

            <form className="wizard-identity-form" onSubmit={handleSubmit}>
                <fieldset className="control-group">
                    <legend>{t("routeLegend")}</legend>
                    <div className="identity-choice-list">
                        {identityProviderIds.map((optionId) => (
                            <label className="identity-choice" key={optionId}>
                                <input
                                    checked={provider === optionId}
                                    name="identityProvider"
                                    onChange={() => handleProviderChange(optionId)}
                                    type="radio"
                                    value={optionId}
                                />
                                <span>
                                    <strong>{t(`options.${optionId}.label`)}</strong>
                                    <small>{t(`options.${optionId}.description`)}</small>
                                </span>
                            </label>
                        ))}
                    </div>
                </fieldset>

                <fieldset className="control-group">
                    <legend>{t("membershipLegend")}</legend>
                    <MembershipBindingStatus lookup={lookup} owner={owner} />
                </fieldset>

                <fieldset className="control-group">
                    <legend>{t("statementsLegend")}</legend>
                    <div className="terms-list">
                        {acceptedStatements.map((checked, index) => (
                            <label
                                className="terms-row"
                                // biome-ignore lint/suspicious/noArrayIndexKey: 配列は固定長・並べ替えなし
                                key={index}
                            >
                                <input
                                    checked={checked}
                                    name="identityTerms"
                                    onChange={(event) =>
                                        handleStatementToggle(index, event.target.checked)
                                    }
                                    type="checkbox"
                                />
                                <span>{t(`statements.${index}`)}</span>
                            </label>
                        ))}
                    </div>
                </fieldset>

                {provider === "world_id" ? (
                    <fieldset className="control-group">
                        <legend>{t("worldIdLegend")}</legend>
                        <WorldIdVerifyButton
                            membershipId={membershipId}
                            onVerified={handleWorldIdVerified}
                            owner={owner}
                            signedStatementHash={signedStatementHash}
                            statementsAccepted={
                                allStatementsAccepted && isSubmitConfigured && isBindingReady
                            }
                            verified={worldIdResponse !== null || identityVerified}
                        />
                    </fieldset>
                ) : null}

                <SubmitStatus isSubmitConfigured={isSubmitConfigured} state={submitState} />

                <div className="wizard-cta-bar">
                    <button className="btn btn-ghost btn-lg" onClick={onBack} type="button">
                        {tCommon("back")}
                    </button>
                    {provider === "kyc" ? (
                        <button
                            className="btn btn-primary btn-lg"
                            disabled={
                                submitState.status === "submitting" ||
                                !isSubmitConfigured ||
                                !isBindingReady ||
                                !allStatementsAccepted
                            }
                            type="submit"
                        >
                            {submitState.status === "submitting"
                                ? t("submit.kycSubmitting")
                                : t("submit.kycButton")}
                        </button>
                    ) : null}
                    <button
                        className={`btn btn-lg wizard-cta ${
                            identityVerified ? "btn-primary" : "btn-secondary"
                        }`}
                        onClick={onFinish}
                        type="button"
                    >
                        {identityVerified ? t("verifiedCta") : t("skipCta")}
                    </button>
                </div>
            </form>
        </section>
    );
}

function MembershipBindingStatus({
    lookup,
    owner,
}: {
    readonly lookup: MembershipLookupState;
    readonly owner: string;
}) {
    const t = useTranslations("register.wizard.identity.membership");

    if (owner.length === 0) {
        return (
            <div className="field-note" role="status">
                <strong>{t("connectTitle")}</strong>
                <small>{t("connectBody")}</small>
            </div>
        );
    }

    if (lookup.kind === "idle" || lookup.kind === "loading") {
        return (
            <div className="field-note" role="status">
                <strong>{t("checkingTitle")}</strong>
                <small>{t("checkingBody")}</small>
            </div>
        );
    }

    if (lookup.kind === "ok") {
        return (
            <div className="field-note" role="status">
                <strong>{t("detectedTitle")}</strong>
                <span>{shortAddress(lookup.membershipId)}</span>
                <small>{t("detectedBody")}</small>
            </div>
        );
    }

    if (lookup.kind === "none") {
        return (
            <div className="submit-status submit-status-failed" role="alert">
                {t("none")}
            </div>
        );
    }

    if (lookup.kind === "multiple") {
        return (
            <div className="submit-status submit-status-failed" role="alert">
                {t("multiple")}
            </div>
        );
    }

    return (
        <div className="submit-status submit-status-failed" role="alert">
            {lookup.message.length > 0 ? lookup.message : t("errorFallback")}
        </div>
    );
}

function SubmitStatus({
    isSubmitConfigured,
    state,
}: {
    readonly isSubmitConfigured: boolean;
    readonly state: SubmitState;
}) {
    const t = useTranslations("register.wizard.identity.submit");

    if (state.status === "idle") {
        if (isSubmitConfigured) {
            return null;
        }
        return (
            <div className="submit-status submit-status-failed" role="status">
                {t("notConfigured")}
            </div>
        );
    }
    if (state.status === "success") {
        return (
            <div className="submit-status submit-status-success" role="status">
                <strong>{state.message}</strong>
                <span>{t("jobLine", { jobId: state.jobId, jobStatus: state.jobStatus })}</span>
                <span>{t("processingNotice")}</span>
            </div>
        );
    }
    return (
        <div className={`submit-status submit-status-${state.status}`} role="status">
            {state.message}
        </div>
    );
}

async function readSubmitResponse(response: Response): Promise<Record<string, unknown>> {
    try {
        const value = (await response.json()) as unknown;
        return isRecord(value) ? value : {};
    } catch {
        return {};
    }
}

function readResponseMessage(body: Record<string, unknown>, status: number): string {
    return typeof body.message === "string" && body.message.length > 0
        ? body.message
        : `Verification request failed with HTTP ${status}.`;
}

function readString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Submit response is missing ${field}.`);
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
