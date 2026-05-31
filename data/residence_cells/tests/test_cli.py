from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from residence_cells_allowlist import core
from residence_cells_allowlist.cli import main

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


def run_cli(args: list[str]) -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        status = main(args)
    return status, stdout.getvalue(), stderr.getvalue()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def expected_root_hex(artifact: dict[str, object]) -> str:
    leaves = [
        core.ResidenceCellLeaf(
            h3_index=int(index),
            geo_resolution=int(artifact["geo_resolution"]),
            allowlist_version=int(artifact["allowlist_version"]),
        )
        for index in artifact["h3_indexes"]
    ]
    root = core.merkle_root_from_leaves(leaves)
    assert root is not None
    return f"0x{root.hex()}"


def manifest_for(source_path: Path, allowlist_path: Path, artifact: dict[str, object]) -> dict[str, object]:
    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    return {
        "schema": "sonari.residence.allowlist.manifest.v1",
        "schema_version": 1,
        "allowlist_version": artifact["allowlist_version"],
        "geo_resolution": artifact["geo_resolution"],
        "source": {
            "name": "Natural Earth ne_10m_land",
            "version": "v5.1.2",
            "url": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson",
            "sha256": source_hash,
        },
        "generation_command": [
            "uv",
            "run",
            "--project",
            "data/residence_cells",
            "residence-allowlist",
            "generate",
        ],
        "local_artifact_path": ".build/residence-cells/allowed_residence_cells.v1.res7.json",
        "s3": {
            "bucket_env": "SONARI_RESIDENCE_CELLS_BUCKET",
            "object_key": "residence-cells/v1/res7/allowed_residence_cells.v1.res7.json.gz",
            "version_id": None,
        },
        "artifact": {
            "status": "local_test_fixture",
            "generated_at": None,
            "sha256": f"0x{hashlib.sha256(allowlist_path.read_bytes()).hexdigest()}",
            "byte_size": allowlist_path.stat().st_size,
            "h3_count": len(artifact["h3_indexes"]),
            "merkle_root": expected_root_hex(artifact),
        },
    }


class ResidenceAllowlistCliTest(unittest.TestCase):
    def test_help_succeeds(self) -> None:
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            with self.assertRaises(SystemExit) as error:
                main(["--help"])

        self.assertEqual(error.exception.code, 0)
        self.assertIn("generate", stdout.getvalue())
        self.assertIn("verify-local", stdout.getvalue())

    def test_generate_rejects_unpinned_fixture_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "allowlist.json"
            status, stdout, stderr = run_cli(
                [
                    "generate",
                    "--source",
                    str(FIXTURE_PATH),
                    "--output",
                    str(output_path),
                    "--allowlist-version",
                    "42",
                ]
            )

            self.assertEqual(status, 1)
            self.assertEqual(stdout, "")
            self.assertIn("source file does not match pinned Natural Earth source", stderr)
            self.assertFalse(output_path.exists())

    def test_generate_root_proof_and_verify_local_with_patched_fixture_pin(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "compact_land.geojson"
            source_path.write_bytes(FIXTURE_PATH.read_bytes())
            allowlist_path = Path(directory) / "allowlist.json"
            manifest_path = Path(directory) / "manifest.json"

            with patch.object(core, "NATURAL_EARTH_LAND_SOURCE", fixture_source_manifest()):
                status, _, stderr = run_cli(
                    [
                        "generate",
                        "--source",
                        str(source_path),
                        "--output",
                        str(allowlist_path),
                        "--allowlist-version",
                        "42",
                    ]
                )
                self.assertEqual(status, 0, stderr)
                artifact = json.loads(allowlist_path.read_text(encoding="utf-8"))
                self.assertEqual(artifact["allowlist_version"], 42)

                status, stdout, stderr = run_cli(
                    [
                        "root",
                        "--allowlist",
                        str(allowlist_path),
                        "--source",
                        str(source_path),
                    ]
                )
                self.assertEqual(status, 0, stderr)
                root = json.loads(stdout)
                self.assertEqual(root["merkle_root"], expected_root_hex(artifact))
                self.assertEqual(root["count"], len(artifact["h3_indexes"]))

                status, stdout, stderr = run_cli(
                    [
                        "proof",
                        "--allowlist",
                        str(allowlist_path),
                        "--source",
                        str(source_path),
                        "--h3-index",
                        artifact["h3_indexes"][0],
                    ]
                )
                self.assertEqual(status, 0, stderr)
                proof = json.loads(stdout)
                self.assertEqual(proof["target_h3_index"], artifact["h3_indexes"][0])
                self.assertEqual(proof["expected_root"], expected_root_hex(artifact))

                write_json(manifest_path, manifest_for(source_path, allowlist_path, artifact))
                status, stdout, stderr = run_cli(
                    [
                        "verify-local",
                        "--manifest",
                        str(manifest_path),
                        "--allowlist",
                        str(allowlist_path),
                        "--source",
                        str(source_path),
                    ]
                )
                self.assertEqual(status, 0, stderr)
                verified = json.loads(stdout)
                self.assertEqual(verified["status"], "verified")

    def test_root_rejects_artifact_indexes_not_regenerated_from_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "compact_land.geojson"
            source_path.write_bytes(FIXTURE_PATH.read_bytes())
            allowlist_path = Path(directory) / "allowlist.json"

            with patch.object(core, "NATURAL_EARTH_LAND_SOURCE", fixture_source_manifest()):
                source, source_bytes = core.read_text_bytes(str(source_path))
                artifact = core.build_allowlist_artifact(source, source_bytes, 42)
                tampered = copy.deepcopy(artifact)
                tampered["h3_indexes"] = tampered["h3_indexes"][:-1]
                write_json(allowlist_path, tampered)

                status, stdout, stderr = run_cli(
                    [
                        "root",
                        "--allowlist",
                        str(allowlist_path),
                        "--source",
                        str(source_path),
                    ]
                )

            self.assertEqual(status, 1)
            self.assertEqual(stdout, "")
            self.assertIn("allowlist h3_indexes do not match", stderr)


if __name__ == "__main__":
    unittest.main()
