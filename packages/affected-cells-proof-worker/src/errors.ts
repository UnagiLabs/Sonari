export type AffectedCellsProofErrorCode =
    | "invalid_request"
    | "unauthorized"
    | "walrus_fetch_failed"
    | "affected_cells_hash_mismatch"
    | "affected_cells_root_mismatch"
    | "affected_cells_invalid"
    | "affected_cell_not_in_event"
    | "proof_manifest_missing"
    | "proof_manifest_invalid"
    | "proof_shard_missing"
    | "proof_shard_integrity_mismatch"
    | "proof_shard_invalid"
    | "method_not_allowed"
    | "not_found"
    | "internal";

export class AffectedCellsProofError extends Error {
    constructor(
        readonly code: AffectedCellsProofErrorCode,
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "AffectedCellsProofError";
    }
}

export function errorResponse(error: AffectedCellsProofError): Response {
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

export function toAffectedCellsProofError(error: unknown): AffectedCellsProofError {
    if (error instanceof AffectedCellsProofError) {
        return error;
    }
    return new AffectedCellsProofError("internal", "Affected cells proof request failed", 500);
}
