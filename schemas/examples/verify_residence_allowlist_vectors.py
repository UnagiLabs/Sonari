#!/usr/bin/env python3
from __future__ import annotations

import json
import struct
import sys
from hashlib import sha256
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
VECTOR_PATH = ROOT / "schemas" / "examples" / "residence_allowlist_vectors.json"

U64_MAX = 2**64 - 1
LEAF_FIELD_ORDER = [
    {"name": "h3_index", "type": "u64"},
    {"name": "geo_resolution", "type": "u8"},
    {"name": "allowlist_version", "type": "u64"},
]


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def hx(data: bytes) -> str:
    return "0x" + data.hex()


def hex_bytes(value: str) -> bytes:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise ValueError(f"expected 0x-prefixed hex string, got {value!r}")
    data = bytes.fromhex(value[2:])
    if len(data) != 32:
        raise ValueError(f"expected 32-byte hash, got {value!r}")
    return data


def parse_h3_index(value: Any) -> int:
    if not isinstance(value, str):
        raise ValueError(f"h3_index must be a decimal string, got {value!r}")
    if value == "":
        raise ValueError("h3_index must not be empty")
    if value != "0" and value.startswith("0"):
        raise ValueError(f"h3_index has leading zero: {value!r}")
    if not value.isdecimal():
        raise ValueError(f"h3_index must be decimal: {value!r}")
    parsed = int(value)
    if parsed > U64_MAX:
        raise ValueError(f"h3_index exceeds u64: {value!r}")
    if str(parsed) != value:
        raise ValueError(f"h3_index is not canonical decimal: {value!r}")
    return parsed


def bcs_u8(value: Any, field: str) -> bytes:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 255:
        raise ValueError(f"{field} must be u8")
    return struct.pack("<B", value)


def bcs_u64(value: int) -> bytes:
    return struct.pack("<Q", value)


def leaf_bcs(leaf: dict[str, Any]) -> bytes:
    return b"".join(
        [
            bcs_u64(parse_h3_index(leaf["h3_index"])),
            bcs_u8(leaf["geo_resolution"], "geo_resolution"),
            bcs_u64_checked(leaf["allowlist_version"], "allowlist_version"),
        ]
    )


def bcs_u64_checked(value: Any, field: str) -> bytes:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= U64_MAX:
        raise ValueError(f"{field} must be u64")
    return bcs_u64(value)


def leaf_hash(leaf: dict[str, Any]) -> str:
    return hx(sha256(b"\x00" + leaf_bcs(leaf)).digest())


def internal_hash(left: bytes, right: bytes) -> bytes:
    return sha256(b"\x01" + left + right).digest()


def merkle_levels(leaf_hashes: list[str]) -> list[list[str]]:
    if not leaf_hashes:
        raise ValueError("empty Merkle tree")
    levels = [leaf_hashes]
    level = [hex_bytes(value) for value in leaf_hashes]
    while len(level) > 1:
        next_level: list[bytes] = []
        for index in range(0, len(level), 2):
            if index + 1 == len(level):
                next_level.append(level[index])
            else:
                next_level.append(internal_hash(level[index], level[index + 1]))
        levels.append([hx(value) for value in next_level])
        level = next_level
    return levels


def validate_odd_promotion(levels: list[list[str]]) -> None:
    saw_odd_promotion = False
    for index, level in enumerate(levels[:-1]):
        if len(level) % 2 == 1:
            promoted = level[-1]
            next_promoted = levels[index + 1][-1]
            if next_promoted != promoted:
                raise ValueError(f"odd leaf was not promoted unchanged at level {index}")
            saw_odd_promotion = True
    if not saw_odd_promotion:
        raise ValueError("fixture must exercise odd-leaf promotion")


def promoted_levels_for_leaf(leaf_index: int, leaf_count: int) -> list[int]:
    promoted_levels: list[int] = []
    current_index = leaf_index
    level_count = leaf_count
    level_index = 0
    while level_count > 1:
        if level_count % 2 == 1 and current_index == level_count - 1:
            promoted_levels.append(level_index)
            current_index = level_count // 2
        else:
            current_index //= 2
        level_count = (level_count + 1) // 2
        level_index += 1
    return promoted_levels


def verify_proof(
    proof: dict[str, Any],
    mapping: dict[str, Any],
    leaves_by_h3: dict[str, str],
    leaf_index_by_h3: dict[str, int],
    leaf_count: int,
) -> None:
    target_h3 = proof["target_h3_index"]
    if proof["target_leaf_hash"] != leaves_by_h3[target_h3]:
        raise ValueError(f"proof target hash mismatch for {target_h3}")
    expected_promotions = promoted_levels_for_leaf(leaf_index_by_h3[target_h3], leaf_count)
    if proof.get("promoted_without_sibling_at_levels", []) != expected_promotions:
        raise ValueError(f"proof promotion levels mismatch for {target_h3}")

    current = hex_bytes(proof["target_leaf_hash"])
    for step in proof["steps"]:
        direction = step["direction"]
        if direction not in {"LEFT", "RIGHT"}:
            raise ValueError(f"bad proof direction {direction!r}")

        expected_sibling_on_left = direction == "LEFT"
        if mapping[direction]["sibling_on_left"] is not expected_sibling_on_left:
            raise ValueError(f"mapping for {direction} has wrong sibling_on_left value")
        if step["sibling_on_left"] is not expected_sibling_on_left:
            raise ValueError(f"proof step for {direction} has wrong sibling_on_left value")

        sibling = hex_bytes(step["sibling_hash"])
        if expected_sibling_on_left:
            current = internal_hash(sibling, current)
        else:
            current = internal_hash(current, sibling)

    if hx(current) != proof["expected_root"]:
        raise ValueError(f"proof for {target_h3} does not replay to expected root")


def verify() -> None:
    vectors = load_json(VECTOR_PATH)

    if vectors["leaf_field_order"] != LEAF_FIELD_ORDER:
        raise ValueError("leaf field order mismatch")

    mapping = vectors["proof_direction_mapping"]
    if mapping["LEFT"]["sibling_on_left"] is not True:
        raise ValueError("LEFT must map to sibling_on_left = true")
    if mapping["RIGHT"]["sibling_on_left"] is not False:
        raise ValueError("RIGHT must map to sibling_on_left = false")

    leaves = vectors["leaves"]
    h3_values = [parse_h3_index(leaf["h3_index"]) for leaf in leaves]
    if h3_values != sorted(h3_values):
        raise ValueError("leaves are not sorted by numeric h3_index")
    if len(set(h3_values)) != len(h3_values):
        raise ValueError("duplicate h3_index in leaves")

    computed_leaf_hashes = []
    leaves_by_h3 = {}
    leaf_index_by_h3 = {}
    for index, leaf in enumerate(leaves):
        expected_bcs = hx(leaf_bcs(leaf))
        expected_hash = leaf_hash(leaf)
        if leaf["bcs_hex"] != expected_bcs:
            raise ValueError(f"BCS mismatch for h3_index {leaf['h3_index']}")
        if leaf["leaf_hash"] != expected_hash:
            raise ValueError(f"leaf hash mismatch for h3_index {leaf['h3_index']}")
        computed_leaf_hashes.append(expected_hash)
        leaves_by_h3[leaf["h3_index"]] = expected_hash
        leaf_index_by_h3[leaf["h3_index"]] = index

    levels = merkle_levels(computed_leaf_hashes)
    validate_odd_promotion(levels)
    if vectors["merkle_levels"] != levels:
        raise ValueError("Merkle levels mismatch")
    root = levels[-1][0]
    if vectors["merkle_root"] != root:
        raise ValueError("Merkle root mismatch")

    for proof in vectors["proofs"]:
        verify_proof(proof, mapping, leaves_by_h3, leaf_index_by_h3, len(leaves))
        if proof["expected_root"] != root:
            raise ValueError(f"proof expected root mismatch for {proof['target_h3_index']}")


def main() -> int:
    try:
        verify()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print("residence allowlist vectors verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
