"use client";

/**
 * WorldIdVerifyButton – thin React glue for IDKit v4.
 *
 * This component contains only stateful UI wiring. All testable logic
 * (requestRpSignature, buildRpContext, interpretWorldIdResult, mapWorldIdError,
 * shortNullifierFingerprint) lives in world-id-verify.ts and is covered by
 * .test.ts unit tests.
 *
 * Design constraints:
 *   - allow_legacy_proofs={false}  — accepts only Orb v4 proofs.
 *   - proofOfHuman({ signal })     — Orb-verified unique human credential only.
 *   - WORLD_ID_RP_SIGNING_KEY is server-only; never read here.
 *   - The parent page controls form submit gating; this button does not force
 *     verification (verified={true} reflects parent state, skip is allowed).
 */

import { worldIdSignalString } from "@sonari/proof-core";
import {
    type IDKitErrorCodes,
    IDKitRequestWidget,
    type IDKitResult,
    proofOfHuman,
    type RpContext,
} from "@worldcoin/idkit";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { LoadingIndicator } from "../../components/loading-indicator";
import { WORLD_ID_ACTION } from "./world-id-action";
import {
    buildRpContext,
    interpretWorldIdResult,
    mapWorldIdError,
    requestRpSignature,
    shortNullifierFingerprint,
} from "./world-id-verify";

// ---------------------------------------------------------------------------
// env (NEXT_PUBLIC_ – safe to read on the client)
// ---------------------------------------------------------------------------

const appId = process.env.NEXT_PUBLIC_WORLD_ID_APP_ID ?? "";
const rpId = process.env.NEXT_PUBLIC_WORLD_ID_RP_ID ?? "";
const environment: "staging" | "production" =
    process.env.NEXT_PUBLIC_WORLD_ID_ENVIRONMENT === "staging" ? "staging" : "production";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorldIdVerifyButtonProps {
    /** Wallet owner address (0x-hex 32 bytes) */
    readonly owner: string;
    /** Membership SBT object ID (0x-hex 32 bytes) */
    readonly membershipId: string;
    /** Signed statement hash (0x-hex 32 bytes) */
    readonly signedStatementHash: string;
    /** True once every duplicate-account statement has been affirmed */
    readonly statementsAccepted: boolean;
    /** True when the parent already has a verified IDKit response */
    readonly verified: boolean;
    /** Called with the idkit_response when World ID verification succeeds */
    readonly onVerified: (idkitResponse: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Status type
// ---------------------------------------------------------------------------

type VerifyStatus = "idle" | "preparing" | "open" | "verified" | "error";

// ---------------------------------------------------------------------------
// Presentational icons (visual only)
// ---------------------------------------------------------------------------

// World ID を表すグローブアイコン。検証ボタンのラベル前に置く装飾。
function GlobeIcon() {
    return (
        <svg aria-hidden="true" className="world-id-glyph" viewBox="0 0 24 24">
            <circle cx="12" cy="12" fill="none" r="9" stroke="currentColor" strokeWidth="1.8" />
            <path
                d="M3 12h18M12 3c2.6 2.4 2.6 15.6 0 18M12 3c-2.6 2.4-2.6 15.6 0 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
            />
        </svg>
    );
}

// 検証済みカードの円形チェックバッジ。
function VerifiedBadgeIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
            <path
                d="M20 6 9 17l-5-5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3"
            />
        </svg>
    );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorldIdVerifyButton({
    owner,
    membershipId,
    signedStatementHash,
    statementsAccepted,
    verified,
    onVerified,
}: WorldIdVerifyButtonProps) {
    const t = useTranslations("register.wizard.identity.worldId");
    const [status, setStatus] = useState<VerifyStatus>("idle");
    const [errorMessage, setErrorMessage] = useState<string>("");
    const [rpContext, setRpContext] = useState<RpContext | null>(null);
    const [signal, setSignal] = useState<string>("");
    const [nullifier, setNullifier] = useState<string>("");

    const isConfigured = appId.length > 0 && rpId.length > 0;
    // owner + membershipId are supplied by the parent from the connected wallet
    // and the on-chain MembershipPass lookup. Until both are present the signal
    // binding cannot be derived, so the verify button stays disabled (the parent
    // also renders guidance explaining which one is missing).
    const isBindingReady = owner.length > 0 && membershipId.length > 0;

    // -----------------------------------------------------------------------
    // Derived display state
    // -----------------------------------------------------------------------

    const isVerified = verified || status === "verified";

    // -----------------------------------------------------------------------
    // Handlers
    // -----------------------------------------------------------------------

    async function handleOpenClick() {
        // The duplicate-account statement must be affirmed before verifying. The
        // button is disabled until then; this guards an unexpected programmatic call.
        if (!statementsAccepted) {
            setStatus("error");
            setErrorMessage(t("acceptStatementsError"));
            return;
        }

        // Validate the bound inputs before touching IDKit
        let signalString: string;
        try {
            signalString = worldIdSignalString(owner, membershipId, signedStatementHash);
        } catch {
            setStatus("error");
            setErrorMessage(t("bindingError"));
            return;
        }

        setStatus("preparing");
        setErrorMessage("");

        try {
            const sig = await requestRpSignature(WORLD_ID_ACTION);
            const ctx = buildRpContext(rpId, sig);
            setRpContext(ctx);
            setSignal(signalString);
            setStatus("open");
        } catch (err) {
            setStatus("error");
            setErrorMessage(err instanceof Error ? err.message : t("prepareError"));
        }
    }

    // Only `onSuccess` is wired (not `handleVerify`): the dapp does not verify
    // the proof client-side — the enclave (TEE) is the trust boundary and runs
    // the v4 verify on submit. Wiring both props would invoke this twice.
    async function handleSuccess(result: IDKitResult) {
        const interpreted = interpretWorldIdResult(result);
        if (!interpreted.ok) {
            setStatus("error");
            setErrorMessage(interpreted.message);
            return;
        }

        // Extract nullifier for display (short fingerprint only)
        const responses = (result as unknown as Record<string, unknown>).responses;
        if (Array.isArray(responses) && responses.length > 0) {
            const first = responses[0] as Record<string, unknown>;
            if (typeof first.nullifier === "string") {
                setNullifier(first.nullifier);
            }
        }

        onVerified(interpreted.idkitResponse);
        setStatus("verified");
    }

    function handleError(code: IDKitErrorCodes) {
        setStatus("error");
        setErrorMessage(mapWorldIdError(code));
    }

    function handleOpenChange(open: boolean) {
        if (!open && status === "open") {
            setStatus("idle");
        }
    }

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    if (isVerified) {
        const fingerprint = nullifier.length > 0 ? shortNullifierFingerprint(nullifier) : null;
        return (
            <div className="world-id-verified" role="status">
                <span className="world-id-verified-badge" aria-hidden="true">
                    <VerifiedBadgeIcon />
                </span>
                <span className="world-id-verified-text">
                    <span className="world-id-verified-label">{t("verifiedLabel")}</span>
                    {fingerprint !== null ? (
                        <span className="world-id-nullifier-hint">{fingerprint}</span>
                    ) : null}
                </span>
            </div>
        );
    }

    return (
        <div className="world-id-verify-wrapper">
            {!isConfigured ? (
                <p className="world-id-config-error" role="alert">
                    {t("notConfigured")}
                </p>
            ) : null}

            <button
                className="btn btn-primary world-id-verify-button"
                disabled={
                    !isConfigured ||
                    !isBindingReady ||
                    !statementsAccepted ||
                    status === "preparing"
                }
                onClick={handleOpenClick}
                type="button"
            >
                <GlobeIcon />
                {status === "preparing" ? t("preparing") : t("verifyButton")}
            </button>

            {status === "preparing" ? <LoadingIndicator label={t("preparing")} /> : null}

            {isConfigured && isBindingReady && !statementsAccepted ? (
                <p className="world-id-hint" role="note">
                    {t("statementsFirst")}
                </p>
            ) : null}

            {status === "error" && errorMessage.length > 0 ? (
                <div className="world-id-error">
                    <p className="world-id-error-message" role="alert">
                        {errorMessage}
                    </p>
                    <button
                        className="btn btn-secondary"
                        disabled={!isConfigured || !isBindingReady || !statementsAccepted}
                        onClick={handleOpenClick}
                        type="button"
                    >
                        {t("retryButton")}
                    </button>
                </div>
            ) : null}

            {rpContext !== null ? (
                <IDKitRequestWidget
                    allow_legacy_proofs={false}
                    app_id={appId as `app_${string}`}
                    action={WORLD_ID_ACTION}
                    environment={environment}
                    onError={handleError}
                    onOpenChange={handleOpenChange}
                    onSuccess={handleSuccess}
                    open={status === "open"}
                    preset={proofOfHuman({ signal })}
                    rp_context={rpContext}
                />
            ) : null}
        </div>
    );
}
