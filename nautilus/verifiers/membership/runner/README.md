# Membership Runner

Membership identity verification job を受け付け、AWS workflow に流す TypeScript package。proof の意味は検証せず、job 永続化と状態管理だけを担当します。

- **Role**: HTTP request を job 化し、DynamoDB 永続化・Step Functions 起動・TEE result 後の状態遷移を行う配送 / 状態管理層。
- **Trust boundary**: HTTP body / DynamoDB / Step Functions input / transport metadata を信頼しない。本人確認の最終判断と署名は TEE の責務。

## Where to Read More
- [../../../../docs/verifiers/identity_runner.md](../../../../docs/verifiers/identity_runner.md) — full design / spec
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier system overview

---

# Membership Runner（日本語）

Membership identity verification job を受け付け、AWS workflow に流す TypeScript package。proof の意味は検証せず、job 永続化と状態管理だけを担当します。

- **役割**: HTTP request を job 化し、DynamoDB 永続化・Step Functions 起動・TEE result 後の状態遷移を行う配送 / 状態管理層。
- **信頼境界**: HTTP body / DynamoDB / Step Functions input / transport metadata を信頼しない。本人確認の最終判断と署名は TEE の責務。

## 詳細資料
- [../../../../docs/verifiers/identity_runner.md](../../../../docs/verifiers/identity_runner.md) — 完全な設計 / 仕様
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier 全体概要
