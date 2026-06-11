import { formatDate } from "../i18n/format";
import type { SonariLocale } from "../register/wizard/locale";
import type {
    MembershipPassData,
    MembershipPassReadResult,
    MembershipReadErrorCode,
} from "./membership-pass-read";

/**
 * Pure presentation helpers for /mypage. These convert raw `MembershipPass`
 * values into translation *keys* (not finished strings) so the UI stays ja/en
 * agnostic, and derive the page's display state from the read result.
 *
 * Kept free of React and i18n so the rules can be pinned by unit tests.
 */

export type StatusLabelKey = "active" | "suspended" | "revoked" | "migrated" | "unknown";

/** Membership status codes — must match `contracts/sources/membership.move`. */
const STATUS_KEYS: Record<number, StatusLabelKey> = {
    1: "active",
    2: "suspended",
    3: "revoked",
    4: "migrated",
};

export function statusLabelKey(status: number): StatusLabelKey {
    return STATUS_KEYS[status] ?? "unknown";
}

export type ProviderLabelKey = "kyc" | "worldId";

/** Identity provider bit values — must match `contracts/sources/membership.move`. */
const PROVIDER_BITS: ReadonlyArray<{ readonly bit: number; readonly key: ProviderLabelKey }> = [
    { bit: 1, key: "kyc" },
    { bit: 2, key: "worldId" },
];

/**
 * Decompose the provider bitmask into its known label keys, in stable order.
 * Unknown bits are ignored; mask 0 yields an empty list.
 */
export function providerLabelKeys(mask: number): ProviderLabelKey[] {
    return PROVIDER_BITS.filter(({ bit }) => (mask & bit) !== 0).map(({ key }) => key);
}

/**
 * Format a millisecond timestamp as a locale-aware date string.
 * Non-positive values (0 = unset on-chain, or negative) return null so the UI
 * can show an "unset" fallback instead of an epoch date.
 *
 * Thin wrapper over the shared {@link formatDate} so /mypage keeps its existing
 * call sites while date/amount formatting lives in one place (`app/i18n/format`).
 */
export function formatTimestamp(ms: number, locale: SonariLocale): string | null {
    return formatDate(ms, locale);
}

/** Display state of the /mypage screen, derived from connection + read result. */
export type MypageView =
    | { readonly kind: "disconnected" }
    | { readonly kind: "unconfigured" }
    | { readonly kind: "loading" }
    | { readonly kind: "not_registered" }
    | { readonly kind: "error"; readonly code: MembershipReadErrorCode }
    | { readonly kind: "ready"; readonly pass: MembershipPassData };

export interface MypageViewInput {
    /** Whether a wallet is connected. */
    readonly connected: boolean;
    /** Connected wallet address (empty string when disconnected). */
    readonly owner: string;
    /** On-chain read result; null before/while reading. */
    readonly result: MembershipPassReadResult | null;
    /**
     * Whether the read can run. Pass false in unconfigured environments
     * (missing package id). Defaults to true.
     */
    readonly lookupEnabled?: boolean;
}

/**
 * Derive the /mypage display state.
 *
 * - not connected → disconnected
 * - lookupEnabled=false → unconfigured
 * - result=null (connected) → loading
 * - result.kind=none → not_registered
 * - result.kind=error → error
 * - result.kind=ok → ready
 */
export function deriveMypageView(input: MypageViewInput): MypageView {
    if (!input.connected) {
        return { kind: "disconnected" };
    }
    if (input.lookupEnabled === false) {
        return { kind: "unconfigured" };
    }
    if (input.result === null) {
        return { kind: "loading" };
    }
    switch (input.result.kind) {
        case "none":
            return { kind: "not_registered" };
        case "error":
            return { kind: "error", code: input.result.code };
        case "ok":
            return { kind: "ready", pass: input.result.pass };
    }
}
