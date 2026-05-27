# Earthquake Oracle Response BCS Payload

このファイルは、repository rootの `schemas/` に置くroot共通仕様です。Sonari Earthquake Oracle BCS Payloadのcanonical field orderを定義し、Rust、TypeScript、Moveは必ず同じフィールドを同じ順序でserializeします。

## Scope

MVPでは `finalized` PayloadだけをSuiへ投稿します。`pending_source`、`pending_mmi`、`rejected` はDynamoDB内だけで管理するoffchain stateです。

## Field Order

`oracle_version = 1` では、以下の26 field orderをimmutable contractとして固定します。field追加、順序変更、型変更、enum値変更が必要な場合は、`oracle_version` をbumpし、新しいschemaとgolden vectorを追加します。

MVP中の破壊的変更として、v1のdigest contractはSHA-256へ再定義されています。pre-SHA-256のv1 artifacts、Merkle root、署名、fixtureは無効です。BCS field order、enum値、payload shape、Ed25519署名方式は変更しません。

| 順序 | Field | Type | 要件 |
| --: | --- | --- | --- |
| 1 | `intent` | `u8` | Sonari Earthquake Oracle専用intent |
| 2 | `oracle_version` | `u64` | MVP値は `1` |
| 3 | `event_uid` | `[u8; 32]` | 決定的に生成されるevent id |
| 4 | `hazard_type` | `u8` | `EARTHQUAKE` |
| 5 | `status` | `u8` | onchainでは `FINALIZED` のみ |
| 6 | `event_revision` | `u32` | TEEがsource manifestから決定するSonari Finalized Revision |
| 7 | `occurred_at_ms` | `u64` | source上の地震発生時刻 |
| 8 | `observed_at_ms` | `u64` | Oracle観測時刻 |
| 9 | `source_updated_at_ms` | `u64` | 採用sourceの更新時刻 |
| 10 | `primary_source` | `u8` | MVP値は `USGS` |
| 11 | `severity_band` | `u8` | `1..3` |
| 12 | `source_set_hash` | `[u8; 32]` | canonical source manifestのhash |
| 13 | `raw_data_hash` | `[u8; 32]` | canonical raw data manifest JSON bytesのhash |
| 14 | `raw_data_uri` | `vector<u8>` | UTF-8 bytes。MVPでは空でもよい |
| 15 | `affected_cells_root` | `[u8; 32]` | `cell_band >= 1` のClaim対象セルだけを含むMerkle root |
| 16 | `affected_cells_uri` | `vector<u8>` | UTF-8 bytes。finalizedでは必須 |
| 17 | `affected_cells_data_hash` | `[u8; 32]` | affected cells file全体のhash |
| 18 | `geo_resolution` | `u8` | MVP値は `7` |
| 19 | `cells_generation_method` | `u8` | `SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1` |
| 20 | `cell_metric` | `u8` | `USGS_MMI` |
| 21 | `cell_aggregation` | `u8` | `GRID_POINT_P90` |
| 22 | `intensity_scale` | `u8` | `MMI_X100` |
| 23 | `max_cell_band` | `u8` | `severity_band` と一致すること |
| 24 | `affected_cell_count` | `u64` | `0` より大きいこと。異常値はTEE / watcherでwarning対象 |
| 25 | `min_claim_band` | `u8` | MVP値は `1` |
| 26 | `freshness_deadline_ms` | `u64` | 署名済みPayloadの投稿期限。MVP初期値は `observed_at_ms + 6 hours` |

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
- `freshness_deadline_ms` はDynamoDB上の72時間finalization deadlineとは別物です。
- Moveは、non-finalized status、未対応enum値、finalized時の空 `affected_cells_uri`、`affected_cell_count = 0`、`min_claim_band != 1` を拒否します。MVPでは `affected_cell_count` の異常値上限はMoveで検証しません。
- finalized Payloadでは `status = FINALIZED`、`affected_cells_uri` non-empty、`affected_cell_count > 0`、`min_claim_band = 1` を必須とします。
