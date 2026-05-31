from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

import h3

ALLOWLIST_SCHEMA = "sonari.residence.allowlist.v1"
ALLOWLIST_SCHEMA_VERSION = 1
LOCAL_GEOJSON_SOURCE_KIND = "local_geojson"
MANIFEST_SCHEMA = "sonari.residence.allowlist.manifest.v1"
MANIFEST_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class LandSourceManifest:
    source_name: str
    version: str
    url: str
    sha256: str
    resolution: int
    containment_mode: str


NATURAL_EARTH_LAND_SOURCE = LandSourceManifest(
    source_name="Natural Earth ne_10m_land",
    version="v5.1.2",
    url="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson",
    sha256="1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416",
    resolution=7,
    containment_mode="h3.h3shape_to_cells_experimental(contain='overlap')",
)


class ResidenceAllowlistError(ValueError):
    pass


def read_text_bytes(path: str) -> tuple[str, bytes]:
    with open(path, "rb") as file:
        data = file.read()
    try:
        return data.decode("utf-8"), data
    except UnicodeDecodeError as error:
        raise ResidenceAllowlistError(f"{path} must be UTF-8") from error


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def prefixed_hex(data: bytes) -> str:
    return f"0x{data.hex()}"


def load_json(path: str) -> Any:
    with open(path, "rb") as file:
        return json.load(file)


def write_pretty_json(path: str, value: Any) -> None:
    with open(path, "w", encoding="utf-8") as file:
        json.dump(value, file, indent=2)
        file.write("\n")


def generate_candidate_h3_indexes_from_geojson(source: str) -> list[int]:
    try:
        geojson = json.loads(source)
    except json.JSONDecodeError as error:
        raise ResidenceAllowlistError(f"malformed residence land source: {error}") from error

    cells: set[int] = set()
    geometries = list(_iter_polygon_geometries(geojson))
    if not geometries:
        raise ResidenceAllowlistError(
            "malformed residence land source: land source contains no Polygon or MultiPolygon geometry"
        )

    for geometry in geometries:
        try:
            shape = h3.geo_to_h3shape(geometry)
            for cell in h3.h3shape_to_cells_experimental(
                shape,
                NATURAL_EARTH_LAND_SOURCE.resolution,
                contain="overlap",
            ):
                cells.add(h3.str_to_int(cell))
        except Exception as error:
            raise ResidenceAllowlistError(f"invalid residence land geometry: {error}") from error

    return sorted(cells)


def _iter_polygon_geometries(geojson: Any) -> list[dict[str, Any]]:
    if not isinstance(geojson, dict):
        raise ResidenceAllowlistError("malformed residence land source: top-level JSON must be an object")

    geo_type = geojson.get("type")
    if geo_type == "FeatureCollection":
        features = geojson.get("features")
        if not isinstance(features, list) or not features:
            raise ResidenceAllowlistError("malformed residence land source: feature collection is empty")
        geometries: list[dict[str, Any]] = []
        for feature in features:
            geometries.extend(_iter_polygon_geometries(feature))
        return geometries

    if geo_type == "Feature":
        geometry = geojson.get("geometry")
        if not isinstance(geometry, dict):
            raise ResidenceAllowlistError("malformed residence land source: feature is missing geometry")
        return _iter_polygon_geometries(geometry)

    if geo_type in {"Polygon", "MultiPolygon"}:
        coordinates = geojson.get("coordinates")
        if not isinstance(coordinates, list):
            raise ResidenceAllowlistError("malformed residence land source: geometry is missing coordinates")
        return [geojson]

    raise ResidenceAllowlistError(
        "malformed residence land source: land source geometry must be Polygon or MultiPolygon"
    )


@dataclass(frozen=True)
class ResidenceCellLeaf:
    h3_index: int
    geo_resolution: int
    allowlist_version: int


def leaf_bcs_bytes(leaf: ResidenceCellLeaf) -> bytes:
    return (
        _bcs_u64(leaf.h3_index)
        + _bcs_u8(leaf.geo_resolution)
        + _bcs_u64(leaf.allowlist_version)
    )


def leaf_hash(leaf: ResidenceCellLeaf) -> bytes:
    return hashlib.sha256(b"\x00" + leaf_bcs_bytes(leaf)).digest()


def internal_node_hash(left: bytes, right: bytes) -> bytes:
    _assert_hash(left, "left")
    _assert_hash(right, "right")
    return hashlib.sha256(b"\x01" + left + right).digest()


def merkle_root_from_leaves(leaves: list[ResidenceCellLeaf]) -> bytes | None:
    return merkle_root_from_leaf_hashes([hash_value for _, hash_value in _sorted_leaf_hashes(leaves)])


def merkle_root_from_leaf_hashes(leaf_hashes: list[bytes]) -> bytes | None:
    level = list(leaf_hashes)
    if not level:
        return None
    while len(level) > 1:
        next_level: list[bytes] = []
        for index in range(0, len(level), 2):
            left = level[index]
            right = level[index + 1] if index + 1 < len(level) else None
            next_level.append(left if right is None else internal_node_hash(left, right))
        level = next_level
    return level[0]


def generate_proof_for_h3_index(
    leaves: list[ResidenceCellLeaf], target_h3_index: int
) -> dict[str, Any] | None:
    sorted_hashes = _sorted_leaf_hashes(leaves)
    target_index = next(
        (index for index, (leaf, _) in enumerate(sorted_hashes) if leaf.h3_index == target_h3_index),
        None,
    )
    if target_index is None:
        return None

    leaf_hashes = [hash_value for _, hash_value in sorted_hashes]
    expected_root = merkle_root_from_leaf_hashes(leaf_hashes)
    if expected_root is None:
        return None

    current_index = target_index
    level = leaf_hashes
    level_index = 0
    promotions: list[int] = []
    steps: list[dict[str, Any]] = []

    while len(level) > 1:
        next_level: list[bytes] = []
        next_target_index: int | None = None
        for left_index in range(0, len(level), 2):
            left_hash = level[left_index]
            right_index = left_index + 1
            if right_index >= len(level):
                if current_index == left_index:
                    promotions.append(level_index)
                    next_target_index = len(next_level)
                next_level.append(left_hash)
                continue

            right_hash = level[right_index]
            if current_index == left_index:
                steps.append(_proof_step("RIGHT", right_hash))
                next_target_index = len(next_level)
            elif current_index == right_index:
                steps.append(_proof_step("LEFT", left_hash))
                next_target_index = len(next_level)

            next_level.append(internal_node_hash(left_hash, right_hash))

        if next_target_index is None:
            return None
        current_index = next_target_index
        level = next_level
        level_index += 1

    target_leaf_hash = sorted_hashes[target_index][1]
    return {
        "target_h3_index": str(target_h3_index),
        "target_leaf_hash": prefixed_hex(target_leaf_hash),
        "promoted_without_sibling_at_levels": promotions,
        "steps": steps,
        "expected_root": prefixed_hex(expected_root),
    }


def build_allowlist_artifact(
    source: str,
    source_bytes: bytes,
    allowlist_version: int,
) -> dict[str, Any]:
    source_hash = sha256_hex(source_bytes)
    if source_hash != NATURAL_EARTH_LAND_SOURCE.sha256:
        raise ResidenceAllowlistError("source file does not match pinned Natural Earth source")

    indexes = generate_candidate_h3_indexes_from_geojson(source)
    return {
        "schema": ALLOWLIST_SCHEMA,
        "schema_version": ALLOWLIST_SCHEMA_VERSION,
        "source": _source_metadata(source_bytes),
        "geo_resolution": NATURAL_EARTH_LAND_SOURCE.resolution,
        "allowlist_version": allowlist_version,
        "h3_indexes": [str(index) for index in indexes],
    }


def parse_valid_allowlist(artifact: Any) -> tuple[dict[str, Any], list[ResidenceCellLeaf]]:
    _validate_allowlist_artifact(artifact)
    leaves = [
        ResidenceCellLeaf(
            h3_index=parse_h3_index(value),
            geo_resolution=artifact["geo_resolution"],
            allowlist_version=artifact["allowlist_version"],
        )
        for value in artifact["h3_indexes"]
    ]
    return artifact, leaves


def load_verified_allowlist(allowlist_path: str, source_path: str) -> tuple[dict[str, Any], list[ResidenceCellLeaf]]:
    artifact, leaves = parse_valid_allowlist(load_json(allowlist_path))
    source, source_bytes = read_text_bytes(source_path)
    validate_allowlist_matches_source(artifact, source, source_bytes)
    return artifact, leaves


def validate_allowlist_matches_source(artifact: dict[str, Any], source: str, source_bytes: bytes) -> None:
    source_hash = sha256_hex(source_bytes)
    if source_hash != NATURAL_EARTH_LAND_SOURCE.sha256:
        raise ResidenceAllowlistError("local source file does not match pinned Natural Earth source")
    if artifact["source"]["sha256"] != f"0x{source_hash}":
        raise ResidenceAllowlistError("allowlist source.sha256 does not match local source file")
    if artifact["source"]["byte_length"] != len(source_bytes):
        raise ResidenceAllowlistError(
            f"allowlist source.byte_length {artifact['source']['byte_length']} does not match computed {len(source_bytes)}"
        )

    generated_indexes = [str(index) for index in generate_candidate_h3_indexes_from_geojson(source)]
    if generated_indexes != artifact["h3_indexes"]:
        raise ResidenceAllowlistError(
            "allowlist h3_indexes do not match the pinned Natural Earth source"
        )


def verify_local(manifest_path: str, allowlist_path: str, source_path: str) -> dict[str, Any]:
    manifest = load_json(manifest_path)
    _validate_manifest_metadata(manifest)
    artifact_bytes = _read_bytes(allowlist_path)
    artifact, leaves = parse_valid_allowlist(json.loads(artifact_bytes.decode("utf-8")))
    source, source_bytes = read_text_bytes(source_path)
    root = merkle_root_from_leaves(leaves)
    if root is None:
        raise ResidenceAllowlistError("allowlist must contain at least one h3_index")

    artifact_sha256 = f"0x{sha256_hex(artifact_bytes)}"
    byte_size = len(artifact_bytes)
    h3_count = len(leaves)
    merkle_root = prefixed_hex(root)

    _assert_manifest_field("artifact.sha256", manifest["artifact"].get("sha256"), artifact_sha256)
    _assert_manifest_field("artifact.merkle_root", manifest["artifact"].get("merkle_root"), merkle_root)
    _assert_manifest_value("artifact.byte_size", manifest["artifact"].get("byte_size"), byte_size)
    _assert_manifest_value("artifact.h3_count", manifest["artifact"].get("h3_count"), h3_count)
    _assert_manifest_value("manifest.geo_resolution", manifest["geo_resolution"], artifact["geo_resolution"])
    _assert_manifest_value(
        "manifest.allowlist_version",
        manifest["allowlist_version"],
        artifact["allowlist_version"],
    )
    _assert_manifest_value("manifest.source.sha256", manifest["source"]["sha256"], sha256_hex(source_bytes))
    validate_allowlist_matches_source(artifact, source, source_bytes)

    return {
        "status": "verified",
        "sha256": artifact_sha256,
        "byte_size": byte_size,
        "h3_count": h3_count,
        "merkle_root": merkle_root,
    }


def root_output(allowlist_path: str, source_path: str) -> dict[str, Any]:
    artifact, leaves = load_verified_allowlist(allowlist_path, source_path)
    root = merkle_root_from_leaves(leaves)
    if root is None:
        raise ResidenceAllowlistError("allowlist must contain at least one h3_index")
    return {
        "merkle_root": prefixed_hex(root),
        "count": len(leaves),
        "geo_resolution": artifact["geo_resolution"],
        "allowlist_version": artifact["allowlist_version"],
    }


def proof_output(allowlist_path: str, source_path: str, raw_h3_index: str) -> dict[str, Any]:
    _, leaves = load_verified_allowlist(allowlist_path, source_path)
    h3_index = parse_h3_index(raw_h3_index)
    proof = generate_proof_for_h3_index(leaves, h3_index)
    if proof is None:
        raise ResidenceAllowlistError(f"h3_index {h3_index} is not in the residence allowlist")
    return proof


def parse_h3_index(value: Any) -> int:
    if not isinstance(value, str):
        raise ResidenceAllowlistError(f"h3_index must be a decimal u64 string: {value!r}")
    if not value:
        raise ResidenceAllowlistError("h3_index must not be empty")
    if not value.isdecimal():
        raise ResidenceAllowlistError(f"h3_index must be decimal: {value}")
    if value != "0" and value.startswith("0"):
        raise ResidenceAllowlistError(f"h3_index must not contain leading zeroes: {value}")
    parsed = int(value)
    if parsed < 0 or parsed > 0xFFFFFFFFFFFFFFFF:
        raise ResidenceAllowlistError(f"h3_index is outside the u64 range: {value}")
    if str(parsed) != value:
        raise ResidenceAllowlistError(f"h3_index is not canonical decimal: {value}")
    try:
        cell = h3.int_to_str(parsed)
        resolution = h3.get_resolution(cell)
    except Exception as error:
        raise ResidenceAllowlistError(f"h3_index is not a valid H3 cell index: {error}") from error
    if resolution != NATURAL_EARTH_LAND_SOURCE.resolution:
        raise ResidenceAllowlistError(
            f"h3_index resolution must be {NATURAL_EARTH_LAND_SOURCE.resolution}: {value}"
        )
    return parsed


def _source_metadata(source_bytes: bytes) -> dict[str, Any]:
    return {
        "kind": LOCAL_GEOJSON_SOURCE_KIND,
        "name": NATURAL_EARTH_LAND_SOURCE.source_name,
        "version": NATURAL_EARTH_LAND_SOURCE.version,
        "url": NATURAL_EARTH_LAND_SOURCE.url,
        "sha256": f"0x{sha256_hex(source_bytes)}",
        "byte_length": len(source_bytes),
    }


def _validate_allowlist_artifact(artifact: Any) -> None:
    if not isinstance(artifact, dict):
        raise ResidenceAllowlistError("allowlist artifact must be a JSON object")
    _require_keys(
        artifact,
        {
            "schema",
            "schema_version",
            "source",
            "geo_resolution",
            "allowlist_version",
            "h3_indexes",
        },
        "allowlist",
    )
    if artifact["schema"] != ALLOWLIST_SCHEMA:
        raise ResidenceAllowlistError(f"allowlist schema must be {ALLOWLIST_SCHEMA}")
    if artifact["schema_version"] != ALLOWLIST_SCHEMA_VERSION:
        raise ResidenceAllowlistError(
            f"allowlist schema_version must be {ALLOWLIST_SCHEMA_VERSION}"
        )
    if not isinstance(artifact["source"], dict):
        raise ResidenceAllowlistError("allowlist source must be an object")
    _require_keys(artifact["source"], {"kind", "name", "version", "url", "sha256", "byte_length"}, "allowlist source")
    if artifact["source"]["kind"] != LOCAL_GEOJSON_SOURCE_KIND:
        raise ResidenceAllowlistError(f"allowlist source.kind must be {LOCAL_GEOJSON_SOURCE_KIND}")
    if (
        artifact["source"]["name"] != NATURAL_EARTH_LAND_SOURCE.source_name
        or artifact["source"]["version"] != NATURAL_EARTH_LAND_SOURCE.version
        or artifact["source"]["url"] != NATURAL_EARTH_LAND_SOURCE.url
        or artifact["source"]["sha256"] != f"0x{NATURAL_EARTH_LAND_SOURCE.sha256}"
    ):
        raise ResidenceAllowlistError(
            "allowlist source metadata does not match pinned Natural Earth source"
        )
    if not _is_lower_prefixed_hex(artifact["source"]["sha256"], 32):
        raise ResidenceAllowlistError(
            "allowlist source.sha256 must be a lowercase 0x-prefixed SHA-256 hash"
        )
    if not isinstance(artifact["source"]["byte_length"], int) or artifact["source"]["byte_length"] <= 0:
        raise ResidenceAllowlistError("allowlist source.byte_length must be greater than zero")
    if artifact["geo_resolution"] != NATURAL_EARTH_LAND_SOURCE.resolution:
        raise ResidenceAllowlistError(
            f"allowlist geo_resolution must be {NATURAL_EARTH_LAND_SOURCE.resolution}"
        )
    if not isinstance(artifact["allowlist_version"], int) or artifact["allowlist_version"] < 0:
        raise ResidenceAllowlistError("allowlist allowlist_version must be a non-negative integer")
    indexes = artifact["h3_indexes"]
    if not isinstance(indexes, list) or not indexes:
        raise ResidenceAllowlistError("allowlist must contain at least one h3_index")

    previous: int | None = None
    for raw in indexes:
        current = parse_h3_index(raw)
        if previous is not None:
            if current == previous:
                raise ResidenceAllowlistError(f"duplicate h3_index in residence allowlist: {current}")
            if current < previous:
                raise ResidenceAllowlistError("allowlist h3_indexes must be sorted ascending")
        previous = current


def _validate_manifest_metadata(manifest: Any) -> None:
    if not isinstance(manifest, dict):
        raise ResidenceAllowlistError("manifest must be a JSON object")
    _require_keys(
        manifest,
        {
            "schema",
            "schema_version",
            "allowlist_version",
            "geo_resolution",
            "source",
            "generation_command",
            "local_artifact_path",
            "s3",
            "artifact",
        },
        "manifest",
    )
    if manifest["schema"] != MANIFEST_SCHEMA:
        raise ResidenceAllowlistError(f"manifest schema must be {MANIFEST_SCHEMA}")
    if manifest["schema_version"] != MANIFEST_SCHEMA_VERSION:
        raise ResidenceAllowlistError(f"manifest schema_version must be {MANIFEST_SCHEMA_VERSION}")
    if not isinstance(manifest["source"], dict):
        raise ResidenceAllowlistError("manifest source must be an object")
    _require_keys(manifest["source"], {"name", "version", "url", "sha256"}, "manifest source")
    if (
        manifest["source"]["name"] != NATURAL_EARTH_LAND_SOURCE.source_name
        or manifest["source"]["version"] != NATURAL_EARTH_LAND_SOURCE.version
        or manifest["source"]["url"] != NATURAL_EARTH_LAND_SOURCE.url
        or manifest["source"]["sha256"] != NATURAL_EARTH_LAND_SOURCE.sha256
    ):
        raise ResidenceAllowlistError(
            "manifest source metadata does not match pinned Natural Earth source"
        )
    if not _is_lower_hex(manifest["source"]["sha256"], 32):
        raise ResidenceAllowlistError(
            "manifest source.sha256 must be a lowercase SHA-256 hash"
        )
    if manifest["geo_resolution"] != NATURAL_EARTH_LAND_SOURCE.resolution:
        raise ResidenceAllowlistError(
            f"manifest geo_resolution must be {NATURAL_EARTH_LAND_SOURCE.resolution}"
        )
    if not isinstance(manifest["generation_command"], list) or not manifest["generation_command"]:
        raise ResidenceAllowlistError("manifest generation_command must not be empty")
    if not isinstance(manifest["s3"], dict):
        raise ResidenceAllowlistError("manifest s3 must be an object")
    _require_keys(manifest["s3"], {"bucket_env", "object_key", "version_id"}, "manifest s3")
    if manifest["s3"]["bucket_env"] != "SONARI_RESIDENCE_CELLS_BUCKET":
        raise ResidenceAllowlistError(
            "manifest s3.bucket_env must be SONARI_RESIDENCE_CELLS_BUCKET"
        )
    if not manifest["s3"]["object_key"]:
        raise ResidenceAllowlistError("manifest s3.object_key must not be empty")
    if not isinstance(manifest["artifact"], dict):
        raise ResidenceAllowlistError("manifest artifact must be an object")


def _sorted_leaf_hashes(leaves: list[ResidenceCellLeaf]) -> list[tuple[ResidenceCellLeaf, bytes]]:
    sorted_leaves = sorted(leaves, key=lambda leaf: leaf.h3_index)
    previous: int | None = None
    result: list[tuple[ResidenceCellLeaf, bytes]] = []
    for leaf in sorted_leaves:
        if previous == leaf.h3_index:
            raise ResidenceAllowlistError(f"duplicate h3_index in residence allowlist: {leaf.h3_index}")
        previous = leaf.h3_index
        result.append((leaf, leaf_hash(leaf)))
    return result


def _proof_step(direction: str, sibling_hash: bytes) -> dict[str, Any]:
    return {
        "direction": direction,
        "sibling_on_left": direction == "LEFT",
        "sibling_hash": prefixed_hex(sibling_hash),
    }


def _bcs_u64(value: int) -> bytes:
    if value < 0 or value > 0xFFFFFFFFFFFFFFFF:
        raise ResidenceAllowlistError(f"u64 value is out of range: {value}")
    return value.to_bytes(8, "little")


def _bcs_u8(value: int) -> bytes:
    if value < 0 or value > 0xFF:
        raise ResidenceAllowlistError(f"u8 value is out of range: {value}")
    return value.to_bytes(1, "little")


def _assert_hash(value: bytes, label: str) -> None:
    if len(value) != 32:
        raise ResidenceAllowlistError(f"{label} hash must be 32 bytes")


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as file:
        return file.read()


def _assert_manifest_field(field: str, actual: Any, expected: str) -> None:
    if actual is None:
        raise ResidenceAllowlistError(f"manifest {field} is required for local verification")
    _assert_manifest_value(field, actual, expected)


def _assert_manifest_value(field: str, actual: Any, expected: Any) -> None:
    if actual != expected:
        raise ResidenceAllowlistError(
            f"manifest {field} {actual} does not match computed {expected}"
        )


def _require_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value.keys())
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise ResidenceAllowlistError(f"{label} keys mismatch: missing={missing}, extra={extra}")


def _is_lower_prefixed_hex(value: Any, byte_len: int) -> bool:
    return isinstance(value, str) and value.startswith("0x") and _is_lower_hex(value[2:], byte_len)


def _is_lower_hex(value: Any, byte_len: int) -> bool:
    return (
        isinstance(value, str)
        and len(value) == byte_len * 2
        and all(char.isdigit() or "a" <= char <= "f" for char in value)
    )
