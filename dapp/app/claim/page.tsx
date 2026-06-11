"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import Image from "next/image";
import { useState } from "react";
import { dAppKit } from "../wallet/dapp-kit";
import { NetworkMismatchBanner } from "../wallet/network-mismatch-banner";
import { WalletConnect } from "../wallet/wallet-connect";
import { executeWalletTransaction } from "../wallet/wallet-transaction-adapter";
import {
    type AffectedCellsProof,
    assertProofMatchesClaimContext,
    buildClaimDisasterUsdcTransaction,
    type ClaimDisasterUsdcObjectConfig,
    ClaimProofError,
    fetchAffectedCellsProof,
} from "./affected-cells-proof";

type ClaimableEvent = {
    id: string;
    source: "USGS";
    eventUid: string;
    eventRevision: number;
    affectedCellsRoot: string;
    txObjects: ClaimDisasterUsdcObjectConfig;
    packageId: string;
    region: string;
    intensity: string;
    affectedCells: string;
    window: string;
    defaultChecked?: boolean;
};

type EligibilityCheck = {
    label: string;
    detail: string;
    status: "ready" | "pending";
};

// Backend integration point: replace these values with wallet, pass, and event data later.
const membershipPass = {
    status: "Active",
    passId: "pass_0x7a9...21c",
    passObjectId: "0x00000000000000000000000000000000000000000000000000000000000000b1",
    homeCell: "608819013597790207",
    verification: "Signed residence metadata valid",
};

const affectedProofWorkerUrl = process.env.NEXT_PUBLIC_SONARI_AFFECTED_PROOF_WORKER_URL ?? "";

const claimTxObjects: ClaimDisasterUsdcObjectConfig = {
    pauseState: "0x0000000000000000000000000000000000000000000000000000000000000011",
    claimIndex: "0x0000000000000000000000000000000000000000000000000000000000000012",
    membershipRegistry: "0x0000000000000000000000000000000000000000000000000000000000000013",
    program: "0x0000000000000000000000000000000000000000000000000000000000000014",
    campaign: "0x0000000000000000000000000000000000000000000000000000000000000015",
    policy: "0x0000000000000000000000000000000000000000000000000000000000000016",
    budget: "0x0000000000000000000000000000000000000000000000000000000000000017",
    binding: "0x0000000000000000000000000000000000000000000000000000000000000018",
    disasterEvent: "0x0000000000000000000000000000000000000000000000000000000000000019",
    identityRegistry: "0x000000000000000000000000000000000000000000000000000000000000001a",
    pass: membershipPass.passObjectId,
    designatedPool: "0x000000000000000000000000000000000000000000000000000000000000001c",
    mainPool: "0x000000000000000000000000000000000000000000000000000000000000001d",
};

const claimableEvents: ClaimableEvent[] = [
    {
        id: "usgs-2026-0521-184",
        source: "USGS",
        eventUid: "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
        eventRevision: 1,
        affectedCellsRoot: "0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f",
        txObjects: claimTxObjects,
        packageId: "0x00000000000000000000000000000000000000000000000000000000000000aa",
        region: "Offshore Iwate, Japan",
        intensity: "M6.8 / MMI VIII",
        affectedCells: "1,284 affected cells",
        window: "Open until Jun 04",
        defaultChecked: true,
    },
    {
        id: "usgs-2026-0517-021",
        source: "USGS",
        eventUid: "0xcd131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
        eventRevision: 1,
        affectedCellsRoot: "0x626e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f",
        txObjects: claimTxObjects,
        packageId: "0x00000000000000000000000000000000000000000000000000000000000000aa",
        region: "Northern California",
        intensity: "M5.9 / MMI VII",
        affectedCells: "482 affected cells",
        window: "Open until Jun 01",
    },
];

const eligibilityChecks: EligibilityCheck[] = [
    {
        label: "DisasterEvent finalized",
        detail: "Signed payload has been accepted by the program.",
        status: "ready",
    },
    {
        label: "MembershipPass active",
        detail: "Connected wallet has a current MembershipPass.",
        status: "ready",
    },
    {
        label: "Residence cell included",
        detail: "Registered H3 cell appears in affected_cells.",
        status: "ready",
    },
    {
        label: "No previous claim",
        detail: "This event has not been claimed by this pass.",
        status: "ready",
    },
    {
        label: "Pool budget available",
        detail: "Relief pool has enough available amount for the estimate.",
        status: "pending",
    },
];

const claimPreview = [
    { label: "Estimated Relief Cash", value: "$280 USDC" },
    { label: "Pool source", value: "Earthquake Relief Pool" },
    { label: "Campaign", value: "USGS Earthquake Relief" },
    { label: "Receipt", value: "Public, recipient reference anonymized" },
];

type ProofState =
    | { readonly status: "idle"; readonly message: string }
    | { readonly status: "checking"; readonly message: string }
    | { readonly status: "ready"; readonly message: string; readonly proof: AffectedCellsProof }
    | { readonly status: "blocked"; readonly message: string };

type TxState =
    | { readonly status: "idle"; readonly message: string }
    | { readonly status: "building"; readonly message: string }
    | { readonly status: "submitting"; readonly message: string }
    | { readonly status: "submitted"; readonly message: string; readonly digest: string }
    | { readonly status: "failed"; readonly message: string };

export default function ClaimPage() {
    const defaultEvent = defaultClaimableEvent();
    const [selectedEventId, setSelectedEventId] = useState(defaultEvent.id);
    const [proofState, setProofState] = useState<ProofState>({
        status: "idle",
        message: "Eligibility has not been checked.",
    });
    const [txState, setTxState] = useState<TxState>({
        status: "idle",
        message: "Waiting for claim action.",
    });
    const account = useCurrentAccount();
    const selectedEvent =
        claimableEvents.find((event) => event.id === selectedEventId) ?? defaultEvent;
    const checks = buildEligibilityChecks(proofState);
    const isWalletConnected = account !== null;
    const isClaimInFlight = txState.status === "building" || txState.status === "submitting";
    const isClaimDisabled = proofState.status !== "ready" || isClaimInFlight || !isWalletConnected;

    async function handleCheckEligibility() {
        setProofState({ status: "checking", message: "Checking affected cells proof." });
        setTxState({ status: "idle", message: "Waiting for claim action." });

        try {
            const proof = await fetchAffectedCellsProof({
                workerUrl: affectedProofWorkerUrl,
                eventUid: selectedEvent.eventUid,
                eventRevision: selectedEvent.eventRevision,
                homeCell: membershipPass.homeCell,
            });
            assertProofMatchesClaimContext(proof, {
                eventUid: selectedEvent.eventUid,
                eventRevision: selectedEvent.eventRevision,
                homeCell: membershipPass.homeCell,
                affectedCellsRoot: selectedEvent.affectedCellsRoot,
            });
            setProofState({
                status: "ready",
                message: "Affected cells proof verified.",
                proof,
            });
        } catch (error) {
            setProofState({
                status: "blocked",
                message: claimErrorMessage(error),
            });
        }
    }

    async function handleBuildClaim() {
        if (proofState.status !== "ready") {
            return;
        }
        if (account === null) {
            setTxState({
                status: "failed",
                message: "Connect a wallet before claiming.",
            });
            return;
        }

        setTxState({ status: "building", message: "Building claim transaction." });
        try {
            const { transaction } = buildClaimDisasterUsdcTransaction({
                senderAddress: account.address,
                packageId: selectedEvent.packageId,
                proof: proofState.proof,
                context: {
                    eventUid: selectedEvent.eventUid,
                    eventRevision: selectedEvent.eventRevision,
                    homeCell: membershipPass.homeCell,
                    affectedCellsRoot: selectedEvent.affectedCellsRoot,
                },
                objects: selectedEvent.txObjects,
                identityProvider: 1,
                duplicateKeyHash:
                    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                userMaxAmountUsdc: "50000000",
            });

            setTxState({
                status: "submitting",
                message: "Approve the transaction in your wallet.",
            });
            const { digest } = await executeWalletTransaction(dAppKit, { transaction });
            setTxState({
                status: "submitted",
                message: "Claim transaction submitted.",
                digest,
            });
        } catch (error) {
            setTxState({
                status: "failed",
                message: error instanceof Error ? error.message : "Claim transaction failed.",
            });
        }
    }

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <ClaimTopbar />
                <NetworkMismatchBanner />

                <main className="page claim-page">
                    <header className="claim-hero">
                        <div>
                            <div className="eyebrow">Claim relief</div>
                            <h1>Check eligibility without exposing private details.</h1>
                            <p className="muted claim-sub">
                                A front-end claim flow for MembershipPass status, finalized disaster
                                events, eligibility checks, and Relief Cash transaction previews.
                            </p>
                        </div>
                        <div className="claim-wallet-panel">
                            <span className="tag tag-neutral">Wallet</span>
                            <p>Connect a wallet to load MembershipPass and claim history.</p>
                            <WalletConnect />
                        </div>
                    </header>

                    <section className="claim-layout" aria-label="Claim flow preview">
                        <div className="claim-main">
                            <section className="claim-pass-panel" aria-labelledby="pass-title">
                                <div className="panel-header">
                                    <div>
                                        <div className="eyebrow">MembershipPass</div>
                                        <h2 id="pass-title">Recipient status</h2>
                                    </div>
                                    <span className="tag tag-ok tag-dot">
                                        {membershipPass.status}
                                    </span>
                                </div>
                                <dl className="pass-grid">
                                    <div>
                                        <dt>Pass ID</dt>
                                        <dd>{membershipPass.passId}</dd>
                                    </div>
                                    <div>
                                        <dt>Residence cell</dt>
                                        <dd>{membershipPass.homeCell}</dd>
                                    </div>
                                    <div>
                                        <dt>Verification</dt>
                                        <dd>{membershipPass.verification}</dd>
                                    </div>
                                </dl>
                            </section>

                            <section
                                className="claim-event-panel"
                                aria-labelledby="event-select-title"
                            >
                                <div className="form-heading">
                                    <div>
                                        <div className="eyebrow">DisasterEvent</div>
                                        <h2 id="event-select-title">Claimable events</h2>
                                    </div>
                                    <a className="text-action" href="/events">
                                        View events
                                    </a>
                                </div>

                                <fieldset className="control-group">
                                    <legend>Select event</legend>
                                    <div className="claim-event-list">
                                        {claimableEvents.map((event) => (
                                            <label className="claim-event-option" key={event.id}>
                                                <input
                                                    checked={selectedEvent.id === event.id}
                                                    name="claimEvent"
                                                    onChange={() => {
                                                        setSelectedEventId(event.id);
                                                        setProofState({
                                                            status: "idle",
                                                            message:
                                                                "Eligibility has not been checked.",
                                                        });
                                                        setTxState({
                                                            status: "idle",
                                                            message: "Waiting for claim action.",
                                                        });
                                                    }}
                                                    type="radio"
                                                    value={event.id}
                                                />
                                                <span className="event-badge">{event.source}</span>
                                                <span>
                                                    <strong>{event.region}</strong>
                                                    <small>{event.id}</small>
                                                </span>
                                                <span>
                                                    <b>{event.intensity}</b>
                                                    <small>{event.affectedCells}</small>
                                                </span>
                                                <em>{event.window}</em>
                                            </label>
                                        ))}
                                    </div>
                                </fieldset>
                            </section>

                            <section
                                className="claim-check-panel"
                                aria-labelledby="eligibility-title"
                            >
                                <div className="panel-header">
                                    <div>
                                        <div className="eyebrow">Eligibility</div>
                                        <h2 id="eligibility-title">Verification checks</h2>
                                    </div>
                                    <button
                                        className="btn btn-secondary"
                                        disabled={proofState.status === "checking"}
                                        onClick={handleCheckEligibility}
                                        type="button"
                                    >
                                        Check eligibility
                                    </button>
                                </div>
                                <div className="check-list">
                                    {checks.map((check) => (
                                        <div className="check-row" key={check.label}>
                                            <span
                                                className={`check-indicator ${
                                                    check.status === "ready" ? "ready" : "pending"
                                                }`}
                                            />
                                            <div>
                                                <strong>{check.label}</strong>
                                                <small>{check.detail}</small>
                                            </div>
                                            <span className="tag tag-neutral">{check.status}</span>
                                        </div>
                                    ))}
                                </div>
                                <p className="muted claim-sub">{proofState.message}</p>
                            </section>
                        </div>

                        <aside className="claim-side" aria-label="Claim preview">
                            <section className="claim-summary-panel">
                                <div className="panel-header compact">
                                    <div>
                                        <div className="eyebrow">Preview</div>
                                        <h2>Estimated claim</h2>
                                    </div>
                                </div>
                                <div className="claim-preview-list">
                                    {claimPreview.map((item) => (
                                        <div className="claim-preview-row" key={item.label}>
                                            <span>{item.label}</span>
                                            <strong>{item.value}</strong>
                                        </div>
                                    ))}
                                </div>
                                <button
                                    className="btn btn-primary btn-lg"
                                    disabled={isClaimDisabled}
                                    onClick={handleBuildClaim}
                                    type="button"
                                >
                                    Claim relief
                                </button>
                            </section>

                            <section className="claim-note">
                                <h3>Privacy boundary</h3>
                                <p>
                                    Public screens should show H3 cell, pass status, verification
                                    status, and anonymized recipient references only.
                                </p>
                            </section>

                            <section className="claim-result-panel">
                                <div className="eyebrow">Transaction result</div>
                                <div className="result-placeholder">
                                    <strong>{txState.message}</strong>
                                    <small>{transactionStatusDetail(txState)}</small>
                                </div>
                            </section>
                        </aside>
                    </section>
                </main>
            </div>
        </>
    );
}

function defaultClaimableEvent(): ClaimableEvent {
    const event =
        claimableEvents.find((candidate) => candidate.defaultChecked) ?? claimableEvents[0];
    if (event === undefined) {
        throw new Error("claimableEvents must contain at least one event");
    }
    return event;
}

function buildEligibilityChecks(proofState: ProofState): EligibilityCheck[] {
    return eligibilityChecks.map((check) => {
        if (check.label !== "Residence cell included") {
            return check;
        }
        if (proofState.status === "ready") {
            return {
                ...check,
                detail: "Registered H3 cell appears in affected_cells.",
                status: "ready",
            };
        }
        return {
            ...check,
            detail: proofState.message,
            status: "pending",
        };
    });
}

function claimErrorMessage(error: unknown): string {
    if (error instanceof ClaimProofError) {
        switch (error.code) {
            case "worker_url_missing":
                return "Affected proof worker is not configured.";
            case "outside_affected_area":
                return "Residence cell is outside this event.";
            case "proof_fetch_failed":
                return "Affected proof could not be fetched.";
            case "invalid_proof_response":
            case "proof_verification_failed":
                return "Affected proof could not be verified.";
        }
    }
    return error instanceof Error ? error.message : "Eligibility check failed.";
}

function transactionStatusDetail(txState: TxState): string {
    if (txState.status === "submitted") {
        return `Transaction digest: ${txState.digest}`;
    }
    if (txState.status === "submitting") {
        return "Approve the claim transaction in your connected wallet.";
    }
    if (txState.status === "building") {
        return "Preparing the claim transaction for signing.";
    }
    if (txState.status === "failed") {
        return "The claim transaction was not completed.";
    }
    return "The transaction digest, receipt link, and status can render here after signing.";
}

function ClaimTopbar() {
    return (
        <header className="topbar">
            <div className="topbar-inner">
                <a className="brand" href="/" aria-label="Sonari home">
                    <span className="brand-mark">
                        <Image
                            src="/assets/sonari_logo.png"
                            alt="Sonari"
                            width={36}
                            height={36}
                            priority
                        />
                    </span>
                    <span className="brand-name">Sonari</span>
                </a>
                <nav className="nav" aria-label="Primary">
                    <a className="nav-item" href="/">
                        Home
                    </a>
                    <a className="nav-item" href="/donate">
                        Donate
                    </a>
                    <a className="nav-item" href="/dashboard">
                        Dashboard
                    </a>
                    <a className="nav-item" href="/leaderboard">
                        Leaderboard
                    </a>
                    <a className="nav-item active" href="/claim">
                        Claim
                    </a>
                </nav>
                <div className="topbar-spacer" />
                <WalletConnect />
            </div>
        </header>
    );
}
