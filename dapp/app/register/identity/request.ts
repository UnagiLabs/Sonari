export type IdentityProvider = "kyc" | "world_id";

export interface WorldIdProofRequest {
    readonly world_app_id: string;
    readonly nullifier_hash: string;
    readonly merkle_root: string;
    readonly proof: string;
    readonly verification_level: string;
    readonly action: string;
    readonly signal_hash: string;
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
): IdentitySubmitRequest {
    const provider = parseIdentityProvider(readFormString(formData, "identityProvider"));
    const request: IdentitySubmitRequest = {
        registry_id: requireString(registryId, "NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID"),
        membership_id: readFormString(formData, "membershipId"),
        owner: readFormString(formData, "owner"),
        provider,
        terms_version: parseSafeUnsignedInteger(readFormString(formData, "termsVersion")),
        signed_statement_hash: readFormString(formData, "signedStatementHash"),
        ...(provider === "world_id" ? { world_id: buildWorldIdProof(formData) } : {}),
    };
    return request;
}

function buildWorldIdProof(formData: FormDataLike): WorldIdProofRequest {
    return {
        world_app_id: readFormString(formData, "worldAppId"),
        nullifier_hash: readFormString(formData, "nullifierHash"),
        merkle_root: readFormString(formData, "merkleRoot"),
        proof: readFormString(formData, "proof"),
        verification_level: readFormString(formData, "verificationLevel"),
        action: readFormString(formData, "worldIdAction"),
        signal_hash: readFormString(formData, "signalHash"),
    };
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
