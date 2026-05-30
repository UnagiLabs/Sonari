# @sonari/verifier-contracts

`@sonari/verifier-contracts` は、TypeScript runtime が共有する verifier-level contract package です。

現在の主な利用者は AWS runner workflow です。地震 verifier と membership identity verifier が 1 つの EC2 / Nitro Enclave runner capacity を共有するため、Step Functions、Lambda、runner control code が同じ verifier kind と runner helper を使います。

## 提供するもの

- `earthquake` / `membership_identity` の verifier kind 定義。
- `parseVerifierKind` と `parseExpectedVerifierKind` による境界 parse。
- shared runner lease の owner 生成、acquire、release helper。
- ASG desired capacity 変更、ready instance 探索、SSM command dispatch / poll、S3 result read の interface。

## 境界

この package は、runner orchestration の contract だけを扱います。地震 source、World ID proof、BCS payload の中身は検証しません。

`verifier_kind` は capacity sharing の安全装置です。workflow input や Lambda output に含まれる kind が期待値と違う場合は fail-closed にします。

## 検証

```bash
pnpm --filter @sonari/verifier-contracts test
pnpm --filter @sonari/verifier-contracts typecheck
```
