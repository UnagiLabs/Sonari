# shared — 共通ルール定義

TypeScript（Watcher・Relayer）と Rust（TEE Core）の両方で使う「共通の約束ごと」を定義する場所です。

---

## なぜ shared が必要か

このシステムでは3つのコンポーネントが協調して動きます：

- **TEE Core**（Rust）が計算した結果を
- **Watcher**（TypeScript）が受け取り
- **Relayer**（TypeScript）がブロックチェーンに送る

それぞれが「同じルール」で動かないと、結果がかみ合わなくなります。`shared` はそのルールの中心です。

---

## ソースファイル

```
shared/
└── src/
    └── index.ts    ← すべてのエクスポートはここから
```

---

## エクスポート一覧

### `PAYLOAD_FIELD_ORDER` — Oracleペイロードの17フィールド

Oracleが生成する署名対象データには決まった順番があります。BCS（バイト列変換）では順番が重要なため、この配列で厳密に管理します。生データ、生成済み affected cells、source metadata は署名対象 payload に直接入れず、`evidence_manifest_uri` と `evidence_manifest_hash` が指す evidence manifest に集約します。

| # | フィールド名 | 意味 |
|---|---|---|
| 1 | `intent` | このデータの用途（地震Oracleであることを示す） |
| 2 | `oracle_version` | Oracle仕様のバージョン番号 |
| 3 | `event_uid` | 地震イベントの一意ID（hazard_type + source + id + 時刻から生成） |
| 4 | `event_revision` | イベントの改訂番号 |
| 5 | `source_event_id` | USGSイベントID |
| 6 | `title` | USGSイベントタイトル |
| 7 | `region` | USGS地域名 |
| 8 | `occurred_at_ms` | 地震発生時刻（ミリ秒） |
| 9 | `hazard_type` | 災害の種類（地震 = 1） |
| 10 | `status` | 処理状態（完了 = 3） |
| 11 | `severity_band` | イベントの被害バンド（1-3） |
| 12 | `affected_cells_root` | affected cells artifact のMerkleルートハッシュ |
| 13 | `affected_cell_count` | 影響を受けたH3セルの総数 |
| 14 | `evidence_manifest_uri` | evidence manifest の保存場所（Walrus blob URI） |
| 15 | `evidence_manifest_hash` | evidence manifest canonical JSON のSHA-256ハッシュ |
| 16 | `verified_at_ms` | TEE検証時刻（ミリ秒） |
| 17 | `freshness_deadline_ms` | このOracleの有効期限（検証時刻 + 一定時間） |

### `EvidenceManifest` — payload外の検証証跡

Evidence manifest は signed payload から外した証跡をまとめるオフチェーン artifact です。TEE が source raw artifacts、affected cells artifact、manifest 自体を archive し、payload は manifest の URI と hash だけを保持します。

含まれる主な情報:

- `sources[]`: USGS detail / ShakeMap grid の source URI、artifact URI、content hash、size、source updated time
- `earthquake`: title、region、発生時刻、`magnitude_x100`、USGS updated time
- `affected_cells`: affected cells artifact URI、hash、Merkle root、件数、H3解像度

### `AFFECTED_CELL_LEAF_FIELD_ORDER` — Merkleリーフの10フィールド

各H3セルのMerkleリーフ（木の葉）を構成するフィールドの順番です。

### `BCS_ENUMS` — 数値マッピング

コード上は名前（文字列）で管理し、ブロックチェーン送信時に数値に変換します：

```
intent:
  SONARI_EARTHQUAKE_ORACLE → 1

hazardType:
  EARTHQUAKE → 1

onchainStatus:
  FINALIZED → 3

primarySource:
  USGS → 1

cellsGenerationMethod:
  SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1 → 1
  SHAKEMAP_HDF_H3_AREA_WEIGHTED_P90_V1 → 2
  SHAKEMAP_GRIDXML_H3_CENTER_BILINEAR_V1 → 3

cellMetric:
  USGS_MMI → 1

cellAggregation:
  GRID_POINT_P90 → 1
  H3_CENTER_BILINEAR → 2

intensityScale:
  MMI_X100 → 1
```

### `DEFAULT_ORACLE_CONTRACT` — 固定パラメータ

```
oracle_version: 1
geo_resolution: 7    ← H3解像度（約1.2km²/セル）
```

Claimに必要な最小バンドはOracle payloadや`DisasterEvent`ではなく、Moveの`PayoutPolicy.min_claim_band`で管理します。

### `OFFCHAIN_STATUSES` — オフチェーン処理状態

```
new              → 新規検知
queued           → TEE処理待ちキューに追加
processing       → TEEが処理中
pending_source   → ShakeMapデータ待ち（後で再試行）
pending_mmi      → グリッドデータ待ち（後で再試行）
ignored_small    → 規模が小さく無視
finalized        → TEE検証完了
submitted        → ブロックチェーン送信済み
failed           → システムエラー（再試行可能）
rejected         → 拒否確定（再試行不可）
```

### `ERROR_CODES` — エラーコード一覧

| エラーコード | 意味 |
|---|---|
| `USGS_RECENT_UNAVAILABLE` | USGS最新フィードが取得できない |
| `USGS_DETAIL_UNAVAILABLE` | USGS詳細データが取得できない |
| `SHAKEMAP_PRODUCT_MISSING` | ShakeMapプロダクトがない |
| `SHAKEMAP_CANCELLED` | ShakeMapがキャンセルされた |
| `SHAKEMAP_GRID_UNAVAILABLE` | ShakeMapグリッドXMLが取得できない |
| `SHAKEMAP_PARSE_FAILED` | ShakeMapのパース失敗 |
| `MMI_NOT_AVAILABLE` | MMIデータがない |
| `NO_AFFECTED_CELLS` | 対象H3セルが0件（被害エリアなし） |
| `SOURCE_STALE` | ソースデータが古すぎる |
| `SOURCE_REVISION_OLD` | ソースの改訂が古い |
| `UNSUPPORTED_HAZARD_TYPE` | 未対応の災害種別 |
| `TEE_SIGNATURE_FAILED` | TEE署名失敗 |
| `BCS_SERIALIZATION_FAILED` | BCSシリアライゼーション失敗 |
| `MERKLE_ROOT_FAILED` | Merkleルート計算失敗 |
| `AWS_RUNNER_START_FAILED` | AWS runner起動失敗 |
| `AWS_RUNNER_PROCESS_FAILED` | AWS runner処理失敗 |
| `AWS_RUNNER_TIMEOUT` | AWS runnerタイムアウト |
| `AWS_RUNNER_CONTRACT_INVALID` | AWS runnerの契約違反 |
| `RELAYER_SUBMIT_FAILED` | Relayer送信失敗 |
| `MOVE_REJECTED` | MoveコントラクトがRejectを返した |
| `REJECTED_AUTO_TRIGGER` | 締切超過により自動拒否 |
| `WATCHER_BELOW_AUTO_THRESHOLD` | 自動処理の閾値未満 |

---

## バリデーション関数

### `validateEarthquakeVerifierRequest(input)`

Watcher → TEE へのリクエストが正しい形式か検証します。

```typescript
// 正常
validateEarthquakeVerifierRequest({
  source_event_id: "us7000abc1",
  hazard_type: 1,          // EARTHQUAKE
  primary_source: 1,       // USGS
  geo_resolution: 7,
})
// → { ok: true, value: {...} }

// 異常（余分なフィールドがある）
validateEarthquakeVerifierRequest({ source_event_id: "us7000abc1", unknown_field: true, ... })
// → { ok: false, error_code: "INVALID_WORKER_TEE_REQUEST", message: "..." }
```

### `validateRelayerSubmitInput(input)`

TEE → Relayer への入力が finalized 状態かつ必要フィールドを持つか検証します。

```typescript
validateRelayerSubmitInput({
  status: "finalized",
  payload: { status: 3, ... },
  payload_bcs_hex: "0xabc...",
  signature: "0xdef...",
  public_key: "0x123...",
})
// → { ok: true, value: {...} }
```

---

## 型定義

```
EarthquakeOraclePayload    ← Oracleペイロードの完全型
EarthquakeVerifierRequest         ← Watcher→TEE リクエスト型
SignedFinalizedPayload     ← 署名済み完了ペイロード型
TeeCoreResult              ← TEEの4種類の結果型
  ├── { status: "pending_source", error_code: ... }
  ├── { status: "pending_mmi", error_code: ... }
  ├── { status: "rejected", error_code: ... }
  └── SignedFinalizedPayload
RelayerSubmitInput         ← Relayer入力型（= SignedFinalizedPayload）
```
