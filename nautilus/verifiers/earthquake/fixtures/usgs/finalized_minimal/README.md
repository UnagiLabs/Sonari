# USGS finalized_minimal

出典:
- 派生元の USGS イベント: us7000sonari
- 取得日: 2026-05-15
- フィクスチャ用の変更: yes
- テストに必要なネットワークアクセス: no

<!--
verifier:
情報:
- 派生元の USGS イベント:
- 取得日:
- フィクスチャ用の変更:
- テストに必要なネットワークアクセス: いいえ
-->

このフィクスチャは、ルート `schemas/examples/` の 2点版 ShakeMap ゴールデンから派生しています。USGS 詳細 JSON は、Oracle ワークフローテストに必要なフィールドまで最小化されています。

Step 3 のフィクスチャは、決定的なテストのために、プレーンな `input/usgs_grid.xml` と `input/usgs_detail.json` を生ソースバイトとして使います。これは、将来の本番用 `grid.xml.zip` バイトハッシュ契約とは別のものです。

<!-- verifier: Step 3 fixture uses plain `input/usgs_grid.xml` and `input/usgs_detail.json` as raw source bytes -->

## 手動確認表

| グリッド点 | 緯度 | 経度 | MMI | H3 インデックス | P90 入力値 | P90 結果 | cell_band |
| ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
| 1 | 35.6000 | 139.7000 | 7.23 | 608819013597790207 | [723] | 723 | 1 |
| 2 | 35.6100 | 139.7100 | 8.31 | 608819013513904127 | [831] | 831 | 2 |

P90 の定義:
1. セル内の強度値を昇順に並べ替える。
2. `rank = ceil(0.90 * n) - 1`.
3. `values[rank]` が P90 結果になる。

<!-- verifier: P90 definition: -->

今後のフィクスチャ:
- `finalized_multi_point_same_cell`
- `GRID_POINT_P90` 実装を検証するため、1 つの H3 セルに複数のグリッド点を追加する。
