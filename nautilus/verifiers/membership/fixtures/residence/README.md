# Residence Fixtures

`residence` は、将来の residence verifier fixture を置く予約領域です。

Residence verifier は、ユーザーが申告した H3 resolution 7 の居住 cell が `land_allowlist_res7` に含まれる登録可能な陸地 cell かを検証します。本人確認 provider の KYC / World ID result は扱いません。

## 将来ここに置くもの

- valid residence cell の success fixture。
- ocean-only cell や resolution mismatch の reject fixture。
- `land_allowlist_res7` の識別子または commitment を含む expected result。
- TEE / verifier と Move metadata verifier が同じ result を検証できる golden vector。

## 置かないもの

- raw address、GPS 履歴、本人確認 document などの個人情報。
- 地震 verifier の affected cells。
- KYC / World ID の proof body。

実装を追加する時は、`membership/verifiers/residence/README.md` の信頼境界と rejection rule に合わせて fixture を作ります。
