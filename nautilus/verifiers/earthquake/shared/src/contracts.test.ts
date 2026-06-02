import { describe, expect, it } from "vitest";
import {
    AFFECTED_CELL_LEAF_FIELD_ORDER,
    BCS_ENUMS,
    DEFAULT_ORACLE_CONTRACT,
    ERROR_CODES,
    OFFCHAIN_STATUSES,
    PAYLOAD_FIELD_ORDER,
    validateRelayerSubmitInput,
    validateWorkerToTeeRequest,
} from "./index.js";

const currentPayload = {
    intent: 1,
    oracle_version: 1,
    event_uid: "0x1111111111111111111111111111111111111111111111111111111111111111",
    hazard_type: 1,
    status: 3,
    event_revision: 1,
    source_event_id: "us7000sonari",
    title: "M 7.24 - Test Event",
    region: "Test Region",
    occurred_at_ms: 1_704_067_200_000,
    magnitude_x100: 724,
    verified_at_ms: 1_704_151_200_000,
    source_updated_at_ms: 1_704_151_200_000,
    primary_source: 1,
    severity_band: 3,
    source_set_hash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    raw_data_hash: "0x3333333333333333333333333333333333333333333333333333333333333333",
    raw_data_uri: "ipfs://sonari/examples/us7000sonari/raw_data_manifest.json",
    affected_cells_root: "0x4444444444444444444444444444444444444444444444444444444444444444",
    affected_cells_uri: "ipfs://sonari/examples/us7000sonari/affected_cells.json",
    affected_cells_data_hash: "0x5555555555555555555555555555555555555555555555555555555555555555",
    affected_cell_count: 2,
    geo_resolution: 7,
    cells_generation_method: 1,
    cell_metric: 1,
    cell_aggregation: 1,
    intensity_scale: 1,
    freshness_deadline_ms: 1_704_172_800_000,
} as const satisfies Record<string, unknown>;

const validPayloadBcsHex = "0x01";
const validSignature = `0x${"11".repeat(64)}`;
const validPublicKey = `0x${"22".repeat(32)}`;
const finalizedRelayerInput = {
    status: "finalized",
    payload: currentPayload,
    payload_bcs_hex: validPayloadBcsHex,
    signature: validSignature,
    public_key: validPublicKey,
    verifier_config_key: 1,
    verifier_config_version: 1,
    enclave_instance_public_key: validPublicKey,
} as const;

const validRawDataManifest = {
    entries: [
        {
            name: "USGS",
            event_id: "us7000sonari",
            product: "detail_geojson",
            uri: "walrus://blob/testBlob_123456",
            content_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            source_uri:
                "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000sonari.geojson",
            walrus_blob_id: "testBlob_123456",
            source_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            size_bytes: 1234,
        },
    ],
    oracle_version: 1,
} as const;

describe("oracle schema contracts", () => {
    it("keeps current payload field order aligned with the root schema", () => {
        expect(PAYLOAD_FIELD_ORDER).toEqual([
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
        ]);
        expect(PAYLOAD_FIELD_ORDER).toHaveLength(28);
        expect(Object.keys(currentPayload)).toEqual(PAYLOAD_FIELD_ORDER);
    });

    it("keeps affected cell leaf field order aligned with the root schema", () => {
        expect(AFFECTED_CELL_LEAF_FIELD_ORDER).toEqual([
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
        ]);
        expect(AFFECTED_CELL_LEAF_FIELD_ORDER).toHaveLength(10);
    });

    it("pins numeric enum and default values used by the current BCS payload", () => {
        expect(BCS_ENUMS.intent.SONARI_EARTHQUAKE_ORACLE).toBe(currentPayload.intent);
        expect(BCS_ENUMS.hazardType.EARTHQUAKE).toBe(currentPayload.hazard_type);
        expect(BCS_ENUMS.onchainStatus.FINALIZED).toBe(currentPayload.status);
        expect(BCS_ENUMS.primarySource.USGS).toBe(currentPayload.primary_source);
        expect(BCS_ENUMS.cellsGenerationMethod.SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1).toBe(
            currentPayload.cells_generation_method,
        );
        expect(BCS_ENUMS.cellMetric.USGS_MMI).toBe(currentPayload.cell_metric);
        expect(BCS_ENUMS.cellAggregation.GRID_POINT_P90).toBe(currentPayload.cell_aggregation);
        expect(BCS_ENUMS.intensityScale.MMI_X100).toBe(currentPayload.intensity_scale);

        expect(DEFAULT_ORACLE_CONTRACT.oracle_version).toBe(1);
        expect(DEFAULT_ORACLE_CONTRACT.geo_resolution).toBe(7);
    });

    it("pins offchain status and error code contracts for offchain state", () => {
        expect(OFFCHAIN_STATUSES).toEqual([
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
        ]);
        expect(ERROR_CODES).toEqual([
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
            "SOURCE_ARCHIVE_RETRYABLE_FAILED",
            "SOURCE_ARCHIVE_INTEGRITY_FAILED",
            "REJECTED_AUTO_TRIGGER",
            "WATCHER_BELOW_AUTO_THRESHOLD",
        ]);
    });
});

describe("oracle boundary validators", () => {
    it("accepts only minimal Worker to TEE requests", () => {
        expect(
            validateWorkerToTeeRequest({
                source_event_id: "us7000sonari",
                hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
                primary_source: BCS_ENUMS.primarySource.USGS,
                geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
            }),
        ).toEqual({
            ok: true,
            value: {
                source_event_id: "us7000sonari",
                hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
                primary_source: BCS_ENUMS.primarySource.USGS,
                geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
            },
        });
    });

    it("rejects Worker attempts to pass trusted TEE-derived values", () => {
        for (const forbiddenKey of [
            "request_type",
            "context",
            "deadline",
            "retry",
            "severity_band",
            "max_cell_band",
            "cell_band",
            "cell_metric",
            "intensity_scale",
            "source_set_hash",
            "root",
            "raw_data_hash",
            "affected_cells_root",
            "payload",
            "payload_bcs_hex",
            "signature",
            "public_key",
            "hash",
            "magnitude",
            "summary_mmi",
            "alert",
            "tsunami",
        ]) {
            const result = validateWorkerToTeeRequest({
                source_event_id: "us7000sonari",
                hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
                primary_source: BCS_ENUMS.primarySource.USGS,
                geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
                [forbiddenKey]: "untrusted",
            });

            expect(result).toEqual({
                ok: false,
                error_code: "INVALID_WORKER_TEE_REQUEST",
                message: `Unexpected Worker to TEE field: ${forbiddenKey}`,
            });
        }
    });

    it("accepts only finalized signed payloads for relayer submission", () => {
        expect(validateRelayerSubmitInput(finalizedRelayerInput)).toEqual({
            ok: true,
            value: {
                status: "finalized",
                payload: currentPayload,
                payload_bcs_hex: validPayloadBcsHex,
                signature: validSignature,
                public_key: validPublicKey,
                verifier_config_key: 1,
                verifier_config_version: 1,
                enclave_instance_public_key: validPublicKey,
            },
        });

        expect(
            validateRelayerSubmitInput({
                ...finalizedRelayerInput,
                status: "pending_mmi",
            }),
        ).toMatchObject({ ok: false, error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD" });
    });

    it("accepts a finalized raw data manifest without adding it to the payload field order", () => {
        expect(
            validateRelayerSubmitInput({
                ...finalizedRelayerInput,
                raw_data_manifest: validRawDataManifest,
            }),
        ).toEqual({
            ok: true,
            value: {
                ...finalizedRelayerInput,
                raw_data_manifest: validRawDataManifest,
            },
        });
        expect(Object.keys(currentPayload)).toEqual(PAYLOAD_FIELD_ORDER);
    });

    it("rejects malformed raw data manifest references", () => {
        for (const entryPatch of [
            { source_hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
            { uri: "walrus://blob/otherBlob_123456" },
            { walrus_blob_id: "" },
            { source_uri: "" },
            { size_bytes: 0 },
            { size_bytes: 1.5 },
        ]) {
            expect(
                validateRelayerSubmitInput({
                    ...finalizedRelayerInput,
                    raw_data_manifest: {
                        ...validRawDataManifest,
                        entries: [{ ...validRawDataManifest.entries[0], ...entryPatch }],
                    },
                }),
            ).toMatchObject({
                ok: false,
                error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            });
        }
    });

    it("rejects malformed finalized payload metadata", () => {
        for (const payloadPatch of [
            { event_uid: "" },
            { event_revision: 0 },
            { source_event_id: "" },
            { source_event_id: "x".repeat(97) },
            { title: "" },
            { title: "x".repeat(161) },
            { region: "" },
            { region: "x".repeat(161) },
            { magnitude_x100: 0 },
            { magnitude_x100: 2001 },
            { severity_band: 0 },
            { severity_band: 4 },
            { raw_data_uri: "" },
            { raw_data_uri: "x".repeat(513) },
            { affected_cells_uri: "" },
            { affected_cells_uri: "x".repeat(513) },
            { affected_cell_count: 0 },
            { affected_cell_count: 1_000_001 },
            { freshness_deadline_ms: currentPayload.verified_at_ms },
            { event_revision: 1.5 },
            { event_revision: Number.MAX_SAFE_INTEGER + 1 },
            { source_updated_at_ms: 1_700_000_000_000.5 },
            { source_updated_at_ms: Number.MAX_SAFE_INTEGER + 1 },
        ]) {
            expect(
                validateRelayerSubmitInput({
                    ...finalizedRelayerInput,
                    payload: { ...currentPayload, ...payloadPatch },
                }),
            ).toMatchObject({
                ok: false,
                error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            });
        }
    });

    it("rejects missing or malformed enclave tracking metadata", () => {
        for (const patch of [
            { payload_bcs_hex: "" },
            { payload_bcs_hex: "0x0" },
            { payload_bcs_hex: "0xzz" },
            { signature: "" },
            { signature: `0x${"11".repeat(63)}` },
            { public_key: "" },
            { public_key: `0x${"22".repeat(31)}` },
            { verifier_config_key: undefined },
            { verifier_config_key: 0 },
            { verifier_config_key: 2 },
            { verifier_config_key: 1.5 },
            { verifier_config_version: undefined },
            { verifier_config_version: 0 },
            { verifier_config_version: 1.5 },
            { enclave_instance_public_key: "" },
            { enclave_instance_public_key: `0x${"22".repeat(31)}` },
            { enclave_instance_public_key: `0x${"33".repeat(32)}` },
        ]) {
            expect(
                validateRelayerSubmitInput({
                    ...finalizedRelayerInput,
                    ...patch,
                }),
            ).toMatchObject({
                ok: false,
                error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD",
            });
        }
    });
});
