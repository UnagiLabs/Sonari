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

### `PAYLOAD_FIELD_ORDER` — Oracleペイロードの28フィールド

Oracleが生成するデータには決まった順番があります。BCS（バイト列変換）では順番が重要なため、この配列で厳密に管理します。

| # | フィールド名 | 意味 |
|---|---|---|
| 1 | `intent` | このデータの用途（地震Oracleであることを示す） |
| 2 | `oracle_version` | Oracle仕様のバージョン番号 |
| 3 | `event_uid` | 地震イベントの一意ID（hazard_type + source + id + 時刻から生成） |
| 4 | `hazard_type` | 災害の種類（地震 = 1） |
| 5 | `status` | 処理状態（完了 = 3） |
| 6 | `event_revision` | イベントの改訂番号 |
| 7 | `source_event_id` | USGSイベントID |
| 8 | `title` | USGSイベントタイトル |
| 9 | `region` | USGS地域名 |
| 10 | `occurred_at_ms` | 地震発生時刻（ミリ秒） |
| 11 | `magnitude_x100` | マグニチュードを100倍した整数 |
| 12 | `verified_at_ms` | TEE検証時刻（ミリ秒） |
| 13 | `source_updated_at_ms` | USGSデータの更新時刻（ミリ秒） |
| 14 | `primary_source` | データ提供元（USGS = 1） |
| 15 | `severity_band` | イベントの被害バンド（1-3） |
| 16 | `source_set_hash` | ソースマニフェストのSHA-256ハッシュ |
| 17 | `raw_data_hash` | 生データマニフェストのSHA-256ハッシュ |
| 18 | `raw_data_uri` | 生データの保存場所（Walrus URI） |
| 19 | `affected_cells_root` | 影響セル一覧のMerkleルートハッシュ |
| 20 | `affected_cells_uri` | 影響セルデータの保存場所 |
| 21 | `affected_cells_data_hash` | 影響セルデータのSHA-256ハッシュ |
| 22 | `affected_cell_count` | 影響を受けたH3セルの総数 |
| 23 | `geo_resolution` | H3セルの解像度（現在は7固定） |
| 24 | `cells_generation_method` | セル生成方法（ShakeMap grid.xml + H3 + P90 = 1） |
| 25 | `cell_metric` | セルの指標（USGS MMI = 1） |
| 26 | `cell_aggregation` | 集計方法（グリッドポイントP90 = 1） |
| 27 | `intensity_scale` | 強度スケール（MMI×100 = 1） |
| 28 | `freshness_deadline_ms` | このOracleの有効期限（検証時刻 + 一定時間） |

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
  SHAKEMAP_HDF_H3_WEIGHTED_P90_V1 → 2

cellMetric:
  USGS_MMI → 1

cellAggregation:
  GRID_POINT_P90 → 1

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
