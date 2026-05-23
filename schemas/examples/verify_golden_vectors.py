#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import struct
import sys
from hashlib import sha3_256
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
    return sha3_hex(data)


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
                nxt.append(sha3_256(b"\x01" + level[i] + level[i + 1]).digest())
        level = nxt
    return hx(level[0])


def verify_proof(target_leaf_hash: str, proof: list[dict[str, str]], expected_root: str) -> bool:
    current = hex_bytes(target_leaf_hash)
    for step in proof:
        sibling = hex_bytes(step["sibling_hash"])
        if step["direction"] == "LEFT":
            current = sha3_256(b"\x01" + sibling + current).digest()
        elif step["direction"] == "RIGHT":
            current = sha3_256(b"\x01" + current + sibling).digest()
        else:
            raise ValueError(f"bad proof direction {step['direction']!r}")
    return hx(current) == expected_root


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


def compute() -> dict[str, Any]:
    source_path = EXAMPLES / "source_manifest.json"
    raw_path = EXAMPLES / "raw_data_manifest.json"
    affected_path = EXAMPLES / "affected_cells.json"
    source = load_json(source_path)
    raw = load_json(raw_path)
    affected = load_json(affected_path)
    payload = load_json(EXAMPLES / "unsigned_payload_v1.json")

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
        content_hash = sha3_hex(path.read_bytes())
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
    for path, expected_bytes in [
        (source_path, source_bytes),
        (raw_path, raw_bytes),
        (affected_path, affected_bytes),
    ]:
        if path.read_bytes() != expected_bytes:
            raise ValueError(f"{path.relative_to(ROOT)} is not canonical JSON bytes")

    source_set_hash = sha3_hex(source_bytes)
    raw_data_hash = sha3_hex(raw_bytes)
    affected_cells_data_hash = sha3_hex(affected_bytes)
    leaf_hashes = [
        {
            "h3_index": cell["h3_index"],
            "leaf_hash": sha3_hex(b"\x00" + leaf_bcs(affected, cell)),
        }
        for cell in cells
    ]
    root = merkle_root([item["leaf_hash"] for item in leaf_hashes])

    if uid != payload["event_uid"]:
        raise ValueError(f"payload event_uid mismatch: {uid}")
    for key, value in [
        ("source_set_hash", source_set_hash),
        ("raw_data_hash", raw_data_hash),
        ("affected_cells_root", root),
        ("affected_cells_data_hash", affected_cells_data_hash),
    ]:
        if payload[key] != value:
            raise ValueError(f"payload {key} mismatch: expected {value}, found {payload[key]}")
    if payload["status"] != 3:
        raise ValueError("finalized payload must use status = FINALIZED")
    if not payload["affected_cells_uri"]:
        raise ValueError("finalized payload must have non-empty affected_cells_uri")
    if payload["affected_cell_count"] != len(cells) or payload["affected_cell_count"] <= 0:
        raise ValueError("payload affected_cell_count mismatch")
    if payload["min_claim_band"] != 1:
        raise ValueError("payload min_claim_band must be 1")

    return {
        "event_uid": uid,
        "source_set_hash": source_set_hash,
        "raw_data_hash": raw_data_hash,
        "raw_source_content_hashes": raw_source_hashes,
        "affected_cells_data_hash": affected_cells_data_hash,
        "leaf_hashes": leaf_hashes,
        "affected_cells_root": root,
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
