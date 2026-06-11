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
    | "residence_cell_not_allowed"
    | "tile_invalid"
    | "tile_manifest_invalid"
    | "tile_manifest_missing"
    | "tile_not_found"
    | "tile_version_mismatch";

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

// 居住セル proof はブラウザ（dapp）から直接 fetch される公開の読み取り API のため
// CORS を許可する。資格情報（Cookie 等）は使わないので origin は "*" で十分。
export const CORS_HEADERS: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "*",
};

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
                ...CORS_HEADERS,
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
