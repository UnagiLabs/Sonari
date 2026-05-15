import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AFFECTED_CELL_LEAF_FIELD_ORDER,
  BCS_ENUMS,
  DEFAULT_ORACLE_CONTRACT,
  ERROR_CODES,
  OFFCHAIN_STATUSES,
  PAYLOAD_V1_FIELD_ORDER,
  validateRelayerSubmitInput,
  validateWorkerToTeeRequest,
} from "./index.js";

const unsignedPayload = JSON.parse(
  readFileSync(
    new URL("../../../schemas/examples/unsigned_payload_v1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

describe("oracle schema contracts", () => {
  it("keeps payload v1 field order aligned with the root schema", () => {
    expect(PAYLOAD_V1_FIELD_ORDER).toEqual([
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
    ]);
    expect(PAYLOAD_V1_FIELD_ORDER).toHaveLength(26);
    expect(Object.keys(unsignedPayload)).toEqual(PAYLOAD_V1_FIELD_ORDER);
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

  it("pins numeric enum and default values used by BCS payload v1", () => {
    expect(BCS_ENUMS.intent.SONARI_EARTHQUAKE_ORACLE).toBe(unsignedPayload.intent);
    expect(BCS_ENUMS.hazardType.EARTHQUAKE).toBe(unsignedPayload.hazard_type);
    expect(BCS_ENUMS.onchainStatus.FINALIZED).toBe(unsignedPayload.status);
    expect(BCS_ENUMS.primarySource.USGS).toBe(unsignedPayload.primary_source);
    expect(BCS_ENUMS.cellsGenerationMethod.SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1).toBe(
      unsignedPayload.cells_generation_method,
    );
    expect(BCS_ENUMS.cellMetric.USGS_MMI).toBe(unsignedPayload.cell_metric);
    expect(BCS_ENUMS.cellAggregation.GRID_POINT_P90).toBe(unsignedPayload.cell_aggregation);
    expect(BCS_ENUMS.intensityScale.MMI_X100).toBe(unsignedPayload.intensity_scale);

    expect(DEFAULT_ORACLE_CONTRACT.oracle_version).toBe(1);
    expect(DEFAULT_ORACLE_CONTRACT.geo_resolution).toBe(7);
    expect(DEFAULT_ORACLE_CONTRACT.min_claim_band).toBe(1);
  });

  it("pins offchain status and error code contracts for D1 state", () => {
    expect(OFFCHAIN_STATUSES).toEqual([
      "new",
      "processing",
      "pending_source",
      "pending_mmi",
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
      "AWS_RUNNER_TIMEOUT",
      "RELAYER_SUBMIT_FAILED",
      "MOVE_REJECTED",
      "REJECTED_AUTO_TRIGGER",
    ]);
  });
});

describe("oracle boundary validators", () => {
  it("accepts only minimal Worker to TEE requests", () => {
    expect(
      validateWorkerToTeeRequest({
        request_type: "DETECT_BY_EVENT_ID",
        hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
        primary_source: BCS_ENUMS.primarySource.USGS,
        source_event_id: "us7000sonari",
        geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
      }),
    ).toEqual({
      ok: true,
      value: {
        request_type: "DETECT_BY_EVENT_ID",
        hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
        primary_source: BCS_ENUMS.primarySource.USGS,
        source_event_id: "us7000sonari",
        geo_resolution: DEFAULT_ORACLE_CONTRACT.geo_resolution,
      },
    });
  });

  it("rejects Worker attempts to pass trusted TEE-derived values", () => {
    for (const forbiddenKey of [
      "severity_band",
      "max_cell_band",
      "cell_metric",
      "intensity_scale",
      "source_set_hash",
      "raw_data_hash",
      "affected_cells_root",
      "payload",
      "signature",
    ]) {
      const result = validateWorkerToTeeRequest({
        request_type: "DETECT_BY_EVENT_ID",
        hazard_type: BCS_ENUMS.hazardType.EARTHQUAKE,
        primary_source: BCS_ENUMS.primarySource.USGS,
        source_event_id: "us7000sonari",
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
    expect(
      validateRelayerSubmitInput({
        status: "finalized",
        payload: unsignedPayload,
        payload_bcs_hex: "0x01",
        signature: "0xsig",
        public_key: "0xpub",
      }),
    ).toEqual({
      ok: true,
      value: {
        status: "finalized",
        payload: unsignedPayload,
        payload_bcs_hex: "0x01",
        signature: "0xsig",
        public_key: "0xpub",
      },
    });

    expect(
      validateRelayerSubmitInput({
        status: "pending_mmi",
        payload: unsignedPayload,
        payload_bcs_hex: "0x01",
        signature: "0xsig",
        public_key: "0xpub",
      }),
    ).toMatchObject({ ok: false, error_code: "RELAYER_REQUIRES_FINALIZED_PAYLOAD" });
  });
});
