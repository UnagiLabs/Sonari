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
import { useState } from "react";
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
// Component
// ---------------------------------------------------------------------------

export function WorldIdVerifyButton({
    owner,
    membershipId,
    signedStatementHash,
    verified,
    onVerified,
}: WorldIdVerifyButtonProps) {
    const [status, setStatus] = useState<VerifyStatus>("idle");
    const [errorMessage, setErrorMessage] = useState<string>("");
    const [rpContext, setRpContext] = useState<RpContext | null>(null);
    const [signal, setSignal] = useState<string>("");
    const [nullifier, setNullifier] = useState<string>("");

    const isConfigured = appId.length > 0 && rpId.length > 0;

    // -----------------------------------------------------------------------
    // Derived display state
    // -----------------------------------------------------------------------

    const isVerified = verified || status === "verified";

    // -----------------------------------------------------------------------
    // Handlers
    // -----------------------------------------------------------------------

    async function handleOpenClick() {
        // Validate the bound inputs before touching IDKit
        let signalString: string;
        try {
            signalString = worldIdSignalString(owner, membershipId, signedStatementHash);
        } catch {
            setStatus("error");
            setErrorMessage("Fill in owner, membership, and statement first.");
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
            setErrorMessage(
                err instanceof Error ? err.message : "Failed to prepare World ID verification.",
            );
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
                <span className="world-id-verified-label">World ID Verified</span>
                {fingerprint !== null ? (
                    <span className="world-id-nullifier-hint">{fingerprint}</span>
                ) : null}
            </div>
        );
    }

    return (
        <div className="world-id-verify-wrapper">
            {!isConfigured ? (
                <p className="world-id-config-error" role="alert">
                    World ID is not configured.
                </p>
            ) : null}

            <button
                className="btn btn-primary"
                disabled={!isConfigured || status === "preparing"}
                onClick={handleOpenClick}
                type="button"
            >
                {status === "preparing" ? "Preparing…" : "Verify with World ID"}
            </button>

            {status === "error" && errorMessage.length > 0 ? (
                <p className="world-id-error-message" role="alert">
                    {errorMessage}
                </p>
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
