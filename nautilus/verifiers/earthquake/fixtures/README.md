# Nautilus Disaster Oracle フィクスチャ

これらのフィクスチャは、Rust製 Oracle Core 向けに Oracle ワークフローの入力と期待結果を固定します。

`schemas/examples/` は、ルートスキーマ、BCS、ハッシュ、Merkle leaf、manifest に関する言語横断のゴールデン契約として維持します。このディレクトリは、今後の Core、Watcher、Relayer のテストで使う Oracle シナリオフィクスチャ層です。

テストは USGS やその他のネットワークソースへアクセスしてはいけません。すべての検証は、このディレクトリに保存されたファイルだけを読み取ります。

Step 3 のフィクスチャは、決定的なテストのために、プレーンな `input/usgs_grid.xml` と `input/usgs_detail.json` を生ソースバイトとして使います。これは、将来の本番用 `grid.xml.zip` バイトハッシュ契約とは別のものです。

<!-- verifier: Step 3 fixture uses plain `input/usgs_grid.xml` and `input/usgs_detail.json` as raw source bytes -->

ハッシュアルゴリズム:
- `raw_data_hash`: `SHA3-256(canonical raw_data_manifest.json bytes)`
- `raw_data_manifest.entries[].content_hash`: `SHA3-256(raw source bytes)`
- `raw_data_manifest.entries[].source_hash`: `SHA3-256(raw source bytes)`。Production finalized では `uri` は `walrus://blob/<blob_id>`、`walrus_blob_id` は Walrus の content-addressed blob id を入れる。
- `source_set_hash`: `SHA3-256(canonical source_manifest.json bytes)`
- `affected_cells_data_hash`: `SHA3-256(canonical affected_cells.json bytes)`
- Merkle leaf と内部ノードのハッシュ: `SHA3-256`

実行方法:

```bash
python3 nautilus/verifiers/earthquake/fixtures/verify_fixtures.py
```

---

## なぜフィクスチャが必要か

Oracle の計算結果（ハッシュ・BCS・Merkleルート・署名）は決定論的（同じ入力なら必ず同じ出力）でなければなりません。フィクスチャにより：

1. **再現性の保証** — コードを変更したときに結果が変わっていないか確認できる
2. **言語横断検証** — Rust（TEE Core）・Python（verify_fixtures.py）の両方で同じ結果が出ることを確認
3. **ネットワーク不要** — テスト時に USGS に接続しない（安定したCI/CDが実現できる）
4. **エッジケースの固定** — 正常系だけでなく、ShakeMapなし・グリッド空・キャンセルなどの異常系も固定

---

## テストケース一覧

| ケース | 状況 | 期待ステータス | エラーコード |
|---|---|---|---|
| `usgs/finalized_minimal` | 正常な地震データ + ShakeMap + グリッドあり | `finalized` | — |
| `usgs/pending_source_no_shakemap` | ShakeMapプロダクトが存在しない | `pending_source` | `SHAKEMAP_PRODUCT_MISSING` |
| `usgs/pending_mmi_empty_grid` | グリッドXMLは存在するが格子点が0件 | `pending_mmi` | `MMI_NOT_AVAILABLE` |
| `usgs/rejected_cancelled_shakemap` | ShakeMapのmap_statusが"CANCELLED" | `rejected` | `SHAKEMAP_CANCELLED` |
| `usgs/rejected_no_affected_cells` | グリッドはあるが申請対象セルが0件 | `rejected` | `NO_AFFECTED_CELLS` |

---

## フィクスチャのディレクトリ構造

各テストケースは以下の構造を持ちます：

```
usgs/<case_name>/
├── README.md                 ← このケースの簡単な説明
├── input/
│   ├── usgs_detail.json      ← USGS地震詳細データ（GeoJSON形式）
│   └── usgs_grid.xml         ← ShakeMapグリッドXML（MMI格子データ）
│                               ※ pending/rejected 系は存在しない場合あり
└── expected/
    ├── result.json           ← 期待される処理結果（全ケース必須）
    │
    ← finalized のみ以下が存在 →
    ├── unsigned_payload_v1.json   ← 26フィールドのOracleペイロード
    ├── affected_cells.json        ← 影響H3セル一覧
    ├── source_manifest.json       ← ソース記録（URL・バージョン等）
    ├── raw_data_manifest.json     ← 生データのハッシュ記録
    ├── expected_hashes.json       ← 全ハッシュの期待値
    ├── sample_proof.json          ← Merkle証明サンプル
    └── signature.json             ← Ed25519署名と公開鍵
```

---

## verify_fixtures.py の使い方

Python スクリプトが各フィクスチャの期待値を独立に再計算して検証します。

```bash
# プロジェクトルートから実行
python3 nautilus/verifiers/earthquake/fixtures/verify_fixtures.py
```

このスクリプトは以下を確認します：

- `result.json` のステータスとエラーコードが正しいか
- `finalized` ケースで FINALIZED_ONLY_FILES が存在するか
- ハッシュ値（SHA3-256）が期待値と一致するか
- Merkleツリーが正しく構築されているか
- BCS シリアライゼーションが期待値と一致するか

---

## フィクスチャを追加する方法

新しいテストケースを追加するには：

1. `usgs/<new_case>/input/` に USGS データを配置
2. Rust テストで `process_usgs()` を実行して出力を確認
3. 出力を `usgs/<new_case>/expected/` に保存
4. `verify_fixtures.py` の `CASES` 辞書に新ケースを追加
5. `python3 verify_fixtures.py` でPython側の独立検証がパスすることを確認
6. `cargo test` でRust側のテストがパスすることを確認
