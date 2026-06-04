export const PAYLOAD_FIELD_ORDER = [
    "intent",
    "oracle_version",
    "event_uid",
    "hazard_type",
    "status",
    "event_revision",
    "source_event_id",
    "title",
    "region",
    "occurred_at_ms",
    "magnitude_x100",
    "verified_at_ms",
    "source_updated_at_ms",
    "primary_source",
    "severity_band",
    "source_set_hash",
    "raw_data_hash",
    "raw_data_uri",
    "affected_cells_root",
    "affected_cells_uri",
    "affected_cells_data_hash",
    "affected_cell_count",
    "geo_resolution",
    "cells_generation_method",
    "cell_metric",
    "cell_aggregation",
    "intensity_scale",
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
    },
    cellMetric: {
        USGS_MMI: 1,
    },
    cellAggregation: {
        GRID_POINT_P90: 1,
    },
    intensityScale: {
        MMI_X100: 1,
    },
} as const;

export const DEFAULT_ORACLE_CONTRACT = {
    oracle_version: 1,
    geo_resolution: 7,
} as const;

export const EARTHQUAKE_VERIFIER_CONFIG_KEY = 1;

export const FRESHNESS_WINDOW_MS = 21_600_000;

export const OFFCHAIN_STATUSES = [
    "new",
    "queued",
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
    "AWS_RUNNER_START_FAILED",
    "AWS_RUNNER_PROCESS_FAILED",
    "AWS_RUNNER_TIMEOUT",
    "AWS_RUNNER_CONTRACT_INVALID",
    "RELAYER_SUBMIT_FAILED",
    "MOVE_REJECTED",
    "SOURCE_ARCHIVE_CONFIGURATION_FAILED",
    "SOURCE_ARCHIVE_RETRYABLE_FAILED",
    "SOURCE_ARCHIVE_INTEGRITY_FAILED",
    "REJECTED_AUTO_TRIGGER",
    "WATCHER_BELOW_AUTO_THRESHOLD",
] as const;

export type PayloadField = (typeof PAYLOAD_FIELD_ORDER)[number];
export type AffectedCellLeafField = (typeof AFFECTED_CELL_LEAF_FIELD_ORDER)[number];
export type OffchainStatus = (typeof OFFCHAIN_STATUSES)[number];
export type OracleErrorCode = (typeof ERROR_CODES)[number];

export interface EarthquakeOraclePayload {
    intent: number;
    oracle_version: number;
    event_uid: string;
    hazard_type: number;
    status: number;
    event_revision: number;
    source_event_id: string;
    title: string;
    region: string;
    occurred_at_ms: number;
    magnitude_x100: number;
    verified_at_ms: number;
    source_updated_at_ms: number;
    primary_source: number;
    severity_band: number;
    source_set_hash: string;
    raw_data_hash: string;
    raw_data_uri: string;
    affected_cells_root: string;
    affected_cells_uri: string;
    affected_cells_data_hash: string;
    affected_cell_count: number;
    geo_resolution: number;
    cells_generation_method: number;
    cell_metric: number;
    cell_aggregation: number;
    intensity_scale: number;
    freshness_deadline_ms: number;
}

export interface WorkerToTeeRequest {
    source_event_id: string;
    hazard_type: typeof BCS_ENUMS.hazardType.EARTHQUAKE;
    primary_source: typeof BCS_ENUMS.primarySource.USGS;
    geo_resolution: typeof DEFAULT_ORACLE_CONTRACT.geo_resolution;
}

export type EarthquakeVerifierRequest = WorkerToTeeRequest;

export interface SignedFinalizedPayload {
    status: "finalized";
    payload: EarthquakeOraclePayload | Record<string, unknown>;
    payload_bcs_hex: string;
    signature: string;
    public_key: string;
    raw_data_manifest?: RawDataManifest;
    verifier_config_key?: number;
    verifier_config_version?: number;
    enclave_instance_public_key?: string;
}

export interface RawDataManifest {
    entries: RawDataEntry[];
    oracle_version: typeof DEFAULT_ORACLE_CONTRACT.oracle_version;
}

export interface RawDataEntry {
    name: string;
    event_id: string;
    product: string;
    uri: string;
    content_hash: string;
    source_uri: string;
    walrus_blob_id: string;
    source_hash: string;
    size_bytes: number;
}

export interface EnclaveVerificationMetadata {
    verifier_config_key: number;
    verifier_config_version: number;
    enclave_instance_public_key: string;
}

export type TeeCoreResult =
    | {
          status: "pending_source";
          source_event_id: string;
          error_code: Extract<
              OracleErrorCode,
              "USGS_DETAIL_UNAVAILABLE" | "SHAKEMAP_PRODUCT_MISSING" | "SHAKEMAP_GRID_UNAVAILABLE"
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

export type RelayerSubmitInput = SignedFinalizedPayload & EnclaveVerificationMetadata;

type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; error_code: string; message: string };

const WORKER_TO_TEE_KEYS = [
    "source_event_id",
    "hazard_type",
    "primary_source",
    "geo_resolution",
] as const;

const U32_MAX = 0xffff_ffff;
const ONE_MILLION = 1_000_000;
const HASH_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES_PATTERN = /^(?:0x)?[0-9a-fA-F]+$/;
const WALRUS_BLOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const textEncoder = new TextEncoder();

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

function isUtf8BytesInRange(value: unknown, min: number, max: number): value is string {
    if (typeof value !== "string") {
        return false;
    }
    const byteLength = textEncoder.encode(value).length;
    return byteLength >= min && byteLength <= max;
}

function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isHash32(value: unknown): value is string {
    return typeof value === "string" && HASH_32_PATTERN.test(value);
}

function isHexBytes(value: unknown, expectedBytes?: number): value is string {
    if (typeof value !== "string" || !HEX_BYTES_PATTERN.test(value)) {
        return false;
    }
    const normalized = value.startsWith("0x") ? value.slice(2) : value;
    if (normalized.length === 0 || normalized.length % 2 !== 0) {
        return false;
    }
    return expectedBytes === undefined || normalized.length === expectedBytes * 2;
}

function normalizeHexBytes(value: string): string {
    return value.startsWith("0x") ? value.slice(2).toLowerCase() : value.toLowerCase();
}

function hasCurrentPayloadShape(payload: Record<string, unknown>): boolean {
    const keys = Object.keys(payload);
    return (
        keys.length === PAYLOAD_FIELD_ORDER.length &&
        PAYLOAD_FIELD_ORDER.every((field, index) => keys[index] === field)
    );
}

function hasValidFinalizedPayload(payload: Record<string, unknown>): boolean {
    if (!hasCurrentPayloadShape(payload)) {
        return false;
    }

    if (
        payload.intent !== BCS_ENUMS.intent.SONARI_EARTHQUAKE_ORACLE ||
        payload.oracle_version !== DEFAULT_ORACLE_CONTRACT.oracle_version ||
        payload.hazard_type !== BCS_ENUMS.hazardType.EARTHQUAKE ||
        payload.status !== BCS_ENUMS.onchainStatus.FINALIZED ||
        payload.primary_source !== BCS_ENUMS.primarySource.USGS ||
        payload.geo_resolution !== DEFAULT_ORACLE_CONTRACT.geo_resolution ||
        payload.cells_generation_method !==
            BCS_ENUMS.cellsGenerationMethod.SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1 ||
        payload.cell_metric !== BCS_ENUMS.cellMetric.USGS_MMI ||
        payload.cell_aggregation !== BCS_ENUMS.cellAggregation.GRID_POINT_P90 ||
        payload.intensity_scale !== BCS_ENUMS.intensityScale.MMI_X100
    ) {
        return false;
    }

    if (
        !isHash32(payload.event_uid) ||
        !isHash32(payload.source_set_hash) ||
        !isHash32(payload.raw_data_hash) ||
        !isHash32(payload.affected_cells_root) ||
        !isHash32(payload.affected_cells_data_hash)
    ) {
        return false;
    }

    if (
        !isSafeIntegerInRange(payload.event_revision, 1, U32_MAX) ||
        !isUtf8BytesInRange(payload.source_event_id, 1, 96) ||
        !isUtf8BytesInRange(payload.title, 1, 160) ||
        !isUtf8BytesInRange(payload.region, 1, 160) ||
        !isSafeNonNegativeInteger(payload.occurred_at_ms) ||
        !isSafeIntegerInRange(payload.magnitude_x100, 1, 2000) ||
        !isSafeNonNegativeInteger(payload.verified_at_ms) ||
        !isSafeNonNegativeInteger(payload.source_updated_at_ms) ||
        !isSafeIntegerInRange(payload.severity_band, 1, 3) ||
        !isUtf8BytesInRange(payload.raw_data_uri, 1, 512) ||
        !isUtf8BytesInRange(payload.affected_cells_uri, 1, 512) ||
        !isSafeIntegerInRange(payload.affected_cell_count, 1, ONE_MILLION) ||
        !isSafeNonNegativeInteger(payload.freshness_deadline_ms)
    ) {
        return false;
    }

    const verifiedAtMs = payload.verified_at_ms;
    const freshnessDeadlineMs = payload.freshness_deadline_ms;
    if (!isSafeNonNegativeInteger(verifiedAtMs) || !isSafeNonNegativeInteger(freshnessDeadlineMs)) {
        return false;
    }

    return freshnessDeadlineMs === verifiedAtMs + FRESHNESS_WINDOW_MS;
}

function hasValidRawDataManifest(value: unknown): value is RawDataManifest {
    if (!isRecord(value) || value.oracle_version !== DEFAULT_ORACLE_CONTRACT.oracle_version) {
        return false;
    }
    if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 16) {
        return false;
    }
    return value.entries.every(hasValidRawDataEntry);
}

function hasValidRawDataEntry(value: unknown): value is RawDataEntry {
    if (!isRecord(value)) {
        return false;
    }
    if (
        !isUtf8BytesInRange(value.name, 1, 64) ||
        !isUtf8BytesInRange(value.event_id, 1, 96) ||
        !isUtf8BytesInRange(value.product, 1, 96) ||
        !isUtf8BytesInRange(value.source_uri, 1, 2048) ||
        !isHash32(value.source_hash) ||
        !isHash32(value.content_hash) ||
        !isSafeIntegerInRange(value.size_bytes, 1, Number.MAX_SAFE_INTEGER) ||
        typeof value.walrus_blob_id !== "string" ||
        !WALRUS_BLOB_ID_PATTERN.test(value.walrus_blob_id) ||
        typeof value.uri !== "string"
    ) {
        return false;
    }
    return (
        value.source_hash === value.content_hash &&
        value.uri === `walrus://blob/${value.walrus_blob_id}`
    );
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

export function validateEarthquakeVerifierRequest(
    input: unknown,
): ValidationResult<EarthquakeVerifierRequest> {
    return validateWorkerToTeeRequest(input);
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

    if (!hasValidFinalizedPayload(input.payload)) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer payload metadata is malformed",
        };
    }

    if (
        !isHexBytes(input.payload_bcs_hex) ||
        !isHexBytes(input.signature, 64) ||
        !isHexBytes(input.public_key, 32)
    ) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer input requires BCS payload bytes, signature, and public key",
        };
    }

    if (
        input.verifier_config_key !== EARTHQUAKE_VERIFIER_CONFIG_KEY ||
        !isSafeIntegerInRange(input.verifier_config_version, 1, Number.MAX_SAFE_INTEGER) ||
        !isHexBytes(input.enclave_instance_public_key, 32) ||
        normalizeHexBytes(input.enclave_instance_public_key) !== normalizeHexBytes(input.public_key)
    ) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer input requires Earthquake Oracle v1 enclave tracking metadata",
        };
    }

    if (
        input.raw_data_manifest !== undefined &&
        !hasValidRawDataManifest(input.raw_data_manifest)
    ) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer input raw_data_manifest is malformed",
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
            ...(input.raw_data_manifest === undefined
                ? {}
                : { raw_data_manifest: input.raw_data_manifest }),
            verifier_config_key: input.verifier_config_key,
            verifier_config_version: input.verifier_config_version,
            enclave_instance_public_key: input.enclave_instance_public_key,
        },
    };
}
