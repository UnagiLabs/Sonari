import { bytesToPrefixedHex, type PrefixedHex32, sha256Bytes } from "./bytes.js";

/**
 * Domain prefix for the World ID `signal_hash` binding.
 *
 * Must match the enclave's `WORLD_ID_SIGNAL_HASH_PREFIX`
 * (nautilus/verifiers/membership/tee/src/core/processing.rs). The enclave
 * rejects any World ID request whose `signal_hash` is not the derived binding
 * below, so the dapp computes it instead of trusting free-form form input.
 */
export const WORLD_ID_SIGNAL_HASH_PREFIX = "sonari:world_id_signal:v1";

/**
 * Derives the World ID `signal_hash` exactly as the enclave does in
 * `compute_world_id_signal_hash`
 * (nautilus/verifiers/membership/tee/src/core/processing.rs): `sha256` over the
 * NUL-joined `prefix, owner, membership_id, signed_statement_hash`, each id
 * canonicalised to a lowercase 0x-hex 32-byte string.
 *
 * The enclave's trusted-boundary check rejects any request whose `signal_hash`
 * is not this binding, so the value is derived from the request fields rather
 * than entered by hand. Runs on Web Crypto so it works in the browser dapp.
 */
export async function computeWorldIdSignalHash(
    owner: string,
    membershipId: string,
    signedStatementHash: string,
): Promise<PrefixedHex32> {
    const parts = [
        WORLD_ID_SIGNAL_HASH_PREFIX,
        canonicalHex32Lower(owner, "owner"),
        canonicalHex32Lower(membershipId, "membership_id"),
        canonicalHex32Lower(signedStatementHash, "signed_statement_hash"),
    ];
    const encoded = new TextEncoder().encode(parts.join("\0"));
    return bytesToPrefixedHex(await sha256Bytes(encoded));
}

/**
 * Mirrors the enclave's `canonical_hex_32_lower`: accept only a `0x`/`0X`
 * prefixed 32-byte hex string and re-emit it as lowercase `0x`-hex. Anything
 * else (missing prefix, wrong length, non-hex, empty) is rejected so the
 * derivation fails closed.
 */
function canonicalHex32Lower(value: string, fieldName: string): string {
    const hex = stripHexPrefix(value);
    if (hex === null || !/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`${fieldName} must be a 0x-prefixed 32-byte hex string`);
    }
    return `0x${hex.toLowerCase()}`;
}

function stripHexPrefix(value: string): string | null {
    if (value.startsWith("0x") || value.startsWith("0X")) {
        return value.slice(2);
    }
    return null;
}
