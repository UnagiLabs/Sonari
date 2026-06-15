# Membership Runner

`membership/runner` は、Membership identity verification job を受け付け、AWS workflow に流す TypeScript package です。

この package は本人確認 proof の意味を検証しません。request を parse し、DynamoDB に job として保存し、due job を Step Functions に渡し、TEE result を受け取って job state を更新します。本人確認の最終判断と署名は `membership/tee/` の責務です。

## 何を担当するか

- SubmitVerification Lambda の request parse と job idempotency。
- Verification job の DynamoDB 永続化。
- Batch verifier Lambda による due job の claim。
- Membership Step Functions execution の開始。
- shared runner capacity に渡す workflow input の組み立て。
- TEE result 後の retry / failed / completed state transition。
- 明示設定がある場合の Sui submission helper。

## 信頼境界

Runner は配送と状態管理の層です。次の値を信頼して payload の意味を決めてはいけません。

- caller から来た HTTP body。
- DynamoDB に保存された request JSON。
- Step Functions input。
- EC2 / SSM / S3 の transport metadata。

Contract-facing な本人確認 result は、TEE が source を確認し、BCS payload bytes を作り、その bytes に署名したものだけを使います。

## 主な入口

- `createSubmitVerificationHandler`: HTTP request を job にする Lambda handler。
- `createBatchVerifierHandler`: due job を Step Functions に渡す batch Lambda handler。
- `StepFunctionsWorkflowStarter`: membership workflow execution の開始。
- `DynamoDbVerificationJobRepository`: AWS 上の job repository。

## 検証

```bash
pnpm --filter @sonari/membership-verifier-runner test
pnpm --filter @sonari/membership-verifier-runner typecheck
```
