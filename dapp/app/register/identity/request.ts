import { computeWorldIdSignalHash } from "@sonari/proof-core";

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

export async function buildIdentitySubmitRequest(
    formData: FormDataLike,
    registryId: string,
): Promise<IdentitySubmitRequest> {
    const provider = parseIdentityProvider(readFormString(formData, "identityProvider"));
    const membershipId = readFormString(formData, "membershipId");
    const owner = readFormString(formData, "owner");
    const signedStatementHash = readFormString(formData, "signedStatementHash");
    const termsVersion = parseSafeUnsignedInteger(readFormString(formData, "termsVersion"));
    const worldId =
        provider === "world_id"
            ? await buildWorldIdProof(formData, { owner, membershipId, signedStatementHash })
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

interface WorldIdSignalBinding {
    readonly owner: string;
    readonly membershipId: string;
    readonly signedStatementHash: string;
}

async function buildWorldIdProof(
    formData: FormDataLike,
    binding: WorldIdSignalBinding,
): Promise<WorldIdProofRequest> {
    return {
        world_app_id: readFormString(formData, "worldAppId"),
        nullifier_hash: readFormString(formData, "nullifierHash"),
        merkle_root: readFormString(formData, "merkleRoot"),
        proof: readFormString(formData, "proof"),
        verification_level: readFormString(formData, "verificationLevel"),
        action: readFormString(formData, "worldIdAction"),
        // The enclave rejects any signal_hash that is not the binding derived
        // from owner, membership, and signed statement, so it is computed here
        // instead of being read from the form.
        signal_hash: await computeWorldIdSignalHash(
            binding.owner,
            binding.membershipId,
            binding.signedStatementHash,
        ),
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
