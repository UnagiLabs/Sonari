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

Publication timestamp: `2026-06-19T05:06:26Z`

| item | value |
| --- | --- |
| bucket | `sonari-residence-proofs-v1-res7` |
| prefix | `residence-cells/v1/res7/tiles/` |
| public base URL | `https://pub-1172ab70c04d41b79ffd162fa84d9c97.r2.dev` |
| tile manifest key | `residence-cells/v1/res7/tiles/tile_manifest.json` |
| R2 exact tile manifest SHA-256 | `10c0c4927a1dcdd67217582c204d03d577d944e39ddf092c6849b48a85ff61f4` |
| R2 exact tile manifest byte size | `24726313` |
| pre-upload dry-run upload/copy count | `88915` |
| pre-upload dry-run delete count | `0` |
| post-upload dry-run upload/copy count | `0` |
| post-upload dry-run delete count | `0` |
| local tile file count | `90282` |
| R2 readback tile file count | `90282` |
| R2 readback `verify-tiles` status | `verified` |
| R2 readback verified tiles | `90282` |

`r2.dev` public access was enabled for this bucket because no custom domain was
connected and public access via the `r2.dev` URL was initially disabled. The
public URL was used only for distribution checks. The SHA-256 above was computed
from `tile_manifest.json` bytes fetched back from R2.

```bash
wrangler r2 bucket domain list sonari-residence-proofs-v1-res7
wrangler r2 bucket dev-url get sonari-residence-proofs-v1-res7
wrangler r2 bucket dev-url enable sonari-residence-proofs-v1-res7

aws s3 sync --delete \
  .build/residence-cells/tiles/v1/res7/ \
  "s3://sonari-residence-proofs-v1-res7/residence-cells/v1/res7/tiles/" \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

aws s3 sync --dryrun --delete \
  .build/residence-cells/tiles/v1/res7/ \
  "s3://sonari-residence-proofs-v1-res7/residence-cells/v1/res7/tiles/" \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  > .build/residence-cells/r2-tiles-sync-post-dryrun.txt

aws s3 cp \
  "s3://sonari-residence-proofs-v1-res7/residence-cells/v1/res7/tiles/tile_manifest.json" \
  .build/residence-cells/r2-tile-manifest.json \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

curl -fsS \
  "https://pub-1172ab70c04d41b79ffd162fa84d9c97.r2.dev/residence-cells/v1/res7/tiles/tile_manifest.json" \
  -o .build/residence-cells/public-tile-manifest.json

aws s3 sync \
  "s3://sonari-residence-proofs-v1-res7/residence-cells/v1/res7/tiles/" \
  .build/residence-cells/r2-tiles/v1/res7/ \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

cargo run --release --manifest-path data/residence_cells/Cargo.toml -- verify-tiles \
  --tile-manifest .build/residence-cells/r2-tiles/v1/res7/tile_manifest.json \
  --tiles-dir .build/residence-cells/r2-tiles/v1/res7/res4 \
  --proof-manifest .build/residence-cells/proof-shards/v1/res7/proof_manifest.json
```

## GitHub Variables And Remote Checks

The following GitHub environment Variables were set on
`aws-sonari-verifier-runner-dev`:

| variable | value |
| --- | --- |
| `SONARI_RESIDENCE_R2_BASE_URL` | `https://pub-1172ab70c04d41b79ffd162fa84d9c97.r2.dev` |
| `SONARI_RESIDENCE_TILE_MANIFEST_KEY` | `residence-cells/v1/res7/tiles/tile_manifest.json` |
| `SONARI_RESIDENCE_TILE_MANIFEST_SHA256` | `10c0c4927a1dcdd67217582c204d03d577d944e39ddf092c6849b48a85ff61f4` |
| `SONARI_RESIDENCE_R2_OBJECT_PREFIX` | `residence-cells/v1/res7/tiles` |
| `SONARI_RESIDENCE_R2_BUCKET` | `sonari-residence-proofs-v1-res7` |
| `SONARI_RESIDENCE_ALLOWLIST_VERSION` | `1` |

The existing repository Variables were read back and left unchanged:

| variable | value |
| --- | --- |
| `SONARI_GEO_RESOLUTION` | `7` |
| `SONARI_RESIDENCE_ROOT` | `0x339601f3f8fc103fbbf526b39537235d7f6ad033a236f8c59f60498240a11ecc` |
| `SONARI_RESIDENCE_SOURCE_HASH` | `0x4e47e035541b6915f9afb2d87237e1d8562063a1946e5ec91618bd1b260f2108` |

Remote Worker checks:

| check | result |
| --- | --- |
| `GET /api/residence-tiles/meta` | `200`; schema `sonari.residence.tile_manifest.v1`, tile count `90282`, total cell count `28175220`, root `0x339601f3f8fc103fbbf526b39537235d7f6ad033a236f8c59f60498240a11ecc` |
| `GET /api/residence-tiles/v1/res7/8400011ffffffff.json` | `200`; schema `sonari.residence.tile.v1`, `13` cells |
| `GET /api/residence-tiles/v1/res7/8400001ffffffff.json` | `404`; `tile_not_found` for an absent parent not present in the manifest |

```bash
gh variable set SONARI_RESIDENCE_R2_BASE_URL \
  --repo UnagiLabs/Sonari \
  --env aws-sonari-verifier-runner-dev \
  --body "https://pub-1172ab70c04d41b79ffd162fa84d9c97.r2.dev"

gh variable set SONARI_RESIDENCE_TILE_MANIFEST_KEY \
  --repo UnagiLabs/Sonari \
  --env aws-sonari-verifier-runner-dev \
  --body "residence-cells/v1/res7/tiles/tile_manifest.json"

gh variable set SONARI_RESIDENCE_TILE_MANIFEST_SHA256 \
  --repo UnagiLabs/Sonari \
  --env aws-sonari-verifier-runner-dev \
  --body "10c0c4927a1dcdd67217582c204d03d577d944e39ddf092c6849b48a85ff61f4"

gh variable set SONARI_RESIDENCE_R2_OBJECT_PREFIX \
  --repo UnagiLabs/Sonari \
  --env aws-sonari-verifier-runner-dev \
  --body "residence-cells/v1/res7/tiles"

gh variable set SONARI_RESIDENCE_R2_BUCKET \
  --repo UnagiLabs/Sonari \
  --env aws-sonari-verifier-runner-dev \
  --body "sonari-residence-proofs-v1-res7"

gh variable set SONARI_RESIDENCE_ALLOWLIST_VERSION \
  --repo UnagiLabs/Sonari \
  --env aws-sonari-verifier-runner-dev \
  --body "1"

curl -fsS \
  "https://sonari-residence-proof-worker.bububutasan00.workers.dev/api/residence-tiles/meta"
```
