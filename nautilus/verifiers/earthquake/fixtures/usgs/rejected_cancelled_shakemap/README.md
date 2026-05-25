# USGS rejected_cancelled_shakemap

出典:
- 派生元の USGS イベント: us7000cancelled
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

この人工フィクスチャは、`map-status` が `CANCELLED` の USGS の ShakeMap プロダクトを表します。Oracle はグリッドを読まずに拒否し、`SHAKEMAP_CANCELLED` を返す必要があります。

USGS 詳細 JSON は、Oracle ワークフローテストに必要なフィールドまで最小化されています。
