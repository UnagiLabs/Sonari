# USGS pending_source_no_shakemap

出典:
- 派生元の USGS イベント: us7000pending-source
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

この人工フィクスチャは、取得自体は成功したものの `products.shakemap` が存在しない USGS 詳細レスポンスを表します。Oracle は確定してはならず、`pending_source` と `SHAKEMAP_PRODUCT_MISSING` を返す必要があります。

USGS 詳細 JSON は、Oracle ワークフローテストに必要なフィールドまで最小化されています。
