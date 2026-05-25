# USGS rejected_no_affected_cells

出典:
- 派生元の USGS イベント: us7000no-affected
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

この人工フィクスチャは、有効な MMI 値を持つものの、すべての値が MMI VII を下回る USGS の ShakeMap ソースを表します。`cell_band >= 1` の影響セルが存在しないため、Oracle は拒否する必要があります。

USGS 詳細 JSON は、Oracle ワークフローテストに必要なフィールドまで最小化されています。
