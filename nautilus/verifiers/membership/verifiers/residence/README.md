# Residence Cell Verifier

この README は、旧 residence verifier docs を自己申告の居住セル検証に
re-scope する。
ここで扱うのは本人確認ではない。
Membership identity verifier の KYC / World ID と責務を混ぜない。
地震 verifier の affected cells 生成とも責務を混ぜない。

## 目的

Residence verifier は、ユーザーが申告した H3 resolution 7 の居住セルが、
登録可能な陸地セルであることを検証する。

MVP では `land_allowlist_res7` を使う。
`land_allowlist_res7` は H3 resolution 7 の land allowlist である。
申告 cell がこの allowlist に含まれる場合だけ、居住 metadata として
登録できる。

海のみの cell は reject する。
海のみの H3 cell を residence cell として登録してはいけない。

## Data source

MVP の preferred source は Natural Earth である。
Natural Earth の land polygon から H3 resolution 7 の land allowlist を作る。
選んだ Natural Earth land polygon と少しでも重なる H3 resolution 7 cell は
`land_allowlist_res7` に含める。
land polygon と重ならない ocean-only cell だけを除外する。
cell 中心点だけが陸地かどうか、または cell 全体が陸地かどうかでは判定しない。

OSM land polygons は将来候補である。
OSM は coastline や島の detail を改善できる可能性があるが、
MVP の必須 source ではない。

MVP では、小さな無人島や複雑な海岸線の厳密な precision を要求しない。
H3 resolution 7 と Natural Earth の粒度で、陸地として扱うかを決める。
境界 cell の細かい判定差は、MVP では許容する。

## Trust boundary

dApp の validation は UX のためである。
ユーザーが海のみの cell を選んだ場合に、早く feedback を出してよい。
ただし、dApp validation は信頼しない。

必須の validation は TEE / verifier 側で行う。
TEE / verifier は、申告された residence cell が `land_allowlist_res7` に
含まれることを検証する。
allowlist に含まれない cell、または海のみの cell は reject する。

dApp と relayer は配送者である。
dApp / relayer は verified residence metadata result の意味を変更しない。
payload を作り替えない。
allowlist membership の判定者にならない。

Move / metadata verifier は signed result を検証して適用する。
TEE が Membership SBT を直接 mutate するわけではない。

## Verifier output

TEE は検証済みの residence metadata result に署名する。
この result は「この membership に対して、この H3 resolution 7 cell は
登録可能な residence cell として検証済みである」という metadata 用の
結果である。

result には少なくとも次の意味を持たせる。

- verifier family と version
- membership id
- owner wallet
- residence H3 cell
- H3 resolution 7 であること
- `land_allowlist_res7` の識別子または commitment
- verified flag
- issued time
- expiry time が必要ならその値
- signed statement hash

`land_allowlist_res7` の具体的な保存形式はこの段階では固定しない。
JSON、binary set、Merkle tree、hash commitment などの候補を残す。
ただし、TEE / verifier と Move / metadata verifier が同じ対象を検証できる
形式でなければならない。

## Local allowlist artifact CLI

Allowlist artifact generation is local-file based in this step.
Network fetch, upload, and remote verification are outside this CLI boundary.

Intended large local outputs should be written under `.build/residence-cells/`:

```bash
mkdir -p .build/residence-cells
cargo run -p residence-allowlist -- generate \
  --source .build/residence-cells/ne_10m_land.geojson \
  --output .build/residence-cells/land_allowlist_res7.json
cargo run -p residence-allowlist -- root \
  --allowlist .build/residence-cells/land_allowlist_res7.json
cargo run -p residence-allowlist -- proof \
  --allowlist .build/residence-cells/land_allowlist_res7.json \
  --h3-index 608819013513904127
cargo run -p residence-allowlist -- verify-local \
  --manifest data/residence_cells/allowed_residence_cells_manifest.v1.res7.json \
  --allowlist .build/residence-cells/land_allowlist_res7.json
```

The generated JSON stores schema/version metadata, local source metadata,
resolution, allowlist version, and sorted unique decimal H3 indexes.
`root` and `proof` reject malformed artifacts instead of inferring missing
or mismatched metadata.
`verify-local` checks file SHA-256, byte size, H3 count, resolution,
allowlist version, and Merkle root against the manifest.

The committed manifest is a production placeholder until full generation and
S3 upload are performed. After generation, fill in `artifact.sha256`,
`artifact.byte_size`, `artifact.h3_count`, `artifact.merkle_root`, and
`artifact.generated_at`.

Optional S3 upload uses the bucket from `SONARI_RESIDENCE_CELLS_BUCKET`.
This keeps the bucket name out of git:

```bash
gzip -c .build/residence-cells/land_allowlist_res7.json \
  > .build/residence-cells/allowed_residence_cells.v1.res7.json.gz
aws s3 cp \
  .build/residence-cells/allowed_residence_cells.v1.res7.json.gz \
  "s3://${SONARI_RESIDENCE_CELLS_BUCKET}/residence-cells/v1/res7/allowed_residence_cells.v1.res7.json.gz"
aws s3api head-object \
  --bucket "${SONARI_RESIDENCE_CELLS_BUCKET}" \
  --key residence-cells/v1/res7/allowed_residence_cells.v1.res7.json.gz
```

Live S3 upload was not performed when this repository support was added.

## Rejection rules

次の入力は reject する。

- H3 resolution 7 ではない residence cell
- `land_allowlist_res7` に含まれない cell
- 海のみの cell
- membership id や owner wallet と署名対象が一致しない result
- expired result

MVP では、Natural Earth の粒度で陸地に含まれる cell を許容する。
小さな無人島や海岸線の厳密な補正は MVP の要件ではない。
