import { createHash } from "node:crypto";

export const PAYLOAD_FIELD_ORDER = [
    "intent",
    "oracle_version",
    "event_uid",
    "event_revision",
    "source_event_id",
    "title",
    "region",
    "occurred_at_ms",
    "hazard_type",
    "status",
    "severity_band",
    "affected_cells_root",
    "affected_cell_count",
    "evidence_manifest_uri",
    "evidence_manifest_hash",
    "verified_at_ms",
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
        SHAKEMAP_GRIDXML_H3_CENTER_BILINEAR_V1: 3,
    },
    cellMetric: {
        USGS_MMI: 1,
    },
    cellAggregation: {
        GRID_POINT_P90: 1,
        H3_CENTER_BILINEAR: 2,
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
    event_revision: number;
    source_event_id: string;
    title: string;
    region: string;
    occurred_at_ms: number;
    hazard_type: number;
    status: number;
    severity_band: number;
    affected_cells_root: string;
    affected_cell_count: number;
    evidence_manifest_uri: string;
    evidence_manifest_hash: string;
    verified_at_ms: number;
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
    affected_cells?: AffectedCellsArtifact;
    evidence_manifest?: EvidenceManifest;
    affected_cells_ref?: StoredSourceRef;
    evidence_manifest_ref?: StoredSourceRef;
    expected_hashes?: Record<string, unknown>;
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

export interface StoredSourceRef {
    uri: string;
    walrus_blob_id: string;
    source_hash: string;
    size_bytes: number;
}

export interface AffectedCellsArtifact {
    event_uid: string;
    event_revision: number;
    oracle_version: number;
    geo_resolution: number;
    cells_generation_method: string;
    cell_metric: string;
    cell_aggregation: string;
    intensity_scale: string;
    affected_cells: Array<{
        h3_index: string;
        intensity_value: number;
        cell_band: number;
    }>;
}

export interface EvidenceManifest {
    schema_version: number;
    oracle_version: number;
    event_uid: string;
    event_revision: number;
    hazard_type: string;
    source_event_id: string;
    sources: Array<{
        source: string;
        product: string;
        source_uri: string;
        artifact_uri: string;
        content_hash: string;
        size_bytes: number;
        source_updated_at_ms: number;
    }>;
    earthquake: {
        title: string;
        region: string;
        occurred_at_ms: number;
        magnitude_x100: number;
        source_updated_at_ms: number;
    };
    affected_cells: {
        uri: string;
        hash: string;
        root: string;
        count: number;
        geo_resolution: number;
    };
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

function isWalrusUriForBlobId(uri: unknown, blobId: unknown): boolean {
    return (
        typeof uri === "string" && typeof blobId === "string" && uri === `walrus://blob/${blobId}`
    );
}

function isPayloadArtifactUri(value: unknown): value is string {
    return (
        typeof value === "string" &&
        (value.startsWith("walrus://blob/") || value.startsWith("ipfs://sonari/examples/"))
    );
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
        payload.status !== BCS_ENUMS.onchainStatus.FINALIZED
    ) {
        return false;
    }

    if (
        !isHash32(payload.event_uid) ||
        !isHash32(payload.affected_cells_root) ||
        !isHash32(payload.evidence_manifest_hash)
    ) {
        return false;
    }

    if (
        !isSafeIntegerInRange(payload.event_revision, 1, U32_MAX) ||
        !isUtf8BytesInRange(payload.source_event_id, 1, 96) ||
        !isUtf8BytesInRange(payload.title, 1, 160) ||
        !isUtf8BytesInRange(payload.region, 1, 160) ||
        !isSafeNonNegativeInteger(payload.occurred_at_ms) ||
        !isSafeIntegerInRange(payload.severity_band, 1, 3) ||
        !isSafeIntegerInRange(payload.affected_cell_count, 1, ONE_MILLION) ||
        !isUtf8BytesInRange(payload.evidence_manifest_uri, 1, 512) ||
        !isPayloadArtifactUri(payload.evidence_manifest_uri) ||
        !isSafeNonNegativeInteger(payload.verified_at_ms) ||
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

function hasValidStoredSourceRef(value: unknown): value is StoredSourceRef {
    if (!isRecord(value)) {
        return false;
    }
    return (
        typeof value.walrus_blob_id === "string" &&
        WALRUS_BLOB_ID_PATTERN.test(value.walrus_blob_id) &&
        isWalrusUriForBlobId(value.uri, value.walrus_blob_id) &&
        isHash32(value.source_hash) &&
        isSafeIntegerInRange(value.size_bytes, 1, Number.MAX_SAFE_INTEGER)
    );
}

function hasValidAffectedCellsArtifact(value: unknown): value is AffectedCellsArtifact {
    if (
        !isRecord(value) ||
        !isHash32(value.event_uid) ||
        !isSafeIntegerInRange(value.event_revision, 1, U32_MAX) ||
        value.oracle_version !== DEFAULT_ORACLE_CONTRACT.oracle_version ||
        value.geo_resolution !== DEFAULT_ORACLE_CONTRACT.geo_resolution ||
        !isUtf8BytesInRange(value.cells_generation_method, 1, 96) ||
        !isUtf8BytesInRange(value.cell_metric, 1, 64) ||
        !isUtf8BytesInRange(value.cell_aggregation, 1, 64) ||
        !isUtf8BytesInRange(value.intensity_scale, 1, 64) ||
        !Array.isArray(value.affected_cells) ||
        value.affected_cells.length === 0 ||
        value.affected_cells.length > ONE_MILLION
    ) {
        return false;
    }
    return value.affected_cells.every(
        (cell) =>
            isRecord(cell) &&
            isUtf8BytesInRange(cell.h3_index, 1, 32) &&
            isSafeIntegerInRange(cell.intensity_value, 0, 20_000) &&
            isSafeIntegerInRange(cell.cell_band, 1, 3),
    );
}

function hasValidEvidenceManifest(value: unknown): value is EvidenceManifest {
    if (
        !isRecord(value) ||
        value.schema_version !== 1 ||
        value.oracle_version !== DEFAULT_ORACLE_CONTRACT.oracle_version ||
        !isHash32(value.event_uid) ||
        !isSafeIntegerInRange(value.event_revision, 1, U32_MAX) ||
        value.hazard_type !== "EARTHQUAKE" ||
        !isUtf8BytesInRange(value.source_event_id, 1, 96) ||
        !Array.isArray(value.sources) ||
        value.sources.length === 0 ||
        value.sources.length > 16 ||
        !hasValidEarthquakeEvidence(value.earthquake) ||
        !hasValidEvidenceAffectedCells(value.affected_cells)
    ) {
        return false;
    }
    return value.sources.every(hasValidEvidenceSource);
}

function hasValidEvidenceSource(value: unknown): boolean {
    return (
        isRecord(value) &&
        isUtf8BytesInRange(value.source, 1, 64) &&
        isUtf8BytesInRange(value.product, 1, 96) &&
        isUtf8BytesInRange(value.source_uri, 1, 2048) &&
        isUtf8BytesInRange(value.artifact_uri, 1, 512) &&
        isHash32(value.content_hash) &&
        isSafeIntegerInRange(value.size_bytes, 1, Number.MAX_SAFE_INTEGER) &&
        isSafeNonNegativeInteger(value.source_updated_at_ms)
    );
}

function hasValidEarthquakeEvidence(value: unknown): boolean {
    return (
        isRecord(value) &&
        isUtf8BytesInRange(value.title, 1, 160) &&
        isUtf8BytesInRange(value.region, 1, 160) &&
        isSafeNonNegativeInteger(value.occurred_at_ms) &&
        isSafeIntegerInRange(value.magnitude_x100, 1, 2000) &&
        isSafeNonNegativeInteger(value.source_updated_at_ms)
    );
}

function hasValidEvidenceAffectedCells(value: unknown): boolean {
    return (
        isRecord(value) &&
        typeof value.uri === "string" &&
        value.uri.startsWith("walrus://blob/") &&
        isHash32(value.hash) &&
        isHash32(value.root) &&
        isSafeIntegerInRange(value.count, 1, ONE_MILLION) &&
        value.geo_resolution === DEFAULT_ORACLE_CONTRACT.geo_resolution
    );
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
        isWalrusUriForBlobId(value.uri, value.walrus_blob_id)
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

export function encodeEarthquakeOraclePayloadBcsHex(payload: EarthquakeOraclePayload): string {
    return `0x${bytesToHex(encodeEarthquakeOraclePayloadBcsBytes(payload))}`;
}

export function encodeEarthquakeOraclePayloadBcsBytes(
    payload: EarthquakeOraclePayload,
): Uint8Array {
    return concatBytes([
        u8(payload.intent),
        u64(payload.oracle_version),
        hexBytes32(payload.event_uid),
        u32(payload.event_revision),
        utf8Vector(payload.source_event_id),
        utf8Vector(payload.title),
        utf8Vector(payload.region),
        u64(payload.occurred_at_ms),
        u8(payload.hazard_type),
        u8(payload.status),
        u8(payload.severity_band),
        hexBytes32(payload.affected_cells_root),
        u64(payload.affected_cell_count),
        utf8Vector(payload.evidence_manifest_uri),
        hexBytes32(payload.evidence_manifest_hash),
        u64(payload.verified_at_ms),
        u64(payload.freshness_deadline_ms),
    ]);
}

export function computeAffectedCellsRootHex(affected: AffectedCellsArtifact): string | null {
    const leafHashes: Uint8Array[] = [];
    let previousH3: bigint | null = null;
    const cellsGenerationMethod = cellsGenerationMethodId(affected.cells_generation_method);
    if (cellsGenerationMethod === null) {
        return null;
    }
    for (const cell of affected.affected_cells) {
        const h3Index = parseCanonicalU64Decimal(cell.h3_index);
        if (h3Index === null || (previousH3 !== null && h3Index <= previousH3)) {
            return null;
        }
        previousH3 = h3Index;
        leafHashes.push(
            sha256Bytes(
                concatBytes([
                    u8(0),
                    hexBytes32(affected.event_uid),
                    u32(affected.event_revision),
                    u64BigInt(h3Index),
                    u8(affected.geo_resolution),
                    u8(BCS_ENUMS.cellMetric.USGS_MMI),
                    u16(cell.intensity_value),
                    u8(BCS_ENUMS.intensityScale.MMI_X100),
                    u8(cell.cell_band),
                    u8(cellsGenerationMethod),
                    u64(affected.oracle_version),
                ]),
            ),
        );
    }

    if (leafHashes.length === 0) {
        return null;
    }

    let level = leafHashes;
    while (level.length > 1) {
        const next: Uint8Array[] = [];
        for (let index = 0; index < level.length; index += 2) {
            const left = level[index];
            const right = level[index + 1];
            if (left === undefined) {
                return null;
            }
            if (right === undefined) {
                next.push(left);
                continue;
            }
            next.push(sha256Bytes(concatBytes([u8(1), left, right])));
        }
        level = next;
    }

    const root = level[0];
    return root === undefined ? null : `0x${bytesToHex(root)}`;
}

function cellsGenerationMethodId(value: string): number | null {
    switch (value) {
        case "shakemap_gridxml_h3_grid_point_p90_v1":
            return BCS_ENUMS.cellsGenerationMethod.SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1;
        case "shakemap_hdf_h3_area_weighted_p90_v1":
            return BCS_ENUMS.cellsGenerationMethod.SHAKEMAP_HDF_H3_WEIGHTED_P90_V1;
        case "shakemap_gridxml_h3_center_bilinear_v1":
            return BCS_ENUMS.cellsGenerationMethod.SHAKEMAP_GRIDXML_H3_CENTER_BILINEAR_V1;
        default:
            return null;
    }
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

    const encodedPayloadBcsHex = encodeEarthquakeOraclePayloadBcsHex(
        input.payload as unknown as EarthquakeOraclePayload,
    );
    if (normalizeHexBytes(input.payload_bcs_hex) !== normalizeHexBytes(encodedPayloadBcsHex)) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer payload_bcs_hex does not match payload",
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

    if (
        input.affected_cells !== undefined &&
        !hasValidAffectedCellsArtifact(input.affected_cells)
    ) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer input affected_cells is malformed",
        };
    }

    if (
        input.evidence_manifest !== undefined &&
        !hasValidEvidenceManifest(input.evidence_manifest)
    ) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer input evidence_manifest is malformed",
        };
    }

    if (
        input.affected_cells_ref !== undefined &&
        !hasValidStoredSourceRef(input.affected_cells_ref)
    ) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer input affected_cells_ref is malformed",
        };
    }

    if (
        input.evidence_manifest_ref !== undefined &&
        !hasValidStoredSourceRef(input.evidence_manifest_ref)
    ) {
        return {
            ok: false,
            error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            message: "Relayer input evidence_manifest_ref is malformed",
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
            ...(input.affected_cells === undefined ? {} : { affected_cells: input.affected_cells }),
            ...(input.evidence_manifest === undefined
                ? {}
                : { evidence_manifest: input.evidence_manifest }),
            ...(input.affected_cells_ref === undefined
                ? {}
                : { affected_cells_ref: input.affected_cells_ref }),
            ...(input.evidence_manifest_ref === undefined
                ? {}
                : { evidence_manifest_ref: input.evidence_manifest_ref }),
            ...(isRecord(input.expected_hashes) ? { expected_hashes: input.expected_hashes } : {}),
            verifier_config_key: input.verifier_config_key,
            verifier_config_version: input.verifier_config_version,
            enclave_instance_public_key: input.enclave_instance_public_key,
        },
    };
}

function u8(value: number): Uint8Array {
    return Uint8Array.of(value);
}

function u32(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
}

function u16(value: number): Uint8Array {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return bytes;
}

function u64(value: number): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    return bytes;
}

function u64BigInt(value: bigint): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}

function utf8Vector(value: string): Uint8Array {
    const bytes = textEncoder.encode(value);
    return concatBytes([uleb128(bytes.byteLength), bytes]);
}

function uleb128(value: number): Uint8Array {
    const bytes: number[] = [];
    let remaining = value;
    do {
        let byte = remaining & 0x7f;
        remaining = Math.floor(remaining / 128);
        if (remaining > 0) {
            byte |= 0x80;
        }
        bytes.push(byte);
    } while (remaining > 0);
    return Uint8Array.from(bytes);
}

function hexBytes32(value: string): Uint8Array {
    const normalized = normalizeHexBytes(value);
    if (normalized.length !== 64) {
        throw new Error("expected 32-byte hex value");
    }
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
    const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function parseCanonicalU64Decimal(value: string): bigint | null {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        return null;
    }
    const parsed = BigInt(value);
    return parsed <= 0xffff_ffff_ffff_ffffn ? parsed : null;
}
