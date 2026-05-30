# Common Verifier Code

`common` は、個別 verifier の business logic ではなく、verifier family をまたいで共有する契約を置く場所です。

現在は `contracts/` に TypeScript の shared contract package を置いています。ここでは地震や membership の source 検証そのものは行いません。

## 何を担当するか

- verifier kind の定義と parse。
- shared AWS runner を使うための lease / capacity / command helper。
- Step Functions や Lambda が verifier kind を取り違えないための小さな境界関数。

## 何を置かないか

- USGS や World ID など domain-specific source の検証。
- BCS payload の domain-specific field order。
- Move contract に直接対応する verifier result の意味づけ。

Domain 固有の契約は、それぞれ `earthquake/shared/` や `membership/shared/` に置きます。
