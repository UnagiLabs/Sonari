"use client";

import { type FormEvent, useState } from "react";
import {
    RegisterHero,
    RegisterProgress,
    RegisterSidePanel,
    RegisterTopbar,
} from "../register-shared";
import { buildIdentitySubmitRequest, type IdentityProvider } from "./request";

const submitUrl = process.env.NEXT_PUBLIC_SONARI_IDENTITY_SUBMIT_URL ?? "";
const registryId = process.env.NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID ?? "";

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

export default function RegisterIdentityPage() {
    const [provider, setProvider] = useState<IdentityProvider>("world_id");
    const [submitState, setSubmitState] = useState<SubmitState>({ status: "idle" });
    const isSubmitConfigured = submitUrl.length > 0 && registryId.length > 0;

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setSubmitState({ status: "submitting", message: "Submitting verification request." });

        try {
            if (!isSubmitConfigured) {
                throw new Error("Identity submit endpoint is not configured.");
            }
            const request = buildIdentitySubmitRequest(
                new FormData(event.currentTarget),
                registryId,
            );
            const response = await fetch(submitUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(request),
            });
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
        } catch (error) {
            setSubmitState({
                status: "failed",
                message: error instanceof Error ? error.message : "Verification request failed.",
            });
        }
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
                                                    onChange={() => setProvider(option.id)}
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
                                    <legend>Membership request</legend>
                                    <div className="identity-fields">
                                        <label className="text-field" htmlFor="membership-id">
                                            <span>Membership SBT object ID</span>
                                            <input
                                                id="membership-id"
                                                name="membershipId"
                                                placeholder="0x..."
                                                type="text"
                                            />
                                        </label>
                                        <label className="text-field" htmlFor="owner">
                                            <span>Owner address</span>
                                            <input
                                                id="owner"
                                                name="owner"
                                                placeholder="0x..."
                                                type="text"
                                            />
                                        </label>
                                        <label className="text-field" htmlFor="terms-version">
                                            <span>Terms version</span>
                                            <input
                                                defaultValue="1"
                                                id="terms-version"
                                                min="0"
                                                name="termsVersion"
                                                type="number"
                                            />
                                        </label>
                                        <label
                                            className="text-field identity-wide-field"
                                            htmlFor="signed-statement-hash"
                                        >
                                            <span>Signed statement hash</span>
                                            <input
                                                id="signed-statement-hash"
                                                name="signedStatementHash"
                                                placeholder="0x..."
                                                type="text"
                                            />
                                            <small>
                                                Hash the signed duplicate-account statement before
                                                submission.
                                            </small>
                                        </label>
                                    </div>
                                </fieldset>

                                {provider === "world_id" ? (
                                    <fieldset className="control-group">
                                        <legend>World ID proof</legend>
                                        <div className="identity-proof-grid">
                                            <label className="text-field" htmlFor="world-app-id">
                                                <span>World app ID</span>
                                                <input
                                                    id="world-app-id"
                                                    name="worldAppId"
                                                    placeholder="app_staging_..."
                                                    type="text"
                                                />
                                            </label>
                                            <label className="text-field" htmlFor="nullifier-hash">
                                                <span>Nullifier hash</span>
                                                <input
                                                    id="nullifier-hash"
                                                    name="nullifierHash"
                                                    type="text"
                                                />
                                            </label>
                                            <label className="text-field" htmlFor="merkle-root">
                                                <span>Merkle root</span>
                                                <input
                                                    id="merkle-root"
                                                    name="merkleRoot"
                                                    placeholder="0x..."
                                                    type="text"
                                                />
                                            </label>
                                            <label
                                                className="text-field"
                                                htmlFor="verification-level"
                                            >
                                                <span>Verification level</span>
                                                <input
                                                    defaultValue="orb"
                                                    id="verification-level"
                                                    name="verificationLevel"
                                                    type="text"
                                                />
                                            </label>
                                            <label className="text-field" htmlFor="world-action">
                                                <span>Action</span>
                                                <input
                                                    defaultValue="sonari_membership_register_v1"
                                                    id="world-action"
                                                    name="worldIdAction"
                                                    type="text"
                                                />
                                            </label>
                                            <label className="text-field" htmlFor="signal-hash">
                                                <span>Signal hash</span>
                                                <input
                                                    id="signal-hash"
                                                    name="signalHash"
                                                    placeholder="0x..."
                                                    type="text"
                                                />
                                            </label>
                                            <label
                                                className="text-field identity-wide-field"
                                                htmlFor="proof"
                                            >
                                                <span>Proof</span>
                                                <textarea id="proof" name="proof" rows={4} />
                                            </label>
                                        </div>
                                    </fieldset>
                                ) : null}

                                <fieldset className="control-group">
                                    <legend>Duplicate-account statement</legend>
                                    <div className="terms-list">
                                        {identityStatements.map((statement) => (
                                            <label className="terms-row" key={statement}>
                                                <input name="identityTerms" type="checkbox" />
                                                <span>{statement}</span>
                                            </label>
                                        ))}
                                    </div>
                                </fieldset>

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
                                    <button
                                        className="btn btn-primary btn-lg"
                                        disabled={
                                            submitState.status === "submitting" ||
                                            !isSubmitConfigured
                                        }
                                        type="submit"
                                    >
                                        {submitState.status === "submitting"
                                            ? "Submitting"
                                            : "Start identity check"}
                                    </button>
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
