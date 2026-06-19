# Residence Tile Artifacts

This file records non-secret publication evidence for residence tile artifacts.
Generated artifact bodies stay under `.build/` and are not committed.

## Issue 472 Run

Run timestamp: `2026-06-19T03:50:06Z`

### Local Inputs

| item | value |
| --- | --- |
| allowlist path | `.build/residence-cells/allowed_residence_cells.v1.res7.json` |
| source path | `.build/residence-cells/ne_10m_land.geojson` |
| proof manifest path | `.build/residence-cells/proof-shards/v1/res7/proof_manifest.json` |
| proof manifest SHA-256 | `70f06360c284db741b8fb8a6953a1d78a94a48c0b32044b8d3c26aa15fb9b4b4` |
| proof manifest byte size | `16438830` |

### Local Verification

`verify-local` succeeded with the existing allowlist manifest.

| field | value |
| --- | --- |
| status | `verified` |
| allowlist SHA-256 | `0x4e47e035541b6915f9afb2d87237e1d8562063a1946e5ec91618bd1b260f2108` |
| allowlist byte size | `732556200` |
| H3 count | `28175220` |
| Merkle root | `0x339601f3f8fc103fbbf526b39537235d7f6ad033a236f8c59f60498240a11ecc` |

`verify-tiles` succeeded against the R2 proof manifest downloaded locally.

| field | value |
| --- | --- |
| status | `verified` |
| schema | `sonari.residence.tile_manifest.v1` |
| allowlist version | `1` |
| geo resolution | `7` |
| tile parent resolution | `4` |
| tile manifest SHA-256 | `10c0c4927a1dcdd67217582c204d03d577d944e39ddf092c6849b48a85ff61f4` |
| tile manifest byte size | `24726313` |
| tile count | `90282` |
| tile file count | `90282` |
| total cell count | `28175220` |
| verified tiles | `90282` |
| Merkle root | `0x339601f3f8fc103fbbf526b39537235d7f6ad033a236f8c59f60498240a11ecc` |

### Commands

```bash
cargo run --release --manifest-path data/residence_cells/Cargo.toml -- verify-local \
  --manifest data/residence_cells/allowed_residence_cells_manifest.v1.res7.json \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson \
  --strategy tiler

wrangler r2 object get \
  "sonari-residence-proofs-v1-res7/residence-cells/v1/res7/proofs/proof_manifest.json" \
  --remote \
  --file .build/residence-cells/proof-shards/v1/res7/proof_manifest.json

cargo test --manifest-path data/residence_cells/Cargo.toml --test tile_shards

cargo run --release --manifest-path data/residence_cells/Cargo.toml -- tiles \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson \
  --output-dir .build/residence-cells/tiles/v1/res7

cargo run --release --manifest-path data/residence_cells/Cargo.toml -- verify-tiles \
  --tile-manifest .build/residence-cells/tiles/v1/res7/tile_manifest.json \
  --tiles-dir .build/residence-cells/tiles/v1/res7/res4 \
  --proof-manifest .build/residence-cells/proof-shards/v1/res7/proof_manifest.json
```

## R2 Publication

Pending STEP 3.

## GitHub Variables And Remote Checks

Pending STEP 4.
