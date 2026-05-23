# TEE Core — Oracle 検証エンジン（Rust）

地震データを受け取り、影響を受けたH3セルを計算し、Merkleツリーを構築して署名する Rust 製の検証コアです。

---

## TEEとは何か

**Trusted Execution Environment（信頼実行環境）** とは、コンピュータの中に作られた「のぞき見できない金庫」のようなものです。

- 外部から計算の内容を見ることができない
- 計算結果が「本当にこのプログラムが出した」と証明できる（アテステーション）
- この証明があることで、ブロックチェーン上のスマートコントラクトが結果を信頼できる

---

## ディレクトリ構造

```
tee/
├── src/
│   ├── lib.rs                    ← ライブラリのエントリポイント・定数定義
│   ├── main.rs                   ← HTTPサーバー（Lambda環境）
│   ├── core/
│   │   ├── processing.rs         ← メイン処理パイプライン
│   │   ├── artifacts.rs          ← 出力データの構造体定義
│   │   ├── source_archive.rs     ← Walrusアーカイブへの保存
│   │   └── types.rs              ← OracleInput/Output/Error の型定義
│   ├── compute/
│   │   ├── geo.rs                ← グリッドポイント → H3セル変換
│   │   ├── intensity.rs          ← MMI計算・P90・バンド分類
│   │   └── merkle.rs             ← Merkleツリー構築・証明生成
│   ├── source/
│   │   └── usgs.rs               ← USGS JSON/XML パース
│   ├── encoding/
│   │   ├── bcs_payload.rs        ← BCSシリアライゼーション
│   │   └── json.rs               ← カノニカルJSONバイト生成
│   └── crypto/
│       └── mod.rs                ← SHA3-256・Ed25519署名
└── tests/
    └── oracle_core.rs            ← フィクスチャベースの統合テスト
```

---

## 処理パイプライン詳細

```
入力: UsgsOracleInput
  ├── detail_json     ← USGS地震詳細データ（JSON）
  ├── grid_xml        ← ShakeMapグリッドXML（MMI値の格子データ）
  ├── raw_grid_uri    ← グリッドXMLの保存URI
  └── その他URIなど

  ステップ 1: USGS JSONパース（source/usgs.rs）
     parse_detail(detail_json)
     → UsgsDetail { id, properties: { time, updated, products: { shakemap } } }

  ステップ 2: ShakeMap選択
     select_preferred_shakemap_product(products)
     → UsgsShakeMapProduct（なければ pending_source を返して終了）
     ※ map_status == "CANCELLED" なら rejected を返して終了

  ステップ 3: グリッドXML解析（source/usgs.rs）
     parse_grid_points(grid_xml)
     → Vec<GridPoint> { lat, lon, mmi_x100 }
     ※ グリッドが空なら pending_mmi を返して終了

  ステップ 4: H3セル変換・P90集計（compute/geo.rs, intensity.rs）
     affected_cells_from_points(points)
       - 各グリッドポイントを H3解像度7 のセルIDに変換
       - 同じセルに複数ポイントがあれば全MMI値を収集
       - p90_x100(values) で P90（90パーセンタイル）値を計算
       - cell_band(mmi_x100) でバンド（0-3）に分類
       - バンド >= MIN_CLAIM_BAND（1）のセルのみ残す
     → Vec<AffectedCellJson>（影響セル一覧）
     ※ 0件なら rejected を返して終了

  ステップ 5: ハッシュ計算
     source_manifest → SHA3-256 → source_set_hash
     raw_data_manifest → SHA3-256 → raw_data_hash
     affected_cells → SHA3-256 → affected_cells_data_hash

  ステップ 6: Merkleツリー構築（compute/merkle.rs）
     leaf_hashes(affected_cells, event_uid_bytes)
       - 各セルを BCS シリアライズ → SHA3-256 でリーフハッシュ生成
     merkle_root_from_leaf_hashes(leaf_hashes)
       - リーフを2つずつペアにして内部ノードハッシュを計算
       - 奇数個の場合は最後を1つそのまま上げる
       - 繰り返してルートハッシュを得る

  ステップ 7: BCSシリアライゼーション（encoding/bcs_payload.rs）
     payload_bcs_bytes(unsigned_payload)
     - PAYLOAD_V1_FIELD_ORDER の順でフィールドをシリアライズ

  ステップ 8: Ed25519署名（crypto/mod.rs）
     signer.sign_payload(bcs_bytes)
     → signature（64バイト）+ public_key（32バイト）

出力: OracleOutput
  ├── result          ← ResultSummary（status, error_code など）
  ├── source_manifest ← ソース記録
  ├── raw_data_manifest ← 生データ記録
  ├── affected_cells  ← 影響セル一覧（AffectedCellsArtifact）
  ├── expected_hashes ← 各種ハッシュの期待値（テスト検証用）
  ├── sample_proof    ← Merkle証明サンプル
  ├── unsigned_payload ← 署名前ペイロード
  ├── unsigned_bcs_payload ← BCSバイト列
  └── signature       ← Ed25519署名（finalizedの場合のみ）
```

---

## 各モジュールの解説

### `core/processing.rs` — メイン処理

4つの公開関数があります：

| 関数名 | 用途 |
|---|---|
| `process_usgs(input)` | テスト用。署名なし |
| `process_usgs_with_signer(input, signer)` | 本番用。署名あり |
| `process_usgs_from_worker_request(request, input)` | Workerリクエストを検証してから実行 |
| `process_usgs_with_source_archive(input, archive, signer)` | Walrusアーカイブ付き本番用 |

### `compute/geo.rs` — H3地理空間変換

**なぜH3を使うか？**

地球の表面を均一な六角形タイルで分割することで：
- どのセルも面積がほぼ等しい（地域による不公平がない）
- セルIDが1つの64bit整数で表せる（ブロックチェーンに乗せやすい）
- 解像度7では1セルあたり約1.2km²（適度な粒度）

```
affected_cells_from_points(points) の処理:

  GridPoint { lat, lon, mmi_x100 }
       ↓ LatLng::new(lat, lon).to_cell(Resolution::Seven)
  H3セルID（u64）
       ↓ BTreeMapで同セルのMMI値をグループ化
  [mmi_x100, mmi_x100, ...]
       ↓ p90_x100(&values)
  P90 MMI値
       ↓ cell_band(mmi_x100)
  バンド（0-3）
       ↓ band >= MIN_CLAIM_BAND でフィルタ
  AffectedCellJson { h3_index, intensity_value, cell_band }
```

### `compute/intensity.rs` — MMI計算

**MMI（修正メルカリ震度）とは？**

数値が大きいほど揺れが強い。USGSのShakeMapでは小数点付きで提供されます（例: 3.72）。

このモジュールでは：

1. `mmi_decimal_to_x100("3.72")` → `372`（小数点を×100して整数化）
2. `p90_x100(values)` → ソートして上位10%の境界値を取得
3. `cell_band(mmi_x100)` → 以下のバンドに分類：

```
MMI値（×100） │ バンド │ 意味
0 〜 699      │   0   │ 申請対象外（MMI 6.99以下）
700 〜 799    │   1   │ 弱い被害（MMI 7.00〜7.99）
800 〜 899    │   2   │ 中程度の被害（MMI 8.00〜8.99）
900以上       │   3   │ 強い被害（MMI 9.00以上）
```

### `compute/merkle.rs` — Merkleツリー

**Merkleツリーとは？**

木の形に似たデータ構造で、大量のデータを1つのハッシュ（ルートハッシュ）で表現できます。

```
葉（リーフ）ノード：各H3セルのハッシュ
  [セルA] [セルB] [セルC] [セルD]
      ↓ペア結合         ↓ペア結合
  [AB ハッシュ]      [CD ハッシュ]
         ↓ペア結合
      [ルートハッシュ]
```

内部ノードのハッシュ計算：
```
SHA3-256( 0x01 || 左ノード(32bytes) || 右ノード(32bytes) )
```

`sample_proof()` は任意の1セルについてルートまでの証明経路（兄弟ハッシュの列）を生成します。スマートコントラクトは証明経路を使って、特定のセルが本当にこのOracleに含まれているかを効率的に検証できます。

### `source/usgs.rs` — USGSデータパース

- `parse_detail(json_bytes)` → USGS GeoJSON詳細データを解析
- `parse_grid_points(xml_bytes)` → ShakeMap の grid.xml から格子点（lat, lon, MMI）を抽出
- `select_preferred_shakemap_product(products)` → 複数のShakeMapから最適なものを選択

### `encoding/bcs_payload.rs` — BCSシリアライゼーション

BCS（Binary Canonical Serialization）はSUIブロックチェーンのデータ形式です。同じデータを常に同じバイト列に変換できる（決定論的）特性があり、署名の検証に使えます。

- `payload_bcs_bytes(payload)` → `PAYLOAD_V1_FIELD_ORDER` の順でペイロードをシリアライズ
- `leaf_hashes(cells, event_uid_bytes)` → 各セルのBCSバイト列を計算してSHA3-256ハッシュ化
- `event_uid_bytes(hazard_type, source, event_id, occurred_at_ms)` → イベントUIDのバイト列

### `crypto/mod.rs` — 暗号処理

- `sha3_256_bytes(data)` → SHA3-256ハッシュ（32バイト）を計算
- `to_hex(bytes)` → バイト列を `0x` プレフィックス付き16進文字列に変換
- `PayloadSigner::sign_payload(bcs_bytes)` → Ed25519で署名

---

## OracleOutput の全フィールド

finalized（正常完了）時に生成される主要ファイル：

| ファイル名 | 内容 |
|---|---|
| `result.json` | 処理結果サマリー（status, source_event_id など） |
| `unsigned_payload_v1.json` | 26フィールドのOracleペイロード |
| `affected_cells.json` | 影響H3セルの一覧 |
| `source_manifest.json` | データソース記録 |
| `raw_data_manifest.json` | 生データのハッシュ記録 |
| `expected_hashes.json` | 全ハッシュの期待値（テスト検証用） |
| `sample_proof.json` | Merkle証明サンプル |
| `signature.json` | Ed25519署名と公開鍵 |

---

## エラーと状態の分類

| 状態 | 意味 | 再試行 |
|---|---|---|
| `pending_source` | ShakeMapが準備されていない | あり（ShakeMap公開後） |
| `pending_mmi` | グリッドXMLが空/未取得 | あり（データ更新後） |
| `rejected` | 処理上の問題（キャンセル、被害なし、締切超過） | なし |

---

## テストの実行方法

```bash
# ユニットテスト
cargo test -p nautilus-disaster-oracle-tee

# フィクスチャ統合テスト（詳細出力付き）
cargo test -p nautilus-disaster-oracle-tee -- --nocapture

# 特定のテストのみ実行
cargo test -p nautilus-disaster-oracle-tee finalized_minimal

# Pythonフィクスチャ検証（ハッシュ・BCS・Merkleの独立検証）
python3 nautilus/verifiers/disaster/fixtures/verify_fixtures.py
```

---

## グローバル定数（lib.rs より）

| 定数名 | 値 | 意味 |
|---|---|---|
| `ORACLE_VERSION` | 1 | Oracle仕様バージョン |
| `GEO_RESOLUTION` | 7 | H3セル解像度（約1.2km²/セル） |
| `MIN_CLAIM_BAND` | 1 | 申請対象の最低バンド |
| `FRESHNESS_WINDOW_MS` | （設定値） | Oracleの有効期間 |
| `INTENT_SONARI_EARTHQUAKE_ORACLE` | 1 | このOracleの用途識別子 |
| `HAZARD_TYPE_EARTHQUAKE` | 1 | 地震を示す数値 |
| `PRIMARY_SOURCE_USGS` | 1 | USGSを示す数値 |
| `ONCHAIN_STATUS_FINALIZED` | 3 | オンチェーンの完了ステータス |
