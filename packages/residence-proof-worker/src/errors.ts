export type ResidenceProofErrorCode =
    | "invalid_h3_index"
    | "method_not_allowed"
    | "not_found"
    | "proof_invalid"
    | "proof_manifest_invalid"
    | "proof_manifest_missing"
    | "proof_shard_integrity_mismatch"
    | "proof_shard_invalid"
    | "proof_shard_missing"
    | "residence_cell_not_allowed";

export class ResidenceProofError extends Error {
    constructor(
        readonly code: ResidenceProofErrorCode,
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "ResidenceProofError";
    }
}

export function errorResponse(error: ResidenceProofError): Response {
    return new Response(
        JSON.stringify({
            error: {
                code: error.code,
                message: error.message,
            },
        }),
        {
            status: error.status,
            headers: {
                "content-type": "application/json; charset=utf-8",
            },
        },
    );
}

export function toResidenceProofError(error: unknown): ResidenceProofError {
    if (error instanceof ResidenceProofError) {
        return error;
    }
    return new ResidenceProofError("proof_invalid", "Residence proof request failed", 500);
}
