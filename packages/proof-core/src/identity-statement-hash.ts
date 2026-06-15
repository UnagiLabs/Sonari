import type { PrefixedHex32 } from "./bytes.js";
import { hashToFieldBytes } from "./world-id-signal.js";

/**
 * Canonical duplicate-account statement that backs the fixed World ID
 * `signed_statement_hash`.
 *
 * For World ID registration the dapp does not let the member hand-enter a
 * statement hash. Instead it derives a deterministic
 * `signed_statement_hash` from this fixed declaration plus the terms version.
 * The enclave never inspects the statement contents — it only feeds
 * `signed_statement_hash` into the World ID `signal_hash` binding
 * (`compute_world_id_signal_hash` in
 * nautilus/verifiers/membership/tee/src/core/processing.rs) — so a shared
 * fixed value is sufficient. Per-user uniqueness of `signal_hash` and the
 * nullifier still holds because `owner` and `membership_id` are user-specific.
 */
export const IDENTITY_DUPLICATE_ACCOUNT_STATEMENT =
    "I attest that I do not hold another active Sonari Membership SBT.";

/**
 * Derives the fixed World ID `signed_statement_hash` from the canonical
 * duplicate-account statement and the terms version.
 *
 * The canonical input is the NUL-joined statement and `terms_version:<n>`,
 * run through World ID v4 hashToField (so the result is a `0x`-prefixed 32-byte
 * value with the top byte zeroed) to match the byte shape the enclave and the
 * Move `MembershipPass.signed_statement_hash` field expect.
 */
export function computeIdentityStatementHash(termsVersion: number): PrefixedHex32 {
    if (!Number.isSafeInteger(termsVersion) || termsVersion < 0) {
        throw new Error("termsVersion must be a non-negative safe integer");
    }
    const canonical = [IDENTITY_DUPLICATE_ACCOUNT_STATEMENT, `terms_version:${termsVersion}`].join(
        "\0",
    );
    return hashToFieldBytes(new TextEncoder().encode(canonical));
}
