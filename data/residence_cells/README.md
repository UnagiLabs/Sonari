# Residence Cells Data

This directory owns local data tooling for the residence-cell allowlist.
It is not part of the Nautilus verifier runtime.

The tool generates an H3 resolution 7 land allowlist from the pinned Natural
Earth land GeoJSON. The generated allowlist body is a local/S3 artifact. The
contract-facing value is the resulting Merkle root and related metadata.

## Setup

Use `uv` from the repository root:

```bash
uv sync --project data/residence_cells
```

## Source

The pinned MVP source is:

```text
https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson
```

Expected SHA-256:

```text
1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416
```

Download it outside git, under `.build/residence-cells/`:

```bash
mkdir -p .build/residence-cells
curl -L \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson \
  -o .build/residence-cells/ne_10m_land.geojson
```

## Generate And Verify

```bash
uv run --project data/residence_cells residence-allowlist generate \
  --source .build/residence-cells/ne_10m_land.geojson \
  --output .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --allowlist-version 1
```

```bash
uv run --project data/residence_cells residence-allowlist root \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson
```

```bash
uv run --project data/residence_cells residence-allowlist proof \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson \
  --h3-index 608819013513904127
```

```bash
uv run --project data/residence_cells residence-allowlist verify-local \
  --manifest data/residence_cells/allowed_residence_cells_manifest.v1.res7.json \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson
```

`root`, `proof`, and `verify-local` do not trust artifact metadata alone.
They re-read the pinned source and regenerate H3 indexes before emitting a
root, proof, or verified result.

## S3 Artifact

The full allowlist body should not be committed to git. Upload the gzipped
artifact to the bucket named by `SONARI_RESIDENCE_CELLS_BUCKET`:

```bash
gzip -c .build/residence-cells/allowed_residence_cells.v1.res7.json \
  > .build/residence-cells/allowed_residence_cells.v1.res7.json.gz
aws s3 cp \
  .build/residence-cells/allowed_residence_cells.v1.res7.json.gz \
  "s3://${SONARI_RESIDENCE_CELLS_BUCKET}/residence-cells/v1/res7/allowed_residence_cells.v1.res7.json.gz"
```

After upload, update `allowed_residence_cells_manifest.v1.res7.json` with the
artifact SHA-256, byte size, H3 count, Merkle root, generated timestamp, and
S3 version ID if the bucket has versioning enabled.
