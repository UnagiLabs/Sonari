# Student Verifier

`student` は、将来の student eligibility verifier 実装用に予約している領域です。

現在の MVP では未実装です。ここに実装を追加する場合は、本人確認済み membership に対して「学生 eligibility を満たすか」を検証する verifier として設計します。

## 想定する責務

- 学生 eligibility source を検証する。
- membership id、owner、issuer、発行時刻、有効期限を result に含める。
- verified result だけに署名する。
- reject / pending / unsupported result には署名を付けない。
- raw credential や個人情報を contract-facing payload に入れない。

## identity verifier との違い

KYC / World ID は本人確認 provider です。Student verifier は本人確認の代替ではありません。

Student verifier を追加する場合も、本人確認済みかどうかの状態更新は identity verifier の契約に従います。ここでは追加 eligibility metadata の検証だけを扱います。

## 実装前に決めること

- 信頼する issuer と source policy。
- request / result の JSON contract。
- BCS field order と enum 値。
- expiry と revocation の扱い。
- fixture / golden vector の形式。
