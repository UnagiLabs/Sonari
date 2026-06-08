"use client";

import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { computeIdentityStatementHash } from "@sonari/proof-core";
import dynamic from "next/dynamic";
import { type FormEvent, useEffect, useState } from "react";
import {
    RegisterHero,
    RegisterProgress,
    RegisterSidePanel,
    RegisterTopbar,
} from "../register-shared";
import { lookupMembershipPass, type MembershipLookupResult } from "./membership-lookup";
import {
    areIdentityStatementsAccepted,
    buildIdentitySubmitRequest,
    type IdentityProvider,
} from "./request";

const WorldIdVerifyButton = dynamic(
    () => import("./world-id-verify-button").then((m) => m.WorldIdVerifyButton),
    { ssr: false },
);

const submitUrl = process.env.NEXT_PUBLIC_SONARI_IDENTITY_SUBMIT_URL ?? "";
const registryId = process.env.NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID ?? "";
const membershipPackageId = process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID ?? "";

// Fixed terms version for the duplicate-account statement. The statement is no
// longer hand-entered; the dapp derives a deterministic signed_statement_hash
// from this version (see computeIdentityStatementHash). The enclave only feeds
// this value into the World ID signal_hash binding, so a fixed value is safe.
const IDENTITY_TERMS_VERSION = 1;
const signedStatementHash = computeIdentityStatementHash(IDENTITY_TERMS_VERSION);

interface IdentityOption {
    readonly id: IdentityProvider;
    readonly label: string;
    readonly description: string;
}

const identityOptions: IdentityOption[] = [
    {
        id: "kyc",
        label: "KYC",
        description:
            "Use a provider-verified duplicate key. Raw KYC data and document images are not published by Sonari.",
    },
    {
        id: "world_id",
        label: "World ID",
        description:
            "Use a World ID nullifier for the Sonari claim action. You can set this up now or from the member area later.",
    },
];

const identityStatements = [
    "I do not hold another active Sonari Membership SBT.",
    "I will not claim the same disaster from multiple Membership SBTs.",
    "I understand I can skip identity setup now and return before receiving Relief Cash.",
];

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

export default function RegisterIdentityPage() {
    const [provider, setProvider] = useState<IdentityProvider>("world_id");
    const [submitState, setSubmitState] = useState<SubmitState>({ status: "idle" });
    const [worldIdResponse, setWorldIdResponse] = useState<Record<string, unknown> | null>(null);
    const [lookup, setLookup] = useState<MembershipLookupState>({ kind: "idle" });
    // One acceptance flag per duplicate-account statement. The member must affirm
    // every statement before any identity action (World ID verify / KYC submit) is
    // enabled, so verification is always preceded by the statement.
    const [acceptedStatements, setAcceptedStatements] = useState<readonly boolean[]>(() =>
        identityStatements.map(() => false),
    );

    const account = useCurrentAccount();
    const client = useCurrentClient();
    const owner = account?.address ?? "";
    const membershipId = lookup.kind === "ok" ? lookup.membershipId : "";
    const isSubmitConfigured = submitUrl.length > 0 && registryId.length > 0;
    // owner + membership_id are both required to build a valid submit request;
    // owner non-empty implies a connected wallet, membershipId non-empty implies
    // a successful single-pass lookup.
    const isBindingReady = owner.length > 0 && membershipId.length > 0;
    // The duplicate-account statement must be fully affirmed before verification.
    const allStatementsAccepted = areIdentityStatementsAccepted(acceptedStatements);

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
                        message:
                            error instanceof Error
                                ? error.message
                                : "Could not look up your Membership SBT.",
                    });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [owner, client]);

    function handleProviderChange(next: IdentityProvider) {
        setProvider(next);
        setWorldIdResponse(null);
    }

    function handleStatementToggle(index: number, checked: boolean) {
        setAcceptedStatements((current) =>
            current.map((value, position) => (position === index ? checked : value)),
        );
    }

    function runSubmit(worldIdResult: Record<string, unknown> | undefined) {
        setSubmitState({ status: "submitting", message: "Submitting verification request." });

        try {
            if (!isSubmitConfigured) {
                throw new Error("Identity submit endpoint is not configured.");
            }
            const request = buildIdentitySubmitRequest(
                {
                    provider,
                    membershipId,
                    owner,
                    termsVersion: IDENTITY_TERMS_VERSION,
                    signedStatementHash,
                },
                registryId,
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
                        message:
                            jobStatus === "queued"
                                ? "Verification job queued."
                                : "Verification request accepted.",
                        jobId,
                        jobStatus,
                    });
                })
                .catch((error: unknown) => {
                    setSubmitState({
                        status: "failed",
                        message:
                            error instanceof Error ? error.message : "Verification request failed.",
                    });
                });
        } catch (error) {
            setSubmitState({
                status: "failed",
                message: error instanceof Error ? error.message : "Verification request failed.",
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
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <RegisterTopbar />

                <main className="page register-page">
                    <RegisterHero />

                    <section className="register-layout" aria-labelledby="identity-step-title">
                        <div className="register-flow">
                            <RegisterProgress current="identity" />

                            <form
                                className="register-form register-step-page"
                                onSubmit={handleSubmit}
                            >
                                <div className="form-heading">
                                    <div>
                                        <div className="eyebrow">Optional anytime</div>
                                        <h2 id="identity-step-title">
                                            Add KYC or World ID now, later, or before claim.
                                        </h2>
                                    </div>
                                    <span className="tag tag-neutral">Skippable</span>
                                </div>

                                <div className="step-page-copy">
                                    <p>
                                        Initial registration only needs the wallet-bound Membership
                                        SBT and residence cell. Identity verification is an account
                                        setting you can complete anytime, and it becomes required
                                        only before payout.
                                    </p>
                                </div>

                                <fieldset className="control-group">
                                    <legend>Verification route</legend>
                                    <div className="identity-choice-list">
                                        {identityOptions.map((option) => (
                                            <label className="identity-choice" key={option.id}>
                                                <input
                                                    checked={provider === option.id}
                                                    name="identityProvider"
                                                    onChange={() => handleProviderChange(option.id)}
                                                    type="radio"
                                                    value={option.id}
                                                />
                                                <span>
                                                    <strong>{option.label}</strong>
                                                    <small>{option.description}</small>
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                </fieldset>

                                <fieldset className="control-group">
                                    <legend>Membership</legend>
                                    <MembershipBindingStatus lookup={lookup} owner={owner} />
                                </fieldset>

                                <fieldset className="control-group">
                                    <legend>Duplicate-account statement</legend>
                                    <div className="terms-list">
                                        {identityStatements.map((statement, index) => (
                                            <label className="terms-row" key={statement}>
                                                <input
                                                    checked={acceptedStatements[index] ?? false}
                                                    name="identityTerms"
                                                    onChange={(event) =>
                                                        handleStatementToggle(
                                                            index,
                                                            event.target.checked,
                                                        )
                                                    }
                                                    type="checkbox"
                                                />
                                                <span>{statement}</span>
                                            </label>
                                        ))}
                                    </div>
                                </fieldset>

                                {provider === "world_id" ? (
                                    <fieldset className="control-group">
                                        <legend>World ID proof</legend>
                                        <WorldIdVerifyButton
                                            membershipId={membershipId}
                                            onVerified={handleWorldIdVerified}
                                            owner={owner}
                                            signedStatementHash={signedStatementHash}
                                            statementsAccepted={allStatementsAccepted}
                                            verified={worldIdResponse !== null}
                                        />
                                    </fieldset>
                                ) : null}

                                <div className="claim-requirement-band">
                                    <div>
                                        <span>Initial registration</span>
                                        <strong>SBT + H3 cell</strong>
                                    </div>
                                    <div>
                                        <span>Anytime setting</span>
                                        <strong>KYC or World ID</strong>
                                    </div>
                                    <div>
                                        <span>Published data</span>
                                        <strong>Verified status only</strong>
                                    </div>
                                </div>

                                <SubmitStatus
                                    isSubmitConfigured={isSubmitConfigured}
                                    state={submitState}
                                />

                                <div className="form-actions">
                                    <a
                                        className="btn btn-secondary btn-lg"
                                        href="/register/residence"
                                    >
                                        Back
                                    </a>
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
                                                ? "Submitting"
                                                : "Start identity check"}
                                        </button>
                                    ) : null}
                                    <button className="btn btn-secondary btn-lg" type="button">
                                        Skip and finish signup
                                    </button>
                                </div>
                            </form>
                        </div>

                        <RegisterSidePanel />
                    </section>
                </main>
            </div>
        </>
    );
}

function MembershipBindingStatus({
    lookup,
    owner,
}: {
    readonly lookup: MembershipLookupState;
    readonly owner: string;
}) {
    if (owner.length === 0) {
        return (
            <div className="field-note" role="status">
                <strong>Connect a wallet to continue</strong>
                <small>
                    Sonari reads your Membership SBT and wallet address automatically — no manual
                    entry.
                </small>
            </div>
        );
    }

    if (lookup.kind === "idle" || lookup.kind === "loading") {
        return (
            <div className="field-note" role="status">
                <strong>Checking your Membership SBT…</strong>
                <small>Looking up the pass owned by your connected wallet.</small>
            </div>
        );
    }

    if (lookup.kind === "ok") {
        return (
            <div className="field-note" role="status">
                <strong>Membership SBT detected</strong>
                <span>{shortId(lookup.membershipId)}</span>
                <small>Verification binds to this pass and your connected wallet.</small>
            </div>
        );
    }

    if (lookup.kind === "none") {
        return (
            <div className="submit-status submit-status-failed" role="alert">
                No Membership SBT found for this wallet. Complete Step 1 first.
            </div>
        );
    }

    if (lookup.kind === "multiple") {
        return (
            <div className="submit-status submit-status-failed" role="alert">
                Multiple Membership SBTs found for this wallet. Please contact support before
                verifying.
            </div>
        );
    }

    return (
        <div className="submit-status submit-status-failed" role="alert">
            {lookup.message.length > 0 ? lookup.message : "Could not look up your Membership SBT."}
        </div>
    );
}

function shortId(value: string): string {
    return value.length > 14 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;
}

function SubmitStatus({
    isSubmitConfigured,
    state,
}: {
    readonly isSubmitConfigured: boolean;
    readonly state: SubmitState;
}) {
    if (state.status === "idle") {
        if (isSubmitConfigured) {
            return null;
        }
        return (
            <div className="submit-status submit-status-failed" role="status">
                Identity submit endpoint is not configured.
            </div>
        );
    }
    if (state.status === "success") {
        return (
            <div className="submit-status submit-status-success" role="status">
                <strong>{state.message}</strong>
                <span>
                    Job {state.jobId} is {state.jobStatus}.
                </span>
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
