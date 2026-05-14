# Disaster Oracle Response BCS Payload

このファイルは、Sonari Earthquake Oracle BCS Payloadのcanonical field orderを定義します。Rust、TypeScript、Moveは、必ず同じフィールドを同じ順序でserializeします。

## Scope

MVPでは `finalized` PayloadだけをSuiへ投稿します。`pending_source`、`pending_mmi`、`rejected` はD1内だけで管理するoffchain stateです。

## Field Order

| 順序 | Field | Type | 要件 |
| --: | --- | --- | --- |
| 1 | `intent` | `u8` | Sonari Earthquake Oracle専用intent |
| 2 | `oracle_version` | `u64` | MVP値は `1` |
| 3 | `event_uid` | `[u8; 32]` | 決定的に生成されるevent id |
| 4 | `hazard_type` | `u8` | `EARTHQUAKE` |
| 5 | `status` | `u8` | onchainでは `FINALIZED` のみ |
| 6 | `event_revision` | `u32` | Sonari Finalized Revision |
| 7 | `occurred_at_ms` | `u64` | source上の地震発生時刻 |
| 8 | `observed_at_ms` | `u64` | Oracle観測時刻 |
| 9 | `source_updated_at_ms` | `u64` | 採用sourceの更新時刻 |
| 10 | `primary_source` | `u8` | MVP値は `USGS` |
| 11 | `severity_band` | `u8` | `1..3` |
| 12 | `source_set_hash` | `[u8; 32]` | canonical source manifestのhash |
| 13 | `raw_data_hash` | `[u8; 32]` | raw source dataのhash |
| 14 | `raw_data_uri` | `vector<u8>` | UTF-8 bytes。MVPでは空でもよい |
| 15 | `affected_cells_root` | `[u8; 32]` | Claim proof用のMerkle root |
| 16 | `affected_cells_uri` | `vector<u8>` | UTF-8 bytes。finalizedでは必須 |
| 17 | `affected_cells_data_hash` | `[u8; 32]` | affected cells file全体のhash |
| 18 | `geo_resolution` | `u8` | MVP値は `7` |
| 19 | `cells_generation_method` | `u8` | `SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1` |
| 20 | `cell_metric` | `u8` | `USGS_MMI` または `JMA_SHINDO` |
| 21 | `cell_aggregation` | `u8` | `GRID_POINT_P90` |
| 22 | `intensity_scale` | `u8` | `MMI_X100` または `JMA_SHINDO_X10` |
| 23 | `max_cell_band` | `u8` | `severity_band` と一致すること |
| 24 | `affected_cell_count` | `u64` | `0` より大きいこと |
| 25 | `min_claim_band` | `u8` | MVP値は `1` |
| 26 | `freshness_deadline_ms` | `u64` | Payload有効期限 |

## Enum Values

| Enum | Value | 意味 |
| --- | --: | --- |
| `intent.SONARI_EARTHQUAKE_ORACLE` | `1` | Sonari Earthquake Oracle Payload |
| `hazard_type.EARTHQUAKE` | `1` | 地震のみ |
| `status.FINALIZED` | `3` | onchainで受理できるfinalized Payload |
| `primary_source.USGS` | `1` | USGS |
| `cells_generation_method.SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1` | `1` | MVPのShakeMap grid.xml方式 |
| `cells_generation_method.SHAKEMAP_HDF_H3_WEIGHTED_P90_V1` | `2` | Futureの高精度方式 |
| `cells_generation_method.JMA_250M_H3_P90_V1` | `3` | 日本デモ用方式 |
| `cell_metric.USGS_MMI` | `1` | USGS MMI |
| `cell_metric.JMA_SHINDO` | `2` | JMA震度 |
| `cell_aggregation.GRID_POINT_P90` | `1` | grid pointをH3へ割り当て、セルごとにP90を取る |
| `intensity_scale.MMI_X100` | `1` | MMIを100倍した値 |
| `intensity_scale.JMA_SHINDO_X10` | `2` | JMA震度を10倍した値 |

## Hash And Encoding Rules

- すべての整数は標準BCSのlittle-endian encodingを使います。
- URIを表す `vector<u8>` はUTF-8 bytesです。Move側では文字列正規化を行いません。
- `[u8; 32]` のフィールドは必ず32 bytesです。
- Payload署名は、上記field orderでserializeしたBCS bytesに対して行います。
- Moveは、non-finalized status、未対応enum値、finalized時の空 `affected_cells_uri`、`affected_cell_count = 0`、`min_claim_band != 1` を拒否します。
