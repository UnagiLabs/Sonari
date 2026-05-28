# USGS great_tohoku_2011

出典:
- 派生元の USGS イベント: official20110311054624120_30
- 取得日: 2026-05-28
- フィクスチャ用の変更: no
- テストに必要なネットワークアクセス: no

<!--
verifier:
Source:
- Derived from USGS event:
- Captured at:
- Modified for fixture:
- Network access required for tests: no

情報:
- 派生元の USGS イベント:
- 取得日:
- フィクスチャ用の変更:
- テストに必要なネットワークアクセス: いいえ
-->

このフィクスチャは、東日本大震災の USGS detail GeoJSON と ShakeMap `grid.xml` を原文のまま保存した実データケースです。

Source URLs:
- Detail GeoJSON: https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/official20110311054624120_30.geojson
- ShakeMap grid.xml: https://earthquake.usgs.gov/product/shakemap/official20110311054624120_30/atlas/1594161746661/download/grid.xml
- Event page: https://earthquake.usgs.gov/earthquakes/eventpage/official20110311054624120_30

Step 3 のフィクスチャは、決定的なテストのために、プレーンな `input/usgs_grid.xml` と `input/usgs_detail.json` を生ソースバイトとして使います。これは、将来の本番用 `grid.xml.zip` バイトハッシュ契約とは別のものです。

<!-- verifier: Step 3 fixture uses plain `input/usgs_grid.xml` and `input/usgs_detail.json` as raw source bytes -->

## 生成結果

| 項目 | 値 |
| --- | ---: |
| status | finalized |
| severity_band | 3 |
| max_cell_band | 3 |
| affected_cell_count | 18429 |
| band 1 cells | 4984 |
| band 2 cells | 7203 |
| band 3 cells | 6242 |

P90 の定義:
1. セル内の強度値を昇順に並べ替える。
2. `rank = ceil(0.90 * n) - 1`.
3. `values[rank]` が P90 結果になる。

<!-- verifier: P90 definition: -->

今後のフィクスチャ:
- `finalized_multi_point_same_cell`
- `GRID_POINT_P90` 実装を検証するため、1 つの H3 セルに複数のグリッド点を追加する。
