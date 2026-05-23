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
python3 nautilus/verifiers/disaster/fixtures/verify_fixtures.py
```
