#!/usr/bin/env python3
from __future__ import annotations

import json
import math
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import struct
import sys
from hashlib import sha256
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = ROOT / "nautilus" / "verifiers" / "earthquake" / "fixtures"

CASES = {
    "usgs/finalized_minimal": {
        "status": "finalized",
        "error_code": None,
        "grid_required": True,
    },
    "usgs/great_tohoku_2011": {
        "status": "finalized",
        "error_code": None,
        "grid_required": True,
    },
    "usgs/noto_peninsula_2024": {
        "status": "finalized",
        "error_code": None,
        "grid_required": True,
    },
    "usgs/pending_source_no_shakemap": {
        "status": "pending_source",
        "error_code": "SHAKEMAP_PRODUCT_MISSING",
        "grid_required": False,
    },
    "usgs/pending_mmi_empty_grid": {
        "status": "pending_mmi",
        "error_code": "MMI_NOT_AVAILABLE",
        "grid_required": True,
    },
    "usgs/rejected_cancelled_shakemap": {
        "status": "rejected",
        "error_code": "SHAKEMAP_CANCELLED",
        "grid_required": False,
    },
    "usgs/rejected_no_affected_cells": {
        "status": "rejected",
        "error_code": "NO_AFFECTED_CELLS",
        "grid_required": True,
    },
}

FINALIZED_ONLY_FILES = {
    "unsigned_payload.json",
    "affected_cells.json",
    "sample_proof.json",
    "source_manifest.json",
    "raw_data_manifest.json",
    "evidence_manifest.json",
    "expected_hashes.json",
}

FORBIDDEN_NON_FINALIZED_FIELDS = {
    "expected_payload",
    "payload",
    "signature",
    "payload_hash",
    "affected_cells_root",
    "affected_cells_data_hash",
    "evidence_manifest_hash",
    "evidence_manifest_uri",
    "raw_data_hash",
    "source_set_hash",
    "unsigned_bcs_payload_hex",
}

SOURCE_ORDER = ["sources", "cells_generation_method", "oracle_version"]
SOURCE_ENTRY_ORDER = [
    "name",
    "event_id",
    "product",
    "product_version",
    "map_status",
    "updated_at_ms",
    "url_hash",
]
RAW_ORDER = ["entries", "oracle_version"]
RAW_ENTRY_ORDER = [
    "name",
    "event_id",
    "product",
    "uri",
    "content_hash",
    "source_uri",
    "walrus_blob_id",
    "source_hash",
    "size_bytes",
]
AFFECTED_ORDER = [
    "event_uid",
    "event_revision",
    "oracle_version",
    "geo_resolution",
    "cells_generation_method",
    "cell_metric",
    "cell_aggregation",
    "intensity_scale",
    "affected_cells",
]
AFFECTED_CELL_ORDER = ["h3_index", "intensity_value", "cell_band"]
EVIDENCE_ORDER = [
    "schema_version",
    "oracle_version",
    "event_uid",
    "event_revision",
    "hazard_type",
    "source_event_id",
    "sources",
    "earthquake",
    "affected_cells",
]
EVIDENCE_SOURCE_ORDER = [
    "source",
    "product",
    "source_uri",
    "artifact_uri",
    "content_hash",
    "size_bytes",
    "source_updated_at_ms",
]
EVIDENCE_EARTHQUAKE_ORDER = [
    "title",
    "region",
    "occurred_at_ms",
    "magnitude_x100",
    "source_updated_at_ms",
]
EVIDENCE_AFFECTED_ORDER = [
    "uri",
    "hash",
    "root",
    "count",
    "geo_resolution",
]

CELLS_GENERATION_METHOD = {
    "shakemap_gridxml_h3_grid_point_p90_v1": 1,
    "shakemap_hdf_h3_area_weighted_p90_v1": 2,
    "shakemap_gridxml_h3_center_bilinear_v1": 3,
}
CELL_METRIC = {"USGS_MMI": 1}
INTENSITY_SCALE = {"MMI_X100": 1}
FRESHNESS_WINDOW_MS = 21_600_000
PAYLOAD_FIELD_ORDER = [
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
]
OLD_PAYLOAD_FIELDS = {
    "magnitude_x100",
    "source_updated_at_ms",
    "primary_source",
    "source_set_hash",
    "raw_data_hash",
    "raw_data_uri",
    "affected_cells_uri",
    "affected_cells_data_hash",
    "geo_resolution",
    "cells_generation_method",
    "cell_metric",
    "cell_aggregation",
    "intensity_scale",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def detail_products(detail: dict[str, Any]) -> dict[str, Any]:
    properties = detail.get("properties")
    if not isinstance(properties, dict):
        fail("USGS detail properties must be an object")
    products = properties.get("products")
    if not isinstance(products, dict):
        fail("USGS detail properties.products must be an object")
    return products


def get_shakemap_products(detail: dict[str, Any]) -> list[dict[str, Any]]:
    shakemap = detail_products(detail).get("shakemap", [])
    if not isinstance(shakemap, list):
        fail("USGS detail properties.products.shakemap must be an array")
    if not all(isinstance(product, dict) for product in shakemap):
        fail("USGS detail shakemap products must be objects")
    return shakemap


def grid_data_text(grid_path: Path) -> str:
    root = ElementTree.fromstring(grid_path.read_text(encoding="utf-8"))
    grid_data = root.find(".//grid_data")
    if grid_data is None:
        fail(f"{grid_path}: missing grid_data element")
    return grid_data.text or ""


def grid_mmi_values(grid_path: Path) -> list[float]:
    text = grid_data_text(grid_path).strip()
    if not text:
        return []
    tokens = text.split()
    if len(tokens) % 3 != 0:
        fail(f"{grid_path}: grid_data must contain lon lat mmi triples")
    values: list[float] = []
    for index in range(2, len(tokens), 3):
        try:
            value = float(tokens[index])
        except ValueError as exc:
            raise ValueError(f"{grid_path}: invalid MMI value {tokens[index]!r}") from exc
        if not math.isfinite(value):
            fail(f"{grid_path}: MMI value must be finite")
        values.append(value)
    return values


def hx(data: bytes) -> str:
    return "0x" + data.hex()


def sha256_hex(data: bytes) -> str:
    return hx(sha256(data).digest())


def hex_bytes(value: str) -> bytes:
    if not isinstance(value, str) or not value.startswith("0x") or len(value) != 66:
        raise ValueError(f"expected 0x-prefixed 32-byte hash, got {value!r}")
    return bytes.fromhex(value[2:])


def ordered(value: Any, order: list[str], item_order: list[str] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in order:
        item = value[key]
        if isinstance(item, list) and item_order is not None:
            out[key] = [ordered(child, item_order) for child in item]
        else:
            out[key] = item
    return out


def canonical_json_bytes(value: Any, order: list[str], item_order: list[str] | None = None) -> bytes:
    return json.dumps(
        ordered(value, order, item_order),
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def canonical_evidence_manifest_bytes(value: dict[str, Any]) -> bytes:
    ordered_value = ordered(value, EVIDENCE_ORDER)
    ordered_value["sources"] = [
        ordered(source, EVIDENCE_SOURCE_ORDER) for source in value["sources"]
    ]
    ordered_value["earthquake"] = ordered(value["earthquake"], EVIDENCE_EARTHQUAKE_ORDER)
    ordered_value["affected_cells"] = ordered(
        value["affected_cells"], EVIDENCE_AFFECTED_ORDER
    )
    return json.dumps(
        ordered_value,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def uleb128(value: int) -> bytes:
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def bcs_u8(value: int) -> bytes:
    return struct.pack("<B", value)


def bcs_u16(value: int) -> bytes:
    return struct.pack("<H", value)


def bcs_u32(value: int) -> bytes:
    return struct.pack("<I", value)


def bcs_u64(value: int) -> bytes:
    return struct.pack("<Q", value)


def bcs_vec_u8(value: str) -> bytes:
    data = value.encode("utf-8")
    return uleb128(len(data)) + data


def magnitude_x100(value: Any) -> int:
    if isinstance(value, bool) or value is None:
        fail("USGS properties.mag must be a decimal number")
    try:
        decimal = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("USGS properties.mag must be a decimal number") from exc
    if not decimal.is_finite():
        fail("USGS properties.mag must be finite")
    return int((decimal * Decimal(100)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def require_utf8_len(case_id: str, payload: dict[str, Any], field: str, minimum: int, maximum: int) -> None:
    value = payload.get(field)
    if not isinstance(value, str):
        fail(f"{case_id}: payload.{field} must be a string")
    length = len(value.encode("utf-8"))
    if length < minimum or length > maximum:
        fail(f"{case_id}: payload.{field} must be {minimum}..{maximum} UTF-8 bytes")


def require_int_range(case_id: str, payload: dict[str, Any], field: str, minimum: int, maximum: int) -> None:
    value = payload.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
        fail(f"{case_id}: payload.{field} must be an integer in {minimum}..{maximum}")


def validate_current_payload_contract(case_id: str, payload: dict[str, Any]) -> None:
    old_fields = sorted(OLD_PAYLOAD_FIELDS.intersection(payload))
    if old_fields:
        fail(f"{case_id}: payload contains removed signed fields: {', '.join(old_fields)}")
    if list(payload.keys()) != PAYLOAD_FIELD_ORDER:
        fail(f"{case_id}: payload field order must match current 17-field contract")
    for field in [
        "event_uid",
        "affected_cells_root",
        "evidence_manifest_hash",
    ]:
        hex_bytes(payload[field])
    expected_enums = {
        "intent": 1,
        "oracle_version": 1,
        "hazard_type": 1,
        "status": 3,
    }
    for field, expected in expected_enums.items():
        if payload.get(field) != expected:
            fail(f"{case_id}: payload.{field} must be {expected}")
    require_int_range(case_id, payload, "event_revision", 1, 2**32 - 1)
    require_utf8_len(case_id, payload, "source_event_id", 1, 96)
    require_utf8_len(case_id, payload, "title", 1, 160)
    require_utf8_len(case_id, payload, "region", 1, 160)
    require_int_range(case_id, payload, "severity_band", 1, 3)
    require_utf8_len(case_id, payload, "evidence_manifest_uri", 1, 512)
    require_int_range(case_id, payload, "affected_cell_count", 1, 1_000_000)
    for field in ["occurred_at_ms", "verified_at_ms", "freshness_deadline_ms"]:
        require_int_range(case_id, payload, field, 0, 2**64 - 1)
    if payload["freshness_deadline_ms"] != payload["verified_at_ms"] + FRESHNESS_WINDOW_MS:
        fail(f"{case_id}: freshness_deadline_ms must equal verified_at_ms + freshness window")


def leaf_bcs(affected: dict[str, Any], cell: dict[str, Any]) -> bytes:
    return b"".join(
        [
            hex_bytes(affected["event_uid"]),
            bcs_u32(affected["event_revision"]),
            bcs_u64(int(cell["h3_index"])),
            bcs_u8(affected["geo_resolution"]),
            bcs_u8(CELL_METRIC[affected["cell_metric"]]),
            bcs_u16(cell["intensity_value"]),
            bcs_u8(INTENSITY_SCALE[affected["intensity_scale"]]),
            bcs_u8(cell["cell_band"]),
            bcs_u8(CELLS_GENERATION_METHOD[affected["cells_generation_method"]]),
            bcs_u64(affected["oracle_version"]),
        ]
    )


def merkle_root(leaf_hashes: list[str]) -> str:
    level = [hex_bytes(h) for h in leaf_hashes]
    if not level:
        raise ValueError("empty Merkle tree")
    while len(level) > 1:
        nxt: list[bytes] = []
        for index in range(0, len(level), 2):
            if index + 1 == len(level):
                nxt.append(level[index])
            else:
                nxt.append(sha256(b"\x01" + level[index] + level[index + 1]).digest())
        level = nxt
    return hx(level[0])


def proof_root(leaf_hash: str, proof: list[dict[str, str]]) -> str:
    current = hex_bytes(leaf_hash)
    for step in proof:
        sibling = hex_bytes(step["sibling_hash"])
        if step["direction"] == "LEFT":
            current = sha256(b"\x01" + sibling + current).digest()
        elif step["direction"] == "RIGHT":
            current = sha256(b"\x01" + current + sibling).digest()
        else:
            fail(f"bad proof direction {step['direction']!r}")
    return hx(current)


def payload_bcs(payload: dict[str, Any]) -> str:
    data = b"".join(
        [
            bcs_u8(payload["intent"]),
            bcs_u64(payload["oracle_version"]),
            hex_bytes(payload["event_uid"]),
            bcs_u32(payload["event_revision"]),
            bcs_vec_u8(payload["source_event_id"]),
            bcs_vec_u8(payload["title"]),
            bcs_vec_u8(payload["region"]),
            bcs_u64(payload["occurred_at_ms"]),
            bcs_u8(payload["hazard_type"]),
            bcs_u8(payload["status"]),
            bcs_u8(payload["severity_band"]),
            hex_bytes(payload["affected_cells_root"]),
            bcs_u64(payload["affected_cell_count"]),
            bcs_vec_u8(payload["evidence_manifest_uri"]),
            hex_bytes(payload["evidence_manifest_hash"]),
            bcs_u64(payload["verified_at_ms"]),
            bcs_u64(payload["freshness_deadline_ms"]),
        ]
    )
    return hx(data)


def fail(message: str) -> None:
    raise ValueError(message)


def validate_result(case_id: str, case_dir: Path) -> dict[str, Any]:
    readme_path = case_dir / "README.md"
    if not readme_path.exists():
        fail(f"{case_id}: missing README.md")
    readme = readme_path.read_text(encoding="utf-8")
    for required_text in [
        "Source:",
        "- Derived from USGS event:",
        "- Captured at:",
        "- Modified for fixture:",
        "- Network access required for tests: no",
    ]:
        if required_text not in readme:
            fail(f"{case_id}: README.md missing {required_text!r}")

    expected = CASES[case_id]
    result_path = case_dir / "expected" / "result.json"
    if not result_path.exists():
        fail(f"{case_id}: missing expected/result.json")
    result = load_json(result_path)

    required_values = {
        "case_id": case_id,
        "status": expected["status"],
        "hazard_type": "EARTHQUAKE",
        "primary_source": "USGS",
        "geo_resolution": 7,
        "error_code": expected["error_code"],
    }
    for key, value in required_values.items():
        if result.get(key) != value:
            fail(f"{case_id}: result.{key} expected {value!r}, found {result.get(key)!r}")
    if not isinstance(result.get("source_event_id"), str) or not result["source_event_id"]:
        fail(f"{case_id}: result.source_event_id must be a non-empty string")
    if result.get("next_retry_at_ms") is not None:
        fail(f"{case_id}: result.next_retry_at_ms must be absent or null")

    grid_path = case_dir / "input" / "usgs_grid.xml"
    if expected["grid_required"] and not grid_path.exists():
        fail(f"{case_id}: input/usgs_grid.xml is required")
    if not expected["grid_required"] and grid_path.exists():
        fail(f"{case_id}: input/usgs_grid.xml must not exist")

    return result


def validate_h3_cells(case_id: str, affected: dict[str, Any]) -> None:
    cells = affected["affected_cells"]
    values: list[int] = []
    for cell in cells:
        h3_index = cell.get("h3_index")
        if not isinstance(h3_index, str):
            fail(f"{case_id}: h3_index must be a decimal string")
        if not h3_index.isdecimal():
            fail(f"{case_id}: h3_index must contain only decimal digits")
        if h3_index != "0" and h3_index.startswith("0"):
            fail(f"{case_id}: h3_index must not have leading zero")
        value = int(h3_index)
        if value < 0 or value > 2**64 - 1:
            fail(f"{case_id}: h3_index is outside u64 range")
        if cell["cell_band"] < 1:
            fail(f"{case_id}: affected_cells must not include Band 0 cells")
        values.append(value)
    if values != sorted(values):
        fail(f"{case_id}: affected_cells must be sorted by numeric h3_index")
    if len(values) != len(set(values)):
        fail(f"{case_id}: affected_cells contains duplicate h3_index")


def validate_payload_affected_cross_check(
    case_id: str,
    payload: dict[str, Any],
    affected: dict[str, Any],
) -> None:
    direct_checks = [
        "event_uid",
        "event_revision",
        "oracle_version",
    ]
    for field in direct_checks:
        if payload.get(field) != affected.get(field):
            fail(f"{case_id}: payload.{field} does not match affected_cells.{field}")

    enum_checks = {
        "cells_generation_method": CELLS_GENERATION_METHOD,
        "cell_metric": CELL_METRIC,
        "intensity_scale": INTENSITY_SCALE,
    }
    for field, values in enum_checks.items():
        affected_value = affected.get(field)
        if affected_value not in values:
            fail(f"{case_id}: affected_cells.{field} has unsupported value {affected_value!r}")


def validate_finalized(case_id: str, case_dir: Path, result: dict[str, Any]) -> None:
    readme = (case_dir / "README.md").read_text(encoding="utf-8")
    for required_text in [
        "Step 3 fixture uses plain `input/usgs_grid.xml` and `input/usgs_detail.json` as raw source bytes",
        "P90 definition:",
        "`rank = ceil(0.90 * n) - 1`",
        "finalized_multi_point_same_cell",
    ]:
        if required_text not in readme:
            fail(f"{case_id}: README.md missing {required_text!r}")

    expected_dir = case_dir / "expected"
    missing = sorted(path for path in FINALIZED_ONLY_FILES if not (expected_dir / path).exists())
    if missing:
        fail(f"{case_id}: missing finalized expected files: {', '.join(missing)}")
    if result.get("expected_payload") != "unsigned_payload.json":
        fail(f"{case_id}: finalized result must point expected_payload to unsigned_payload.json")

    source = load_json(expected_dir / "source_manifest.json")
    raw_manifest = load_json(expected_dir / "raw_data_manifest.json")
    affected = load_json(expected_dir / "affected_cells.json")
    evidence_manifest = load_json(expected_dir / "evidence_manifest.json")
    expected_hashes = load_json(expected_dir / "expected_hashes.json")
    sample_proof = load_json(expected_dir / "sample_proof.json")
    payload = load_json(expected_dir / "unsigned_payload.json")
    detail = load_json(case_dir / "input" / "usgs_detail.json")

    validate_current_payload_contract(case_id, payload)
    validate_h3_cells(case_id, affected)
    validate_payload_affected_cross_check(case_id, payload, affected)

    sorted_raw = sorted(
        raw_manifest["entries"],
        key=lambda item: (item["name"], item["event_id"], item["product"], item["uri"]),
    )
    if raw_manifest["entries"] != sorted_raw:
        fail(f"{case_id}: raw_data_manifest.entries is not sorted")
    for entry in raw_manifest["entries"]:
        raw_path = ROOT / entry["uri"]
        if not raw_path.exists():
            fail(f"{case_id}: raw source does not exist: {entry['uri']}")
        content_hash = sha256_hex(raw_path.read_bytes())
        if entry["content_hash"] != content_hash:
            fail(f"{case_id}: raw source content_hash mismatch for {entry['uri']}")

    source_bytes = canonical_json_bytes(source, SOURCE_ORDER, SOURCE_ENTRY_ORDER)
    raw_bytes = canonical_json_bytes(raw_manifest, RAW_ORDER, RAW_ENTRY_ORDER)
    affected_bytes = canonical_json_bytes(affected, AFFECTED_ORDER, AFFECTED_CELL_ORDER)
    source_set_hash = sha256_hex(source_bytes)
    raw_data_hash = sha256_hex(raw_bytes)
    affected_cells_data_hash = sha256_hex(affected_bytes)
    leaf_hashes = [
        {
            "h3_index": cell["h3_index"],
            "leaf_hash": sha256_hex(b"\x00" + leaf_bcs(affected, cell)),
        }
        for cell in affected["affected_cells"]
    ]
    affected_cells_root = merkle_root([item["leaf_hash"] for item in leaf_hashes])
    evidence_checks = {
        "schema_version": 1,
        "oracle_version": payload["oracle_version"],
        "event_uid": payload["event_uid"],
        "event_revision": payload["event_revision"],
        "hazard_type": "EARTHQUAKE",
        "source_event_id": payload["source_event_id"],
    }
    for key, value in evidence_checks.items():
        if evidence_manifest.get(key) != value:
            fail(f"{case_id}: evidence_manifest.{key} mismatch")
    expected_sources = [
        {
            "source": entry["name"],
            "product": entry["product"],
            "source_uri": entry["source_uri"],
            "artifact_uri": entry["uri"],
            "content_hash": entry["content_hash"],
            "size_bytes": entry["size_bytes"],
            "source_updated_at_ms": detail["properties"]["updated"],
        }
        for entry in raw_manifest["entries"]
    ]
    if evidence_manifest.get("sources") != expected_sources:
        fail(f"{case_id}: evidence_manifest.sources mismatch")
    expected_affected_cells = {
        "uri": f"ipfs://sonari/examples/{payload['source_event_id']}/affected_cells.json",
        "hash": affected_cells_data_hash,
        "root": affected_cells_root,
        "count": len(affected["affected_cells"]),
        "geo_resolution": affected["geo_resolution"],
    }
    if evidence_manifest.get("affected_cells") != expected_affected_cells:
        fail(f"{case_id}: evidence_manifest.affected_cells mismatch")
    expected_earthquake = {
        "title": payload["title"],
        "region": payload["region"],
        "occurred_at_ms": payload["occurred_at_ms"],
        "magnitude_x100": magnitude_x100(detail["properties"]["mag"]),
        "source_updated_at_ms": detail["properties"]["updated"],
    }
    if evidence_manifest.get("earthquake") != expected_earthquake:
        fail(f"{case_id}: evidence_manifest.earthquake mismatch")
    evidence_bytes = canonical_evidence_manifest_bytes(evidence_manifest)
    if (expected_dir / "evidence_manifest.json").read_bytes() != evidence_bytes:
        fail(f"{case_id}: evidence_manifest.json is not canonical JSON bytes")
    evidence_manifest_hash = sha256_hex(evidence_bytes)
    unsigned_bcs_payload_hex = payload_bcs(payload)

    computed = {
        "event_uid": payload["event_uid"],
        "source_set_hash": source_set_hash,
        "raw_data_hash": raw_data_hash,
        "raw_source_content_hashes": [
            {
                "uri": entry["uri"],
                "content_hash": entry["content_hash"],
            }
            for entry in raw_manifest["entries"]
        ],
        "affected_cells_data_hash": affected_cells_data_hash,
        "leaf_hashes": leaf_hashes,
        "affected_cells_root": affected_cells_root,
        "evidence_manifest_hash": evidence_manifest_hash,
        "unsigned_bcs_payload_hex": unsigned_bcs_payload_hex,
    }
    for key, value in computed.items():
        if expected_hashes.get(key) != value:
            fail(f"{case_id}: expected_hashes.{key} mismatch")

    payload_checks = {
        "affected_cells_root": affected_cells_root,
        "evidence_manifest_hash": evidence_manifest_hash,
        "affected_cell_count": len(affected["affected_cells"]),
    }
    for key, value in payload_checks.items():
        if payload.get(key) != value:
            fail(f"{case_id}: payload.{key} mismatch")

    if sample_proof["target_leaf"] not in leaf_hashes:
        fail(f"{case_id}: sample_proof target leaf does not match a fixture leaf")
    if sample_proof.get("expected_root") != affected_cells_root:
        fail(f"{case_id}: sample_proof expected_root mismatch")
    if proof_root(sample_proof["target_leaf"]["leaf_hash"], sample_proof["proof"]) != affected_cells_root:
        fail(f"{case_id}: sample_proof does not reproduce affected_cells_root")

    properties = detail.get("properties")
    if not isinstance(properties, dict):
        fail(f"{case_id}: USGS detail properties must be an object")
    usgs_checks = {
        "source_event_id": detail.get("id"),
        "title": properties.get("title"),
        "region": properties.get("place"),
    }
    for key, value in usgs_checks.items():
        if payload.get(key) != value:
            fail(f"{case_id}: payload.{key} does not match USGS detail")
    if payload["severity_band"] != max(cell["cell_band"] for cell in affected["affected_cells"]):
        fail(f"{case_id}: severity_band must match affected cell maximum")


def validate_non_finalized(case_id: str, case_dir: Path, result: dict[str, Any]) -> None:
    forbidden_fields = sorted(FORBIDDEN_NON_FINALIZED_FIELDS.intersection(result.keys()))
    if forbidden_fields:
        fail(f"{case_id}: forbidden result fields: {', '.join(forbidden_fields)}")

    expected_dir = case_dir / "expected"
    forbidden_files = sorted(path for path in FINALIZED_ONLY_FILES if (expected_dir / path).exists())
    if forbidden_files:
        fail(f"{case_id}: forbidden finalized files: {', '.join(forbidden_files)}")

    detail = load_json(case_dir / "input" / "usgs_detail.json")
    grid_path = case_dir / "input" / "usgs_grid.xml"

    if case_id == "usgs/pending_source_no_shakemap":
        if "shakemap" in detail_products(detail):
            fail(f"{case_id}: products.shakemap must not exist")
        return

    if case_id == "usgs/pending_mmi_empty_grid":
        if not get_shakemap_products(detail):
            fail(f"{case_id}: expected at least one ShakeMap product")
        if grid_data_text(grid_path).strip():
            fail(f"{case_id}: grid_data must be empty")
        return

    if case_id == "usgs/rejected_cancelled_shakemap":
        products = get_shakemap_products(detail)
        if not any(
            product.get("properties", {}).get("map-status") == "CANCELLED"
            for product in products
            if isinstance(product.get("properties"), dict)
        ):
            fail(f"{case_id}: expected a CANCELLED ShakeMap product")
        return

    if case_id == "usgs/rejected_no_affected_cells":
        if not get_shakemap_products(detail):
            fail(f"{case_id}: expected at least one ShakeMap product")
        mmi_values = grid_mmi_values(grid_path)
        if not mmi_values:
            fail(f"{case_id}: expected at least one valid MMI value")
        if any(value >= 7.0 for value in mmi_values):
            fail(f"{case_id}: expected all MMI values to be below 7.0")


def validate_case(case_id: str) -> None:
    case_dir = FIXTURES / case_id
    if not case_dir.exists():
        fail(f"{case_id}: missing fixture directory")
    result = validate_result(case_id, case_dir)
    if CASES[case_id]["status"] == "finalized":
        validate_finalized(case_id, case_dir, result)
    else:
        validate_non_finalized(case_id, case_dir, result)


def main() -> int:
    try:
        root_readme = FIXTURES / "README.md"
        if not root_readme.exists():
            fail("missing fixtures README.md")
        if (
            "Step 3 fixture uses plain `input/usgs_grid.xml` and `input/usgs_detail.json` as raw source bytes"
            not in root_readme.read_text(encoding="utf-8")
        ):
            fail("fixtures README.md must document raw source byte hashing")
        for case_id in CASES:
            validate_case(case_id)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("oracle fixtures verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
