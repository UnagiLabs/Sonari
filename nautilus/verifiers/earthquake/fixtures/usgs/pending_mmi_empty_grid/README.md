# USGS pending_mmi_empty_grid

出典:
- 派生元の USGS イベント: us7000pending-mmi
- 取得日: 2026-05-15
- フィクスチャ用の変更: yes
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

この人工フィクスチャは、ShakeMap ソースと取得済みグリッドを含むものの、グリッドに利用可能な MMI 値がない USGS 詳細レスポンスを表します。grid XML 自体は取得済みなので再試行待ちにはせず、入力不正として `rejected` と `SHAKEMAP_PARSE_FAILED` を返す必要があります。

USGS 詳細 JSON は、Oracle ワークフローテストに必要なフィールドまで最小化されています。
