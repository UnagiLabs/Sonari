# Affected Cell Leaf

`AffectedCellLeaf` は、1つのH3セルがfinalized済みのSonari地震イベントの対象地域に含まれ、必要なcell band条件を満たすことを証明するleafです。

## Canonical Field Order

Rust、TypeScript、Moveは、必ず以下の順序でフィールドをhashします。

| 順序 | Field | Type | 要件 |
| --: | --- | --- | --- |
| 1 | `event_uid` | `[u8; 32]` | Payloadと同じevent id |
| 2 | `event_revision` | `u32` | Payloadと同じSonari Finalized Revision |
| 3 | `h3_index` | `u64` | H3 index |
| 4 | `geo_resolution` | `u8` | MVP値は `7` |
| 5 | `cell_metric` | `u8` | `USGS_MMI` または `JMA_SHINDO` |
| 6 | `intensity_value` | `u16` | scale適用後の震度値 |
| 7 | `intensity_scale` | `u8` | `MMI_X100` または `JMA_SHINDO_X10` |
| 8 | `cell_band` | `u8` | affected cellsでは `1..3` |
| 9 | `cells_generation_method` | `u8` | Payloadと同じ生成方式 |
| 10 | `oracle_version` | `u64` | Payloadと同じoracle version |

## Leaf Hash

```txt
leaf_hash = hash_bcs(
  event_uid,
  event_revision,
  h3_index,
  geo_resolution,
  cell_metric,
  intensity_value,
  intensity_scale,
  cell_band,
  cells_generation_method,
  oracle_version
)
```

## Sort And Merkle Rules

- Merkle treeを作る前に、leafを `h3_index` の昇順でsortします。
- leaf hashには上記の全フィールドを含めます。
- internal nodeのhashは、Rust、TypeScript、Moveでbyte orderが一致する必要があります。
- fixture testでは、同じaffected cells fileから各実装で同じ `affected_cells_root` が得られることを確認します。

## Encoding Rules

- すべての整数は標準BCSのlittle-endian encodingを使います。
- `event_uid` は必ず32 bytesです。
- `intensity_value` は `intensity_scale` とセットで解釈します。MMI 7.23は `MMI_X100` で `723` です。
- `cells_generation_method` のMVP値は `SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1` です。
