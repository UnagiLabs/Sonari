# Earthquake Oracle Response BCS Payload

このファイルは、repository rootの `schemas/` に置くroot共通仕様です。Sonari Earthquake Oracle BCS Payloadのcanonical field orderを定義し、Rust、TypeScript、Moveは必ず同じフィールドを同じ順序でserializeします。

## Scope

MVPでは `finalized` PayloadだけをSuiへ投稿します。`pending_source`、`pending_mmi`、`rejected` はDynamoDB内だけで管理するoffchain stateです。

## Field Order

MVPでは以下の17 field orderをcurrent contractとして固定します。MVP中は後方互換性を持たせず、Rust、TypeScript、Python、Moveはこの1つのpayload shapeだけを扱います。field追加、順序変更、型変更、enum値変更が必要な場合は、このcurrent contract、schema、fixture / golden vector、Rust / TypeScript / Python / Moveの検証を同時に更新します。

| 順序 | Field | Type | 要件 |
| --: | --- | --- | --- |
| 1 | `intent` | `u8` | `1` Sonari Earthquake Oracle専用intent |
| 2 | `oracle_version` | `u64` | MVP single valueは `1` |
| 3 | `event_uid` | `[u8; 32]` | 決定的に生成されるevent id |
| 4 | `event_revision` | `u32` | `>= 1`。TEEがsource manifestから決定するSonari Finalized Revision |
| 5 | `source_event_id` | `vector<u8>` | UTF-8 bytes。USGS detail `id`。`1..96` bytes |
| 6 | `title` | `vector<u8>` | UTF-8 bytes。USGS `properties.title`。`1..160` bytes |
| 7 | `region` | `vector<u8>` | UTF-8 bytes。USGS `properties.place`。`1..160` bytes |
| 8 | `occurred_at_ms` | `u64` | source上の地震発生時刻 |
| 9 | `hazard_type` | `u8` | `1` EARTHQUAKE |
| 10 | `status` | `u8` | `3` FINALIZED |
| 11 | `severity_band` | `u8` | `1..3`。affected cellsの最大 `cell_band` |
| 12 | `affected_cells_root` | `[u8; 32]` | `cell_band >= 1` のClaim対象セルだけを含むMerkle root |
| 13 | `affected_cell_count` | `u64` | `1..1_000_000` |
| 14 | `evidence_manifest_uri` | `vector<u8>` | UTF-8 bytes。canonical evidence manifestの配送先URI。`1..512` bytes |
| 15 | `evidence_manifest_hash` | `[u8; 32]` | canonical evidence manifest bytesのSHA-256。lowercase `0x` prefixed 32-byte hexで表す |
| 16 | `verified_at_ms` | `u64` | TEE検証時刻。MVP pathでは現在の決定的timestamp sourceである `observed_at_ms` を使う |
| 17 | `freshness_deadline_ms` | `u64` | `verified_at_ms + FRESHNESS_WINDOW_MS`。必ず `verified_at_ms` より後 |

## Enum Values

| Enum | Value | 意味 |
| --- | --: | --- |
| `intent.SONARI_EARTHQUAKE_ORACLE` | `1` | Sonari Earthquake Oracle Payload |
| `hazard_type.EARTHQUAKE` | `1` | 地震のみ |
| `status.FINALIZED` | `3` | onchainで受理できるfinalized Payload |

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
  u32_le(len(source_name)) || utf8(source_name) ||
  u32_le(len(source_event_id)) || utf8(source_event_id) ||
  u64_le(occurred_at_ms)
)
```

- `event_uid` 生成時の `source_name` はsource name文字列です。MVPでは `USGS` を使います。
- `evidence_manifest_hash = SHA-256(canonical_evidence_manifest_bytes)` です。canonical evidence manifestは、source manifest、raw data manifest、affected cells data、affected cells root/countへのURIとhashをまとめます。
- `affected_cells_root` とMerkle leaf / internal node hashはすべて `SHA-256` です。詳細は `schemas/affected_cell_leaf.md` に従います。
- 現行の grid.xml path では、ShakeMap の実データ lon / lat 軸からH3セル中心のMMIを補間し、`cells_generation_method = SHAKEMAP_GRIDXML_H3_CENTER_BILINEAR_V1` のleafでMerkle rootを作ります。grid間隔の完全な等間隔性や `nlon * nlat` との完全一致はroot生成の前提にしません。
- `freshness_deadline_ms` はDynamoDB上の72時間finalization deadlineとは別物です。
- finalized Payloadでは `status = FINALIZED`、`evidence_manifest_uri` non-empty、`affected_cell_count = 1..1_000_000`、`freshness_deadline_ms = verified_at_ms + FRESHNESS_WINDOW_MS` を必須とします。
