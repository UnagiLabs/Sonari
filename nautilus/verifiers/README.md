# Sonari Verifiers

`nautilus/verifiers` は、Sonari が外部事実を検証して Sui contract に渡せる署名済み payload を作る領域です。

ここにある verifier は、worker、watcher、relayer、UI、外部 API response をそのまま信頼しません。contract-facing な値は、TEE または verifier 境界で再取得、検証、正規化、BCS encode、署名されます。

## 何を置く場所か

| フォルダ | 役割 |
| --- | --- |
| `common/` | verifier family をまたぐ TypeScript 契約と shared runner helper |
| `earthquake/` | USGS 地震 source を検証し、災害 event / affected cells の payload を作る verifier |
| `membership/` | Membership SBT の本人確認や membership metadata を検証する verifier family |
| `shared-tee/` | Rust TEE crate 間で共有する署名、hash、seed、artifact helper |

## 信頼境界

Verifier の信頼境界は、署名済み result です。

- watcher / runner / relayer は、候補検出、queue 投入、実行起動、配送を担当する。
- TEE / verifier は、source 再取得、検証、正規化、payload 生成、署名を担当する。
- relayer は finalized payload を配送するだけで、payload の意味を変えない。
- Move contract は、署名、version、intent、field order、payload constraints など contract 側で検証できる情報だけを信頼する。

## verifier family

`earthquake` と `membership` は別の信頼境界です。

地震 verifier は災害 event と affected cells を扱います。Membership verifier は本人確認、居住セル、将来の属性検証を扱います。両者の payload、source、rejection rule、署名 key、on-chain apply path は混ぜません。

## 変更時の注意

BCS payload、field order、enum 値、署名対象 bytes、Merkle root、golden vector は Rust / TypeScript / Move をまたぐ契約です。変更する場合は、schema または docs、fixture / golden vector、Rust / TypeScript / Move のテストを一緒に更新してください。

通常の実装確認は、変更した package の test から始め、影響範囲に応じて root の check / test まで広げます。
