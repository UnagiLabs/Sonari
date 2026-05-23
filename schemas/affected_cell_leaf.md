# Affected Cell Leaf

このファイルは、repository rootの `schemas/` に置くroot共通仕様です。`AffectedCellLeaf` は、1つのH3セルがfinalized済みのSonari地震イベントのClaim対象地域に含まれ、必要なcell band条件を満たすことを証明するleafです。

## Canonical Field Order

Rust、TypeScript、Moveは、必ず以下の順序で `AffectedCellLeaf` をBCS serializeしてhashします。

| 順序 | Field | Type | 要件 |
| --: | --- | --- | --- |
| 1 | `event_uid` | `[u8; 32]` | Payloadと同じevent id |
| 2 | `event_revision` | `u32` | Payloadと同じSonari Finalized Revision |
| 3 | `h3_index` | `u64` | H3 index。JSON artifactではdecimal string |
| 4 | `geo_resolution` | `u8` | MVP値は `7` |
| 5 | `cell_metric` | `u8` | `USGS_MMI` |
| 6 | `intensity_value` | `u16` | scale適用後の震度値 |
| 7 | `intensity_scale` | `u8` | `MMI_X100` |
| 8 | `cell_band` | `u8` | Claim対象セルのみなので `1..3` |
| 9 | `cells_generation_method` | `u8` | Payloadと同じ生成方式 |
| 10 | `oracle_version` | `u64` | Payloadと同じoracle version |

## Leaf Hash

```txt
leaf_hash = SHA3-256(0x00 || BCS(AffectedCellLeaf))
```

## Sort And Merkle Rules

- Merkle treeを作る前に、leafを numeric `h3_index` の昇順でsortします。
- 同一 `h3_index` が複数存在するaffected cells fileはinvalidです。
- leaf hashには上記の全フィールドを含めます。
- `affected_cells_root` は `cell_band >= 1` のClaim対象セルだけで作ります。Band 0セルと全ShakeMap領域の完全証明は含めません。
- internal nodeのhashは `internal_hash = SHA3-256(0x01 || left_32 || right_32)` です。
- 各Merkle levelでleaf数が奇数の場合、末尾leafは複製せず次段へそのまま昇格します。
- Merkle proof stepの `direction` は、`LEFT` が sibling is left of current hash、`RIGHT` が sibling is right of current hashを意味します。
- fixture testでは、同じaffected cells fileから各実装で同じ `affected_cells_root` が得られることを確認します。

## Encoding Rules

- すべての整数は標準BCSのlittle-endian encodingを使います。
- `event_uid` は必ず32 bytesです。
- Leaf BCS内の `h3_index` は `u64` です。
- JSON artifact内の `h3_index` はdecimal stringです。`u64` へ変換する際はleading zeroを禁止します。ただし `"0"` のみ許可します。
- `intensity_value` は `intensity_scale` とセットで解釈します。MMI 7.23は `MMI_X100` で `723` です。
- `cells_generation_method` のMVP値は `SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1` です。
