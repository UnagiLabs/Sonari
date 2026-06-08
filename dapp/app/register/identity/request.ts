import { WORLD_ID_ACTION } from "./world-id-action";

export type IdentityProvider = "kyc" | "world_id";

export interface WorldIdProofRequest {
    readonly idkit_response: Record<string, unknown>;
}

export interface IdentitySubmitRequest {
    readonly registry_id: string;
    readonly membership_id: string;
    readonly owner: string;
    readonly provider: IdentityProvider;
    readonly terms_version: number;
    readonly signed_statement_hash: string;
    readonly world_id?: WorldIdProofRequest;
}

interface FormDataLike {
    get(name: string): unknown;
}

export function readFormString(formData: FormDataLike, name: string): string {
    const value = formData.get(name);
    if (typeof value !== "string") {
        throw new Error(`${name} is required`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new Error(`${name} is required`);
    }
    return trimmed;
}

export function buildIdentitySubmitRequest(
    formData: FormDataLike,
    registryId: string,
    worldIdResult?: unknown,
): IdentitySubmitRequest {
    const provider = parseIdentityProvider(readFormString(formData, "identityProvider"));
    const membershipId = readFormString(formData, "membershipId");
    const owner = readFormString(formData, "owner");
    const signedStatementHash = readFormString(formData, "signedStatementHash");
    const termsVersion = parseSafeUnsignedInteger(readFormString(formData, "termsVersion"));

    const worldId =
        provider === "world_id"
            ? { idkit_response: parseIdkitResponse(worldIdResult) }
            : undefined;

    const request: IdentitySubmitRequest = {
        registry_id: requireString(registryId, "NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID"),
        membership_id: membershipId,
        owner,
        provider,
        terms_version: termsVersion,
        signed_statement_hash: signedStatementHash,
        ...(worldId === undefined ? {} : { world_id: worldId }),
    };
    return request;
}

/**
 * Validates that `value` is a well-formed IDKit v4 response and returns it
 * as-is (no remapping). Catches malformed payloads client-side before the
 * network round-trip.
 *
 * Only an Orb-verified unique-human credential is accepted: the World ID v4
 * `proof_of_human` credential (`issuer_schema_id: 1`), which is issued by the
 * Orb iris scan. Weaker proofs (device-only legacy, selfie, passport, mnc) are
 * rejected here so that someone who has not completed Orb verification cannot
 * pass identity verification.
 *
 * Note: the enclave (`uniqueness_proof()` in
 * nautilus/verifiers/membership/tee/src/core/types.rs) currently still expects
 * the placeholder `identifier == "orb"`; aligning the enclave to the real
 * `proof_of_human` identifier is the declared World ID v4 follow-up (#212,
 * docs/webapp.md:506). The dapp forwards the real IDKit identifier faithfully.
 */
export function parseIdkitResponse(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("World ID response must be an object");
    }
    const obj = value as Record<string, unknown>;

    if (obj.session_id !== undefined) {
        throw new Error("World ID session proofs are not supported");
    }

    if (obj.protocol_version !== "4.0") {
        throw new Error("World ID protocol_version must be 4.0");
    }

    if (typeof obj.action !== "string" || obj.action !== WORLD_ID_ACTION) {
        throw new Error("World ID action does not match the expected Sonari action");
    }

    if (typeof obj.environment !== "string" || obj.environment.length === 0) {
        throw new Error("World ID environment must be a non-empty string");
    }

    if (!Array.isArray(obj.responses) || obj.responses.length !== 1) {
        throw new Error("World ID responses must be an array with exactly one element");
    }

    const response = obj.responses[0];
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
        throw new Error("World ID responses[0] must be an object");
    }
    const r = response as Record<string, unknown>;

    if (r.identifier !== "proof_of_human") {
        throw new Error(
            "World ID responses[0].identifier must be proof_of_human (Orb-verified human)",
        );
    }

    if (r.issuer_schema_id !== 1) {
        throw new Error(
            "World ID responses[0].issuer_schema_id must be 1 (Orb proof_of_human credential)",
        );
    }

    if (typeof r.signal_hash !== "string" || r.signal_hash.length === 0) {
        throw new Error("World ID responses[0].signal_hash must be a non-empty string");
    }

    if (typeof r.nullifier !== "string" || r.nullifier.length === 0) {
        throw new Error("World ID responses[0].nullifier must be a non-empty string");
    }

    return obj;
}

function parseIdentityProvider(value: string): IdentityProvider {
    if (value === "kyc" || value === "world_id") {
        return value;
    }
    throw new Error("identityProvider must be kyc or world_id");
}

function parseSafeUnsignedInteger(value: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("termsVersion must be a safe unsigned integer");
    }
    return parsed;
}

function requireString(value: string, name: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new Error(`${name} is required`);
    }
    return trimmed;
}
