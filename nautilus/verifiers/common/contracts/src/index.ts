export const EARTHQUAKE_VERIFIER_KIND = "earthquake";
export const MEMBERSHIP_IDENTITY_VERIFIER_KIND = "membership_identity";

export const VERIFIER_KINDS = [
    EARTHQUAKE_VERIFIER_KIND,
    MEMBERSHIP_IDENTITY_VERIFIER_KIND,
] as const;

export type VerifierKind = (typeof VERIFIER_KINDS)[number];

export function parseVerifierKind(input: unknown): VerifierKind {
    if (input === EARTHQUAKE_VERIFIER_KIND || input === MEMBERSHIP_IDENTITY_VERIFIER_KIND) {
        return input;
    }
    throw new Error("verifier_kind must be earthquake or membership_identity");
}
