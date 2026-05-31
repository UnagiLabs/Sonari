from __future__ import annotations

import copy
import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import h3

from residence_cells_allowlist import core

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "compact_land.geojson"


def fixture_source() -> tuple[str, bytes]:
    data = FIXTURE_PATH.read_bytes()
    return data.decode("utf-8"), data


def fixture_source_manifest() -> core.LandSourceManifest:
    _, data = fixture_source()
    return core.LandSourceManifest(
        source_name="Natural Earth ne_10m_land",
        version="v5.1.2",
        url="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson",
        sha256=hashlib.sha256(data).hexdigest(),
        resolution=7,
        containment_mode="h3.h3shape_to_cells_experimental(contain='overlap')",
    )


class ResidenceAllowlistCoreTest(unittest.TestCase):
    def test_pins_residence_leaf_bcs_and_hashes(self) -> None:
        leaves = [
            core.ResidenceCellLeaf(608_819_013_513_904_127, 7, 1),
            core.ResidenceCellLeaf(608_819_013_597_790_207, 7, 1),
            core.ResidenceCellLeaf(608_819_013_681_676_287, 7, 1),
        ]

        self.assertEqual(
            core.leaf_bcs_bytes(leaves[0]).hex(),
            "ffffffc8aaf57208070100000000000000",
        )
        leaf_hashes = [core.leaf_hash(leaf) for leaf in leaves]
        self.assertEqual(
            leaf_hashes[0].hex(),
            "07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569",
        )
        self.assertEqual(
            leaf_hashes[1].hex(),
            "fa0172aedc1751590d58bd2c91d8e37aca3b9c4b4a330c7330440b5203806c4e",
        )
        self.assertEqual(
            leaf_hashes[2].hex(),
            "8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
        )
        self.assertEqual(
            core.internal_node_hash(leaf_hashes[0], leaf_hashes[1]).hex(),
            "312e3863ccf00e446423342e1acebdab8e7119ee19dae854904de693225c2678",
        )
        self.assertEqual(
            core.merkle_root_from_leaf_hashes(leaf_hashes).hex(),
            "a26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020",
        )

    def test_generated_proof_replays_to_root(self) -> None:
        leaves = [
            core.ResidenceCellLeaf(608_819_013_513_904_127, 7, 1),
            core.ResidenceCellLeaf(608_819_013_597_790_207, 7, 1),
            core.ResidenceCellLeaf(608_819_013_681_676_287, 7, 1),
        ]
        proof = core.generate_proof_for_h3_index(leaves, leaves[1].h3_index)

        self.assertIsNotNone(proof)
        self.assertEqual(proof["target_h3_index"], str(leaves[1].h3_index))
        self.assertEqual(proof["steps"][0]["direction"], "LEFT")
        self.assertTrue(proof["steps"][0]["sibling_on_left"])
        self.assertEqual(proof["steps"][1]["direction"], "RIGHT")
        self.assertFalse(proof["steps"][1]["sibling_on_left"])
        self.assertEqual(
            proof["expected_root"],
            "0xa26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020",
        )

    def test_generated_h3_indexes_are_sorted_unique_and_overlap_based(self) -> None:
        source, _ = fixture_source()
        candidates = core.generate_candidate_h3_indexes_from_geojson(source)

        self.assertTrue(candidates)
        self.assertEqual(candidates, sorted(set(candidates)))

        geometry = json.loads(source)["features"][0]["geometry"]
        center_cells = {
            h3.str_to_int(cell)
            for cell in h3.h3shape_to_cells(h3.geo_to_h3shape(geometry), 7)
        }
        self.assertTrue(set(candidates) - center_cells)

    def test_malformed_geojson_source_fails_closed(self) -> None:
        with self.assertRaises(core.ResidenceAllowlistError):
            core.generate_candidate_h3_indexes_from_geojson("{")
        with self.assertRaises(core.ResidenceAllowlistError):
            core.generate_candidate_h3_indexes_from_geojson(
                '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[0,0]}}]}'
            )

    def test_validate_allowlist_rejects_indexes_not_regenerated_from_source(self) -> None:
        source, source_bytes = fixture_source()
        with patch.object(core, "NATURAL_EARTH_LAND_SOURCE", fixture_source_manifest()):
            artifact = core.build_allowlist_artifact(source, source_bytes, 42)
            tampered = copy.deepcopy(artifact)
            tampered["h3_indexes"] = tampered["h3_indexes"][:-1]

            with self.assertRaisesRegex(
                core.ResidenceAllowlistError,
                "allowlist h3_indexes do not match",
            ):
                core.validate_allowlist_matches_source(tampered, source, source_bytes)

    def test_validate_allowlist_rejects_source_byte_length_mismatch(self) -> None:
        source, source_bytes = fixture_source()
        with patch.object(core, "NATURAL_EARTH_LAND_SOURCE", fixture_source_manifest()):
            artifact = core.build_allowlist_artifact(source, source_bytes, 42)
            artifact["source"]["byte_length"] += 1

            with self.assertRaisesRegex(core.ResidenceAllowlistError, "source.byte_length"):
                core.validate_allowlist_matches_source(artifact, source, source_bytes)


if __name__ == "__main__":
    unittest.main()
