# Sonari Identity Verifiers

## 概要

Membership verifier は、Membership SBT の本人確認状態を更新する。
MVP の provider は KYC と World ID の 2 つだけである。

地震 verifier は災害 event と affected cells を検証する。
identity verifier は、受取者が本人確認済みかを検証する。
この 2 つの責務は混ぜない。

## MVP provider

| Provider | 役割 |
| --- | --- |
| KYC | provider response と署名を検証する |
| World ID | Sonari 専用 action の proof を検証する |

KYC と World ID は、どちらも満額 Claim ルートである。
未認証の Membership SBT は Claim できない。

World ID action は Sonari 専用にする。

```text
sonari_membership_register_v1
```

signal には Sui address、nonce、domain separator を含める。
これにより、proof の流用を防ぐ。

## Verifier output

verifier output は最小限にする。

```text
IdentityVerificationResult {
  provider
  verified
  subject_binding_hash
  duplicate_key_hash
  evidence_hash
  issued_at_ms
  expires_at_ms
  terms_version
  signed_statement_hash
}
```

`provider` は `kyc` または `world_id` である。
`verified` が `true` のときだけ、Membership SBT を verified にできる。

`duplicate_key_hash` は provider 内の重複登録を防ぐために使う。

```text
kyc_duplicate_key = hash(kyc_provider_id, provider_user_unique_id)
world_duplicate_key = hash(world_app_id, action, nullifier)
```

KYC と World ID をまたぐ完全な同一人物判定は MVP 外である。
登録時と Claim 時に、複数 SBT と複数 Claim を禁じる表示を出す。
その内容に対して Sui wallet 署名を求める。

## Privacy boundary

verifier は raw personal data を output に含めない。

出してはいけないもの:

- KYC document image
- KYC detail
- World ID proof detail
- raw credential data
- detailed address
- phone
- device identifier
- location history

出してよいもの:

- provider
- verified flag
- duplicate key hash
- evidence hash
- issued / expiry time
- terms version
- signed statement hash

## Job model

identity verification request は queued job として扱う。
job があるときだけ batch workflow を起動する。
job が 0 件なら EC2 / Nitro Enclave は起動しない。

```mermaid
flowchart TD
  Dapp[dapp identity request] --> Submit[SubmitVerification Lambda]
  Submit --> Jobs[DynamoDB verification_jobs]
  Submit --> Evidence[Encrypted evidence snapshot]
  Scheduler[EventBridge Scheduler] --> Batch[BatchVerifier Lambda]
  Batch --> Jobs
  Batch --> Empty{queued job exists}
  Empty -->|no| End[do not start enclave]
  Empty -->|yes| Workflow[Step Functions workflow]
  Workflow --> Enclave[EC2 + Nitro Enclave]
  Enclave --> Result[Signed identity result]
  Result --> Apply[Apply to Membership SBT]
```

## Job schema

Suggested fields:

- `job_id`
- `membership_id`
- `owner_wallet`
- `provider`
- `status`
- `priority`
- `submitted_at`
- `started_at`
- `finished_at`
- `attempt_count`
- `evidence_hash`
- `evidence_s3_key`
- `result_s3_key`
- `duplicate_key_hash`
- `error_code`

## ディレクトリ構成

```txt
nautilus/verifiers/membership/
  README.md
  shared/
  tee/
  fixtures/
```

旧 residence / student verifier docs は target MVP から外す。
将来の Program で必要になった場合は、本人確認 gate とは別の
eligibility verifier として再設計する。
