export type IdentityProvider = "kyc" | "world_id";

export interface IdentityEvidenceSnapshot {
    readonly provider: IdentityProvider;
    readonly membership_id: string;
    readonly owner: string;
    readonly evidence_hash: string;
    readonly submitted_at_ms: number;
}

export interface IdentityVerificationResult {
    readonly intent: string;
    readonly verifier_family: "identity";
    readonly verifier_version: number;
    readonly registry_id: string;
    readonly membership_id: string;
    readonly owner: string;
    readonly provider: IdentityProvider;
    readonly verified: boolean;
    readonly duplicate_key_hash: string;
    readonly evidence_hash: string;
    readonly issued_at_ms: number;
    readonly expires_at_ms: number;
    readonly terms_version: number;
    readonly signed_statement_hash: string;
}

export interface MembershipIdentityState {
    readonly identity_verified: boolean;
    readonly identity_provider_mask: number;
    readonly identity_verified_at_ms: number;
    readonly identity_expires_at_ms: number;
    readonly terms_version: number;
    readonly signed_statement_hash: string;
}
