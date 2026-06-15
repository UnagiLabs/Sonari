#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import struct
import sys
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from hashlib import sha256
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "schemas" / "examples"

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


def require_utf8_len(payload: dict[str, Any], field: str, minimum: int, maximum: int) -> None:
    value = payload.get(field)
    if not isinstance(value, str):
        raise ValueError(f"payload {field} must be a string")
    length = len(value.encode("utf-8"))
    if length < minimum or length > maximum:
        raise ValueError(f"payload {field} must be {minimum}..{maximum} UTF-8 bytes")


def require_int_range(payload: dict[str, Any], field: str, minimum: int, maximum: int) -> None:
    value = payload.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
        raise ValueError(f"payload {field} must be an integer in {minimum}..{maximum}")


def magnitude_x100(value: Any) -> int:
    if isinstance(value, bool) or value is None:
        raise ValueError("USGS properties.mag must be a decimal number")
    try:
        decimal = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("USGS properties.mag must be a decimal number") from exc
    if not decimal.is_finite():
        raise ValueError("USGS properties.mag must be finite")
    return int((decimal * Decimal(100)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def validate_payload_contract(payload: dict[str, Any]) -> None:
    old_fields = sorted(OLD_PAYLOAD_FIELDS.intersection(payload))
    if old_fields:
        raise ValueError(f"payload contains removed signed fields: {', '.join(old_fields)}")
    if list(payload.keys()) != PAYLOAD_FIELD_ORDER:
        raise ValueError("payload field order does not match current 17-field contract")
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
            raise ValueError(f"payload {field} must be {expected}")
    require_int_range(payload, "event_revision", 1, 2**32 - 1)
    require_utf8_len(payload, "source_event_id", 1, 96)
    require_utf8_len(payload, "title", 1, 160)
    require_utf8_len(payload, "region", 1, 160)
    require_int_range(payload, "severity_band", 1, 3)
    require_utf8_len(payload, "evidence_manifest_uri", 1, 512)
    require_int_range(payload, "affected_cell_count", 1, 1_000_000)
    for field in ["occurred_at_ms", "verified_at_ms", "freshness_deadline_ms"]:
        require_int_range(payload, field, 0, 2**64 - 1)
    if payload["freshness_deadline_ms"] != payload["verified_at_ms"] + FRESHNESS_WINDOW_MS:
        raise ValueError("payload freshness_deadline_ms must equal verified_at_ms + freshness window")


def event_uid(hazard_type: int, primary_source: str, source_event_id: str, occurred_at_ms: int) -> str:
    primary = primary_source.encode("utf-8")
    source_id = source_event_id.encode("utf-8")
    data = (
        b"sonari:event_uid:v1"
        + bcs_u8(hazard_type)
        + bcs_u32(len(primary))
        + primary
        + bcs_u32(len(source_id))
        + source_id
        + bcs_u64(occurred_at_ms)
    )
    return sha256_hex(data)


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
        for i in range(0, len(level), 2):
            if i + 1 == len(level):
                nxt.append(level[i])
            else:
                nxt.append(sha256(b"\x01" + level[i] + level[i + 1]).digest())
        level = nxt
    return hx(level[0])


def verify_proof(target_leaf_hash: str, proof: list[dict[str, str]], expected_root: str) -> bool:
    current = hex_bytes(target_leaf_hash)
    for step in proof:
        sibling = hex_bytes(step["sibling_hash"])
        if step["direction"] == "LEFT":
            current = sha256(b"\x01" + sibling + current).digest()
        elif step["direction"] == "RIGHT":
            current = sha256(b"\x01" + current + sibling).digest()
        else:
            raise ValueError(f"bad proof direction {step['direction']!r}")
    return hx(current) == expected_root


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


def compute() -> dict[str, Any]:
    source_path = EXAMPLES / "source_manifest.json"
    raw_path = EXAMPLES / "raw_data_manifest.json"
    affected_path = EXAMPLES / "affected_cells.json"
    evidence_path = EXAMPLES / "evidence_manifest.json"
    source = load_json(source_path)
    raw = load_json(raw_path)
    affected = load_json(affected_path)
    evidence = load_json(evidence_path)
    payload = load_json(EXAMPLES / "unsigned_payload.json")
    detail = load_json(EXAMPLES / "raw_sources" / "usgs_detail.json")
    validate_payload_contract(payload)

    sorted_sources = sorted(
        source["sources"],
        key=lambda item: (
            item["name"],
            item["event_id"],
            item["product"],
            item["product_version"],
            item["updated_at_ms"],
        ),
    )
    if source["sources"] != sorted_sources:
        raise ValueError("source_manifest.sources is not sorted")

    sorted_raw = sorted(
        raw["entries"],
        key=lambda item: (item["name"], item["event_id"], item["product"], item["uri"]),
    )
    if raw["entries"] != sorted_raw:
        raise ValueError("raw_data_manifest.entries is not sorted")

    cells = affected["affected_cells"]
    h3_values = [int(cell["h3_index"]) for cell in cells]
    if any(cell["h3_index"] != "0" and cell["h3_index"].startswith("0") for cell in cells):
        raise ValueError("affected_cells h3_index has leading zero")
    if h3_values != sorted(h3_values):
        raise ValueError("affected_cells is not sorted by numeric h3_index")
    if len(set(h3_values)) != len(h3_values):
        raise ValueError("affected_cells contains duplicate h3_index")

    raw_source_hashes = []
    for entry in raw["entries"]:
        path = ROOT / entry["uri"]
        content_hash = sha256_hex(path.read_bytes())
        if content_hash != entry["content_hash"]:
            raise ValueError(f"content_hash mismatch for {entry['uri']}: {content_hash}")
        raw_source_hashes.append({"uri": entry["uri"], "content_hash": content_hash})

    uid = event_uid(
        payload["hazard_type"],
        source["sources"][0]["name"],
        source["sources"][0]["event_id"],
        payload["occurred_at_ms"],
    )
    source_bytes = canonical_json_bytes(source, SOURCE_ORDER, SOURCE_ENTRY_ORDER)
    raw_bytes = canonical_json_bytes(raw, RAW_ORDER, RAW_ENTRY_ORDER)
    affected_bytes = canonical_json_bytes(affected, AFFECTED_ORDER, AFFECTED_CELL_ORDER)
    source_set_hash = sha256_hex(source_bytes)
    raw_data_hash = sha256_hex(raw_bytes)
    affected_cells_data_hash = sha256_hex(affected_bytes)
    leaf_hashes = [
        {
            "h3_index": cell["h3_index"],
            "leaf_hash": sha256_hex(b"\x00" + leaf_bcs(affected, cell)),
        }
        for cell in cells
    ]
    root = merkle_root([item["leaf_hash"] for item in leaf_hashes])
    evidence_checks = {
        "schema_version": 1,
        "oracle_version": payload["oracle_version"],
        "event_uid": payload["event_uid"],
        "event_revision": payload["event_revision"],
        "hazard_type": "EARTHQUAKE",
        "source_event_id": payload["source_event_id"],
    }
    for key, value in evidence_checks.items():
        if evidence.get(key) != value:
            raise ValueError(f"evidence_manifest {key} mismatch: expected {value}, found {evidence.get(key)}")
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
        for entry in raw["entries"]
    ]
    if evidence.get("sources") != expected_sources:
        raise ValueError("evidence_manifest sources mismatch")
    expected_earthquake = {
        "title": payload["title"],
        "region": payload["region"],
        "occurred_at_ms": payload["occurred_at_ms"],
        "magnitude_x100": magnitude_x100(detail["properties"]["mag"]),
        "source_updated_at_ms": detail["properties"]["updated"],
    }
    if evidence.get("earthquake") != expected_earthquake:
        raise ValueError("evidence_manifest earthquake mismatch")
    expected_affected = {
        "uri": "ipfs://sonari/examples/us7000sonari/affected_cells.json",
        "hash": affected_cells_data_hash,
        "root": root,
        "count": len(cells),
        "geo_resolution": affected["geo_resolution"],
    }
    if evidence.get("affected_cells") != expected_affected:
        raise ValueError("evidence_manifest affected_cells mismatch")
    evidence_bytes = canonical_evidence_manifest_bytes(evidence)
    evidence_manifest_hash = sha256_hex(evidence_bytes)
    for path, expected_bytes in [
        (source_path, source_bytes),
        (raw_path, raw_bytes),
        (affected_path, affected_bytes),
        (evidence_path, evidence_bytes),
    ]:
        if path.read_bytes() != expected_bytes:
            raise ValueError(f"{path.relative_to(ROOT)} is not canonical JSON bytes")

    if uid != payload["event_uid"]:
        raise ValueError(f"payload event_uid mismatch: {uid}")
    for key, value in [
        ("affected_cells_root", root),
        ("evidence_manifest_hash", evidence_manifest_hash),
    ]:
        if payload[key] != value:
            raise ValueError(f"payload {key} mismatch: expected {value}, found {payload[key]}")
    if payload["affected_cell_count"] != len(cells):
        raise ValueError("payload affected_cell_count mismatch")

    return {
        "event_uid": uid,
        "source_set_hash": source_set_hash,
        "raw_data_hash": raw_data_hash,
        "raw_source_content_hashes": raw_source_hashes,
        "affected_cells_data_hash": affected_cells_data_hash,
        "leaf_hashes": leaf_hashes,
        "affected_cells_root": root,
        "evidence_manifest_hash": evidence_manifest_hash,
        "unsigned_bcs_payload_hex": payload_bcs(payload),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--print", action="store_true", help="print computed golden values")
    args = parser.parse_args()

    try:
        computed = compute()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.print:
        print(json.dumps(computed, indent=2, ensure_ascii=False))
        return 0

    expected = load_json(EXAMPLES / "expected_hashes.json")
    if computed != expected:
        print("ERROR: expected_hashes.json does not match computed values", file=sys.stderr)
        print(json.dumps(computed, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1

    proof = load_json(EXAMPLES / "sample_proof.json")
    if proof["target_leaf"]["leaf_hash"] != computed["leaf_hashes"][1]["leaf_hash"]:
        print("ERROR: sample proof target leaf does not match golden leaf", file=sys.stderr)
        return 1
    if proof["expected_root"] != computed["affected_cells_root"]:
        print("ERROR: sample proof expected root mismatch", file=sys.stderr)
        return 1
    if not verify_proof(
        proof["target_leaf"]["leaf_hash"],
        proof["proof"],
        proof["expected_root"],
    ):
        print("ERROR: sample proof verification failed", file=sys.stderr)
        return 1

    print("golden vectors verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
