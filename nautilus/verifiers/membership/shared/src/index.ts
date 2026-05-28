export type IdentityProvider = "kyc" | "world_id";

export type IdentityVerificationStatus = "verified" | "rejected";

export interface IdentityEvidenceSnapshot {
    readonly provider: IdentityProvider;
    readonly subjectBindingHash: string;
    readonly evidenceHash: string;
    readonly submittedAtMs: number;
}

export interface IdentityVerificationResult {
    readonly provider: IdentityProvider;
    readonly status: IdentityVerificationStatus;
    readonly subjectBindingHash: string;
    readonly duplicateKeyHash: string;
    readonly evidenceHash: string;
    readonly issuedAtMs: number;
    readonly expiresAtMs: number;
    readonly termsVersion: number;
    readonly signedStatementHash: string;
}

export interface MembershipIdentityState {
    readonly identityVerified: boolean;
    readonly identityProviderMask: number;
    readonly identityVerifiedAtMs: number;
    readonly identityExpiresAtMs: number;
    readonly termsVersion: number;
    readonly signedStatementHash: string;
}
