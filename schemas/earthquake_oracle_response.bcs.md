# Earthquake Oracle Response BCS Payload

このファイルは、repository rootの `schemas/` に置くroot共通仕様です。Sonari Earthquake Oracle BCS Payloadのcanonical field orderを定義し、Rust、TypeScript、Moveは必ず同じフィールドを同じ順序でserializeします。

## Scope

MVPでは `finalized` PayloadだけをSuiへ投稿します。`pending_source`、`pending_mmi`、`rejected` はDynamoDB内だけで管理するoffchain stateです。

## Field Order

MVPでは以下の28 field orderをcurrent contractとして固定します。MVP中は後方互換性を持たせず、Rust、TypeScript、Python、Moveはこの1つのpayload shapeだけを扱います。field追加、順序変更、型変更、enum値変更が必要な場合は、このcurrent contract、schema、fixture / golden vector、Rust / TypeScript / Python / Moveの検証を同時に更新します。

| 順序 | Field | Type | 要件 |
| --: | --- | --- | --- |
| 1 | `intent` | `u8` | `1` Sonari Earthquake Oracle専用intent |
| 2 | `oracle_version` | `u64` | MVP single valueは `1` |
| 3 | `event_uid` | `[u8; 32]` | 決定的に生成されるevent id |
| 4 | `hazard_type` | `u8` | `1` EARTHQUAKE |
| 5 | `status` | `u8` | `3` FINALIZED |
| 6 | `event_revision` | `u32` | `>= 1`。TEEがsource manifestから決定するSonari Finalized Revision |
| 7 | `source_event_id` | `vector<u8>` | UTF-8 bytes。USGS detail `id`。`1..96` bytes |
| 8 | `title` | `vector<u8>` | UTF-8 bytes。USGS `properties.title`。`1..160` bytes |
| 9 | `region` | `vector<u8>` | UTF-8 bytes。USGS `properties.place`。`1..160` bytes |
| 10 | `occurred_at_ms` | `u64` | source上の地震発生時刻 |
| 11 | `magnitude_x100` | `u64` | USGS `properties.mag` を小数第2位へ丸めて100倍した整数。`1..2000` |
| 12 | `verified_at_ms` | `u64` | TEE検証時刻。MVP pathでは現在の決定的timestamp sourceである `observed_at_ms` を使う |
| 13 | `source_updated_at_ms` | `u64` | 採用sourceの更新時刻 |
| 14 | `primary_source` | `u8` | `1` USGS |
| 15 | `severity_band` | `u8` | `1..3`。affected cellsの最大 `cell_band` |
| 16 | `source_set_hash` | `[u8; 32]` | canonical source manifestのhash |
| 17 | `raw_data_hash` | `[u8; 32]` | canonical raw data manifest JSON bytesのhash |
| 18 | `raw_data_uri` | `vector<u8>` | UTF-8 bytes。`1..512` bytes |
| 19 | `affected_cells_root` | `[u8; 32]` | `cell_band >= 1` のClaim対象セルだけを含むMerkle root |
| 20 | `affected_cells_uri` | `vector<u8>` | UTF-8 bytes。`1..512` bytes |
| 21 | `affected_cells_data_hash` | `[u8; 32]` | affected cells file全体のhash |
| 22 | `affected_cell_count` | `u64` | `1..1_000_000` |
| 23 | `geo_resolution` | `u8` | `7` |
| 24 | `cells_generation_method` | `u8` | `1` SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1 |
| 25 | `cell_metric` | `u8` | `1` USGS_MMI |
| 26 | `cell_aggregation` | `u8` | `1` GRID_POINT_P90 |
| 27 | `intensity_scale` | `u8` | `1` MMI_X100 |
| 28 | `freshness_deadline_ms` | `u64` | `verified_at_ms + FRESHNESS_WINDOW_MS`。必ず `verified_at_ms` より後 |

## Enum Values

| Enum | Value | 意味 |
| --- | --: | --- |
| `intent.SONARI_EARTHQUAKE_ORACLE` | `1` | Sonari Earthquake Oracle Payload |
| `hazard_type.EARTHQUAKE` | `1` | 地震のみ |
| `status.FINALIZED` | `3` | onchainで受理できるfinalized Payload |
| `primary_source.USGS` | `1` | USGS |
| `cells_generation_method.SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1` | `1` | MVPのShakeMap grid.xml方式 |
| `cells_generation_method.SHAKEMAP_HDF_H3_WEIGHTED_P90_V1` | `2` | Futureの高精度方式 |
| `cell_metric.USGS_MMI` | `1` | USGS MMI |
| `cell_aggregation.GRID_POINT_P90` | `1` | grid pointをH3へ割り当て、セルごとにP90を取る |
| `intensity_scale.MMI_X100` | `1` | MMIを100倍した値 |

## Hash And Encoding Rules

- すべての整数は標準BCSのlittle-endian encodingを使います。
- URIを表す `vector<u8>` はUTF-8 bytesです。Move側では文字列正規化を行いません。
- `[u8; 32]` のフィールドは必ず32 bytesです。
- Payload署名は、上記field orderでserializeしたBCS bytesに対して行います。
- `cell_band` は `MMI_X100` の値で決定します: `band0` は `< 700`、`band1` は `700..=749`、`band2` は `750..=799`、`band3` は `>= 800` です。`affected_cells_root` は `band1..band3` のClaim対象セルのみを含みます。
- `severity_band` はClaim対象セルの最大 `cell_band` です。このthreshold変更により、MMI 8.00以上のセルは `band3` になります。
- `event_uid` は以下で固定します。

```txt
event_uid = SHA-256(
  utf8("sonari:event_uid:v1") ||
  u8(hazard_type) ||
  u32_le(len(primary_source)) || utf8(primary_source) ||
  u32_le(len(source_event_id)) || utf8(source_event_id) ||
  u64_le(occurred_at_ms)
)
```

- `event_uid` 生成時の `primary_source` はPayload enum名ではなくsource name文字列です。MVPでは `USGS` を使います。
- `source_set_hash = SHA-256(canonical_source_manifest_json_bytes)` です。
- `raw_data_hash = SHA-256(canonical_raw_data_manifest_json_bytes)` です。raw source bytesを単純結合してhashしてはいけません。Production finalized の raw data manifest entries には Walrus の content-addressed blob id と raw source hash を含め、`entries[].uri = walrus://blob/<blob_id>` を raw source の canonical reference とします。`raw_data_uri` は manifest の配送先 URI であり、manifest 自体の Walrus 保存を署名対象にはしません。
- `affected_cells_data_hash = SHA-256(canonical_affected_cells_json_bytes)` です。
- `affected_cells_root` とMerkle leaf / internal node hashはすべて `SHA-256` です。詳細は `schemas/affected_cell_leaf.md` に従います。
- `properties.mag` はdecimal文字列表現として扱い、小数第3位が `5` 以上なら繰り上げます。例: `7.234 -> 723`、`7.235 -> 724`、`7.995 -> 800`。
- `freshness_deadline_ms` はDynamoDB上の72時間finalization deadlineとは別物です。
- finalized Payloadでは `status = FINALIZED`、`affected_cells_uri` non-empty、`affected_cell_count = 1..1_000_000`、`freshness_deadline_ms = verified_at_ms + FRESHNESS_WINDOW_MS` を必須とします。
