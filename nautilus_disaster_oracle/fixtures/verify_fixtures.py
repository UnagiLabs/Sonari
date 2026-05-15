#!/usr/bin/env python3
from __future__ import annotations

import json
import struct
import sys
from hashlib import sha3_256
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "nautilus_disaster_oracle" / "fixtures"

CASES = {
    "usgs/finalized_minimal": {
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
    "unsigned_payload_v1.json",
    "affected_cells.json",
    "sample_proof.json",
    "source_manifest.json",
    "raw_data_manifest.json",
    "expected_hashes.json",
}

FORBIDDEN_NON_FINALIZED_FIELDS = {
    "expected_payload",
    "payload",
    "signature",
    "payload_hash",
    "affected_cells_root",
    "affected_cells_data_hash",
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

CELLS_GENERATION_METHOD = {"shakemap_gridxml_h3_grid_point_p90_v1": 1}
CELL_METRIC = {"USGS_MMI": 1, "JMA_SHINDO": 2}
INTENSITY_SCALE = {"MMI_X100": 1, "JMA_SHINDO_X10": 2}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def hx(data: bytes) -> str:
    return "0x" + data.hex()


def sha3_hex(data: bytes) -> str:
    return hx(sha3_256(data).digest())


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
                nxt.append(sha3_256(b"\x01" + level[index] + level[index + 1]).digest())
        level = nxt
    return hx(level[0])


def proof_root(leaf_hash: str, proof: list[str], leaf_index: int) -> str:
    current = hex_bytes(leaf_hash)
    index = leaf_index
    for sibling_hash in proof:
        sibling = hex_bytes(sibling_hash)
        if index % 2 == 0:
            current = sha3_256(b"\x01" + current + sibling).digest()
        else:
            current = sha3_256(b"\x01" + sibling + current).digest()
        index //= 2
    return hx(current)


def payload_bcs(payload: dict[str, Any]) -> str:
    data = b"".join(
        [
            bcs_u8(payload["intent"]),
            bcs_u64(payload["oracle_version"]),
            hex_bytes(payload["event_uid"]),
            bcs_u8(payload["hazard_type"]),
            bcs_u8(payload["status"]),
            bcs_u32(payload["event_revision"]),
            bcs_u64(payload["occurred_at_ms"]),
            bcs_u64(payload["observed_at_ms"]),
            bcs_u64(payload["source_updated_at_ms"]),
            bcs_u8(payload["primary_source"]),
            bcs_u8(payload["severity_band"]),
            hex_bytes(payload["source_set_hash"]),
            hex_bytes(payload["raw_data_hash"]),
            bcs_vec_u8(payload["raw_data_uri"]),
            hex_bytes(payload["affected_cells_root"]),
            bcs_vec_u8(payload["affected_cells_uri"]),
            hex_bytes(payload["affected_cells_data_hash"]),
            bcs_u8(payload["geo_resolution"]),
            bcs_u8(payload["cells_generation_method"]),
            bcs_u8(payload["cell_metric"]),
            bcs_u8(payload["cell_aggregation"]),
            bcs_u8(payload["intensity_scale"]),
            bcs_u8(payload["max_cell_band"]),
            bcs_u64(payload["affected_cell_count"]),
            bcs_u8(payload["min_claim_band"]),
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
    if "next_retry_at_ms" not in result:
        fail(f"{case_id}: result.next_retry_at_ms is required")

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


def validate_finalized(case_id: str, case_dir: Path, result: dict[str, Any]) -> None:
    readme = (case_dir / "README.md").read_text(encoding="utf-8")
    for required_text in [
        "Step 2 fixture uses plain `input/usgs_grid.xml` as raw source bytes",
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
    if result.get("expected_payload") != "unsigned_payload_v1.json":
        fail(f"{case_id}: finalized result must point expected_payload to unsigned_payload_v1.json")

    source = load_json(expected_dir / "source_manifest.json")
    raw_manifest = load_json(expected_dir / "raw_data_manifest.json")
    affected = load_json(expected_dir / "affected_cells.json")
    expected_hashes = load_json(expected_dir / "expected_hashes.json")
    sample_proof = load_json(expected_dir / "sample_proof.json")
    payload = load_json(expected_dir / "unsigned_payload_v1.json")

    validate_h3_cells(case_id, affected)

    grid_bytes = (case_dir / "input" / "usgs_grid.xml").read_bytes()
    raw_data_hash = sha3_hex(grid_bytes)

    raw_sources = raw_manifest.get("raw_sources")
    if not isinstance(raw_sources, list) or len(raw_sources) != 1:
        fail(f"{case_id}: raw_data_manifest.raw_sources must contain one grid source")
    raw_source = raw_sources[0]
    if raw_source.get("path") != "input/usgs_grid.xml":
        fail(f"{case_id}: raw source path must be input/usgs_grid.xml")
    if raw_source.get("content_hash_algorithm") != "SHA3-256":
        fail(f"{case_id}: raw source content_hash_algorithm must be SHA3-256")
    if raw_source.get("content_hash") != raw_data_hash:
        fail(f"{case_id}: raw source content_hash mismatch")

    source_bytes = canonical_json_bytes(source, SOURCE_ORDER, SOURCE_ENTRY_ORDER)
    affected_bytes = canonical_json_bytes(affected, AFFECTED_ORDER, AFFECTED_CELL_ORDER)
    source_set_hash = sha3_hex(source_bytes)
    affected_cells_data_hash = sha3_hex(affected_bytes)
    leaf_hashes = [
        {
            "h3_index": cell["h3_index"],
            "leaf_hash": sha3_hex(b"\x00" + leaf_bcs(affected, cell)),
        }
        for cell in affected["affected_cells"]
    ]
    affected_cells_root = merkle_root([item["leaf_hash"] for item in leaf_hashes])
    unsigned_bcs_payload_hex = payload_bcs(payload)

    computed = {
        "source_set_hash": source_set_hash,
        "raw_data_hash": raw_data_hash,
        "raw_source_content_hashes": [
            {
                "path": "input/usgs_grid.xml",
                "content_hash": raw_data_hash,
                "content_hash_algorithm": "SHA3-256",
            }
        ],
        "affected_cells_data_hash": affected_cells_data_hash,
        "leaf_hashes": leaf_hashes,
        "affected_cells_root": affected_cells_root,
        "unsigned_bcs_payload_hex": unsigned_bcs_payload_hex,
    }
    for key, value in computed.items():
        if expected_hashes.get(key) != value:
            fail(f"{case_id}: expected_hashes.{key} mismatch")

    payload_checks = {
        "source_set_hash": source_set_hash,
        "raw_data_hash": raw_data_hash,
        "affected_cells_root": affected_cells_root,
        "affected_cells_data_hash": affected_cells_data_hash,
        "affected_cell_count": len(affected["affected_cells"]),
    }
    for key, value in payload_checks.items():
        if payload.get(key) != value:
            fail(f"{case_id}: payload.{key} mismatch")

    if sample_proof.get("leaf_index") != 0:
        fail(f"{case_id}: sample_proof.leaf_index must be 0")
    if sample_proof.get("h3_index") != leaf_hashes[0]["h3_index"]:
        fail(f"{case_id}: sample_proof.h3_index mismatch")
    if sample_proof.get("leaf_hash") != leaf_hashes[0]["leaf_hash"]:
        fail(f"{case_id}: sample_proof.leaf_hash mismatch")
    if proof_root(sample_proof["leaf_hash"], sample_proof["proof"], 0) != affected_cells_root:
        fail(f"{case_id}: sample_proof does not reproduce affected_cells_root")

    if payload["status"] != 3:
        fail(f"{case_id}: finalized payload must use onchain FINALIZED status")
    if payload["severity_band"] != payload["max_cell_band"]:
        fail(f"{case_id}: severity_band must match max_cell_band")
    if payload["max_cell_band"] != max(cell["cell_band"] for cell in affected["affected_cells"]):
        fail(f"{case_id}: max_cell_band must match affected cell maximum")


def validate_non_finalized(case_id: str, case_dir: Path, result: dict[str, Any]) -> None:
    forbidden_fields = sorted(FORBIDDEN_NON_FINALIZED_FIELDS.intersection(result.keys()))
    if forbidden_fields:
        fail(f"{case_id}: forbidden result fields: {', '.join(forbidden_fields)}")

    expected_dir = case_dir / "expected"
    forbidden_files = sorted(path for path in FINALIZED_ONLY_FILES if (expected_dir / path).exists())
    if forbidden_files:
        fail(f"{case_id}: forbidden finalized files: {', '.join(forbidden_files)}")


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
            "Step 2 fixture uses plain `input/usgs_grid.xml` as raw source bytes"
            not in root_readme.read_text(encoding="utf-8")
        ):
            fail("fixtures README.md must document raw grid byte hashing")
        for case_id in CASES:
            validate_case(case_id)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("oracle fixtures verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
