"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SiteTopbar } from "../i18n/site-topbar";
import type { SonariLocale } from "../register/wizard/locale";
import { dAppKit } from "../wallet/dapp-kit";
import { WalletConnect } from "../wallet/wallet-connect";
import { executeWalletTransaction } from "../wallet/wallet-transaction-adapter";
import {
    type AffectedCellsProof,
    assertProofMatchesClaimContext,
    buildClaimDisasterUsdcTransaction,
    type ClaimDisasterUsdcObjectConfig,
    fetchAffectedCellsProof,
} from "./affected-cells-proof";
import { type ClaimMessage, resolveClaimProofError, resolveClaimTxError } from "./claim-messages";

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

type CheckKey = "finalized" | "membership" | "residence" | "noPreviousClaim" | "poolBudget";

// Backend integration point: replace these values with wallet, pass, and event data later.
const membershipPass = {
    passId: "pass_0x7a9...21c",
    passObjectId: "0x00000000000000000000000000000000000000000000000000000000000000b1",
    homeCell: "608819013597790207",
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

const checkDefinitions: readonly { key: CheckKey; defaultStatus: "ready" | "pending" }[] = [
    { key: "finalized", defaultStatus: "ready" },
    { key: "membership", defaultStatus: "ready" },
    { key: "residence", defaultStatus: "ready" },
    { key: "noPreviousClaim", defaultStatus: "ready" },
    { key: "poolBudget", defaultStatus: "pending" },
];

const claimPreviewItems: readonly { labelKey: string; value?: string; valueKey?: string }[] = [
    { labelKey: "estimatedRelief", value: "$280 USDC" },
    { labelKey: "poolSource", value: "Earthquake Relief Pool" },
    { labelKey: "campaign", value: "USGS Earthquake Relief" },
    { labelKey: "receipt", valueKey: "receiptValue" },
];

type ProofState =
    | { readonly status: "idle" }
    | { readonly status: "checking" }
    | { readonly status: "ready"; readonly proof: AffectedCellsProof }
    | { readonly status: "blocked"; readonly message: ClaimMessage };

type TxState =
    | { readonly status: "idle" }
    | { readonly status: "building" }
    | { readonly status: "submitting" }
    | { readonly status: "submitted"; readonly digest: string }
    | { readonly status: "failed"; readonly message: ClaimMessage };

export function ClaimView({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("claim");
    const defaultEvent = defaultClaimableEvent();
    const [selectedEventId, setSelectedEventId] = useState(defaultEvent.id);
    const [proofState, setProofState] = useState<ProofState>({ status: "idle" });
    const [txState, setTxState] = useState<TxState>({ status: "idle" });
    const account = useCurrentAccount();
    const selectedEvent =
        claimableEvents.find((event) => event.id === selectedEventId) ?? defaultEvent;
    const isWalletConnected = account !== null;
    const isClaimInFlight = txState.status === "building" || txState.status === "submitting";
    const isClaimDisabled = proofState.status !== "ready" || isClaimInFlight || !isWalletConnected;

    // カタログのキー or 原文を、現在の locale で表示文字列へ解決する。
    const renderMessage = (message: ClaimMessage): string =>
        message.kind === "key" ? t(message.key) : message.text;

    const proofMessage = (): string => {
        switch (proofState.status) {
            case "idle":
                return t("proof.idle");
            case "checking":
                return t("proof.checking");
            case "ready":
                return t("proof.ready");
            case "blocked":
                return renderMessage(proofState.message);
        }
    };

    const txMessage = (): string => {
        switch (txState.status) {
            case "idle":
                return t("tx.idle.message");
            case "building":
                return t("tx.building.message");
            case "submitting":
                return t("tx.submitting.message");
            case "submitted":
                return t("tx.submitted.message");
            case "failed":
                return renderMessage(txState.message);
        }
    };

    const txDetail = (): string => {
        switch (txState.status) {
            case "idle":
                return t("tx.idle.detail");
            case "building":
                return t("tx.building.detail");
            case "submitting":
                return t("tx.submitting.detail");
            case "submitted":
                return t("tx.submitted.detail", { digest: txState.digest });
            case "failed":
                return t("tx.failed.detail");
        }
    };

    const checks = checkDefinitions.map((definition) => {
        // 居住セルのチェックだけは証明の結果に追従する。証明が未完了なら
        // 証明メッセージを detail にしてステータスを pending にする。
        if (definition.key === "residence" && proofState.status !== "ready") {
            return {
                key: definition.key,
                label: t("checks.residence.label"),
                detail: proofMessage(),
                status: "pending" as const,
            };
        }
        return {
            key: definition.key,
            label: t(`checks.${definition.key}.label`),
            detail: t(`checks.${definition.key}.detail`),
            status: definition.defaultStatus,
        };
    });

    async function handleCheckEligibility() {
        setProofState({ status: "checking" });
        setTxState({ status: "idle" });

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
            setProofState({ status: "ready", proof });
        } catch (error) {
            setProofState({ status: "blocked", message: resolveClaimProofError(error) });
        }
    }

    async function handleBuildClaim() {
        if (proofState.status !== "ready") {
            return;
        }
        if (account === null) {
            setTxState({
                status: "failed",
                message: { kind: "key", key: "tx.failed.walletRequired" },
            });
            return;
        }

        setTxState({ status: "building" });
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

            setTxState({ status: "submitting" });
            const { digest } = await executeWalletTransaction(dAppKit, { transaction });
            setTxState({ status: "submitted", digest });
        } catch (error) {
            setTxState({ status: "failed", message: resolveClaimTxError(error) });
        }
    }

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="claim" locale={locale} showWallet />

                <main className="page claim-page">
                    <header className="claim-hero">
                        <div>
                            <div className="eyebrow">{t("hero.eyebrow")}</div>
                            <h1>{t("hero.title")}</h1>
                            <p className="muted claim-sub">{t("hero.sub")}</p>
                        </div>
                        <div className="claim-wallet-panel">
                            <span className="tag tag-neutral">{t("hero.walletTag")}</span>
                            <p>{t("hero.walletBody")}</p>
                            <WalletConnect />
                        </div>
                    </header>

                    <section className="claim-layout" aria-label={t("hero.eyebrow")}>
                        <div className="claim-main">
                            <section className="claim-pass-panel" aria-labelledby="pass-title">
                                <div className="panel-header">
                                    <div>
                                        <div className="eyebrow">{t("pass.eyebrow")}</div>
                                        <h2 id="pass-title">{t("pass.title")}</h2>
                                    </div>
                                    <span className="tag tag-ok tag-dot">
                                        {t("pass.statusActive")}
                                    </span>
                                </div>
                                <dl className="pass-grid">
                                    <div>
                                        <dt>{t("pass.passId")}</dt>
                                        <dd>{membershipPass.passId}</dd>
                                    </div>
                                    <div>
                                        <dt>{t("pass.residenceCell")}</dt>
                                        <dd>{membershipPass.homeCell}</dd>
                                    </div>
                                    <div>
                                        <dt>{t("pass.verification")}</dt>
                                        <dd>{t("pass.verificationValid")}</dd>
                                    </div>
                                </dl>
                            </section>

                            <section
                                className="claim-event-panel"
                                aria-labelledby="event-select-title"
                            >
                                <div className="form-heading">
                                    <div>
                                        <div className="eyebrow">{t("event.eyebrow")}</div>
                                        <h2 id="event-select-title">{t("event.title")}</h2>
                                    </div>
                                    <a className="text-action" href="/events">
                                        {t("event.viewEvents")}
                                    </a>
                                </div>

                                <fieldset className="control-group">
                                    <legend>{t("event.selectLegend")}</legend>
                                    <div className="claim-event-list">
                                        {claimableEvents.map((event) => (
                                            <label className="claim-event-option" key={event.id}>
                                                <input
                                                    checked={selectedEvent.id === event.id}
                                                    name="claimEvent"
                                                    onChange={() => {
                                                        setSelectedEventId(event.id);
                                                        setProofState({ status: "idle" });
                                                        setTxState({ status: "idle" });
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
                                        <div className="eyebrow">{t("eligibility.eyebrow")}</div>
                                        <h2 id="eligibility-title">{t("eligibility.title")}</h2>
                                    </div>
                                    <button
                                        className="btn btn-secondary"
                                        disabled={proofState.status === "checking"}
                                        onClick={handleCheckEligibility}
                                        type="button"
                                    >
                                        {t("eligibility.checkButton")}
                                    </button>
                                </div>
                                <div className="check-list">
                                    {checks.map((check) => (
                                        <div className="check-row" key={check.key}>
                                            <span
                                                className={`check-indicator ${
                                                    check.status === "ready" ? "ready" : "pending"
                                                }`}
                                            />
                                            <div>
                                                <strong>{check.label}</strong>
                                                <small>{check.detail}</small>
                                            </div>
                                            <span className="tag tag-neutral">
                                                {t(`checkStatus.${check.status}`)}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                                <p className="muted claim-sub">{proofMessage()}</p>
                            </section>
                        </div>

                        <aside className="claim-side" aria-label={t("preview.eyebrow")}>
                            <section className="claim-summary-panel">
                                <div className="panel-header compact">
                                    <div>
                                        <div className="eyebrow">{t("preview.eyebrow")}</div>
                                        <h2>{t("preview.title")}</h2>
                                    </div>
                                </div>
                                <div className="claim-preview-list">
                                    {claimPreviewItems.map((item) => (
                                        <div className="claim-preview-row" key={item.labelKey}>
                                            <span>{t(`preview.${item.labelKey}`)}</span>
                                            <strong>
                                                {item.valueKey
                                                    ? t(`preview.${item.valueKey}`)
                                                    : item.value}
                                            </strong>
                                        </div>
                                    ))}
                                </div>
                                <button
                                    className="btn btn-primary btn-lg"
                                    disabled={isClaimDisabled}
                                    onClick={handleBuildClaim}
                                    type="button"
                                >
                                    {t("claimButton")}
                                </button>
                            </section>

                            <section className="claim-note">
                                <h3>{t("note.title")}</h3>
                                <p>{t("note.body")}</p>
                            </section>

                            <section className="claim-result-panel">
                                <div className="eyebrow">{t("result.eyebrow")}</div>
                                <div className="result-placeholder">
                                    <strong>{txMessage()}</strong>
                                    <small>{txDetail()}</small>
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
