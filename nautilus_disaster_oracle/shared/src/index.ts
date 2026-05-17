export const PAYLOAD_V1_FIELD_ORDER = [
    "intent",
    "oracle_version",
    "event_uid",
    "hazard_type",
    "status",
    "event_revision",
    "occurred_at_ms",
    "observed_at_ms",
    "source_updated_at_ms",
    "primary_source",
    "severity_band",
    "source_set_hash",
    "raw_data_hash",
    "raw_data_uri",
    "affected_cells_root",
    "affected_cells_uri",
    "affected_cells_data_hash",
    "geo_resolution",
    "cells_generation_method",
    "cell_metric",
    "cell_aggregation",
    "intensity_scale",
    "max_cell_band",
    "affected_cell_count",
    "min_claim_band",
    "freshness_deadline_ms",
] as const;

export const AFFECTED_CELL_LEAF_FIELD_ORDER = [
    "event_uid",
    "event_revision",
    "h3_index",
    "geo_resolution",
    "cell_metric",
    "intensity_value",
    "intensity_scale",
    "cell_band",
    "cells_generation_method",
    "oracle_version",
] as const;

export const BCS_ENUMS = {
    intent: {
        SONARI_EARTHQUAKE_ORACLE: 1,
    },
    hazardType: {
        EARTHQUAKE: 1,
    },
    onchainStatus: {
        FINALIZED: 3,
    },
    primarySource: {
        USGS: 1,
    },
    cellsGenerationMethod: {
        SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1: 1,
        SHAKEMAP_HDF_H3_WEIGHTED_P90_V1: 2,
        JMA_250M_H3_P90_V1: 3,
    },
    cellMetric: {
        USGS_MMI: 1,
        JMA_SHINDO: 2,
    },
    cellAggregation: {
        GRID_POINT_P90: 1,
    },
    intensityScale: {
        MMI_X100: 1,
        JMA_SHINDO_X10: 2,
    },
} as const;

export const DEFAULT_ORACLE_CONTRACT = {
    oracle_version: 1,
    geo_resolution: 7,
    min_claim_band: 1,
} as const;

export const OFFCHAIN_STATUSES = [
    "new",
    "processing",
    "pending_source",
    "pending_mmi",
    "ignored_small",
    "finalized",
    "submitted",
    "failed",
    "rejected",
] as const;

export const ERROR_CODES = [
    "USGS_RECENT_UNAVAILABLE",
    "USGS_DETAIL_UNAVAILABLE",
    "SHAKEMAP_PRODUCT_MISSING",
    "SHAKEMAP_CANCELLED",
    "SHAKEMAP_GRID_UNAVAILABLE",
    "SHAKEMAP_PARSE_FAILED",
    "MMI_NOT_AVAILABLE",
    "NO_AFFECTED_CELLS",
    "SOURCE_STALE",
    "SOURCE_REVISION_OLD",
    "UNSUPPORTED_HAZARD_TYPE",
    "TEE_SIGNATURE_FAILED",
    "BCS_SERIALIZATION_FAILED",
    "MERKLE_ROOT_FAILED",
    "AWS_RUNNER_TIMEOUT",
    "RELAYER_SUBMIT_FAILED",
    "MOVE_REJECTED",
    "REJECTED_AUTO_TRIGGER",
    "WATCHER_BELOW_AUTO_THRESHOLD",
] as const;

export type PayloadV1Field = (typeof PAYLOAD_V1_FIELD_ORDER)[number];
export type AffectedCellLeafField = (typeof AFFECTED_CELL_LEAF_FIELD_ORDER)[number];
export type OffchainStatus = (typeof OFFCHAIN_STATUSES)[number];
export type OracleErrorCode = (typeof ERROR_CODES)[number];

export interface DisasterOraclePayloadV1 {
    intent: number;
    oracle_version: number;
    event_uid: string;
    hazard_type: number;
    status: number;
    event_revision: number;
    occurred_at_ms: number;
    observed_at_ms: number;
    source_updated_at_ms: number;
    primary_source: number;
    severity_band: number;
    source_set_hash: string;
    raw_data_hash: string;
    raw_data_uri: string;
    affected_cells_root: string;
    affected_cells_uri: string;
    affected_cells_data_hash: string;
    geo_resolution: number;
    cells_generation_method: number;
    cell_metric: number;
    cell_aggregation: number;
    intensity_scale: number;
    max_cell_band: number;
    affected_cell_count: number;
    min_claim_band: number;
    freshness_deadline_ms: number;
}

export interface WorkerToTeeRequest {
    source_event_id: string;
    hazard_type: typeof BCS_ENUMS.hazardType.EARTHQUAKE;
    primary_source: typeof BCS_ENUMS.primarySource.USGS;
    geo_resolution: typeof DEFAULT_ORACLE_CONTRACT.geo_resolution;
}

export interface SignedFinalizedPayload {
    status: "finalized";
    payload: DisasterOraclePayloadV1 | Record<string, unknown>;
    payload_bcs_hex: string;
    signature: string;
    public_key: string;
}

export type TeeCoreResult =
    | {
          status: "pending_source";
          source_event_id: string;
          error_code: Extract<
              OracleErrorCode,
              "SHAKEMAP_PRODUCT_MISSING" | "SHAKEMAP_GRID_UNAVAILABLE"
          >;
      }
    | {
          status: "pending_mmi";
          source_event_id: string;
          error_code: Extract<OracleErrorCode, "MMI_NOT_AVAILABLE">;
      }
    | {
          status: "rejected";
          source_event_id: string;
          error_code: OracleErrorCode;
      }
    | SignedFinalizedPayload;

export type RelayerSubmitInput = SignedFinalizedPayload;

type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; error_code: string; message: string };

const WORKER_TO_TEE_KEYS = [
    "source_event_id",
    "hazard_type",
    "primary_source",
    "geo_resolution",
] as const;

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function firstUnexpectedKey(
    input: Record<string, unknown>,
    allowedKeys: readonly string[],
): string | undefined {
    return Object.keys(input).find((key) => !allowedKeys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

export function validateWorkerToTeeRequest(input: unknown): ValidationResult<WorkerToTeeRequest> {
    if (!isRecord(input)) {
        return {
            ok: false,
            error_code: "INVALID_WORKER_TEE_REQUEST",
            message: "Worker to TEE request must be an object",
        };
    }

    const unexpectedKey = firstUnexpectedKey(input, WORKER_TO_TEE_KEYS);
    if (unexpectedKey !== undefined) {
        return {
            ok: false,
            error_code: "INVALID_WORKER_TEE_REQUEST",
            message: `Unexpected Worker to TEE field: ${unexpectedKey}`,
        };
    }

    if (
        input.hazard_type !== BCS_ENUMS.hazardType.EARTHQUAKE ||
        input.primary_source !== BCS_ENUMS.primarySource.USGS ||
        input.geo_resolution !== DEFAULT_ORACLE_CONTRACT.geo_resolution ||
        !isNonEmptyString(input.source_event_id)
    ) {
        return {
            ok: false,
            error_code: "INVALID_WORKER_TEE_REQUEST",
            message: "Worker to TEE request does not match the MVP oracle input contract",
        };
    }

    return {
        ok: true,
        value: {
            source_event_id: input.source_event_id,
            hazard_type: input.hazard_type,
            primary_source: input.primary_source,
            geo_resolution: input.geo_resolution,
        },
    };
}

export function validateRelayerSubmitInput(input: unknown): ValidationResult<RelayerSubmitInput> {
    if (!isRecord(input)) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer input must be an object",
        };
    }

    if (input.status !== "finalized") {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer accepts only finalized TEE results",
        };
    }

    if (!isRecord(input.payload) || input.payload.status !== BCS_ENUMS.onchainStatus.FINALIZED) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer payload must use onchain status FINALIZED",
        };
    }

    if (
        !isNonEmptyString(input.payload_bcs_hex) ||
        !isNonEmptyString(input.signature) ||
        !isNonEmptyString(input.public_key)
    ) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer input requires BCS payload bytes, signature, and public key",
        };
    }

    return {
        ok: true,
        value: {
            status: "finalized",
            payload: input.payload,
            payload_bcs_hex: input.payload_bcs_hex,
            signature: input.signature,
            public_key: input.public_key,
        },
    };
}
