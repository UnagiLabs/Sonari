# PCR config runbook

Earthquake verifier と membership identity verifier の PCR config は、既存の `admin.move` 関数で管理します。既存の `admin.move` 関数で足りるため、新しい wrapper は追加しません。

## 共通ルール

- AdminCap を持つ管理者 wallet は AWS に置きません。
- PCR config の登録、更新、停止は、デプロイ時に Codex が動く管理端末の project-local admin wallet から実行します。
- AdminCap の秘密鍵や wallet config は AWS Runner、EC2、Lambda、SSM、AWS Secrets Manager に入れてはいけません。
- Relayer wallet は AdminCap を持ちません。Relayer wallet は `accessor::create_disaster_event_from_signed_payload` の submit だけに使います。
- SourceArchiver 用 hot wallet をローカルで扱う場合も admin wallet とは分離し、AWS Secrets Manager の `sonari/walrus-archiver/private-key` は raw `suiprivkey...` secret だけを保持します。
- `metadata_verifier` 側の PCR config 関数は package 内部用です。外部運用では `admin` module だけを入口にします。

AWS Runner は `metadata_verifier::register_enclave_instance` を呼びます。Relayer は `accessor::create_disaster_event_from_signed_payload` を呼びます。どちらも AdminCap を持たず、登録済み PCR と attestation、または登録済み enclave instance の署名で検証されます。

PCR0 / PCR1 / PCR2 は 48 byte SHA-384 measurement です。Move の `vector<u8>` へ渡すときは、`0x` なしの hex を 2 桁ずつ byte に分けます。

```text
PCR0 hex: 0102...3030
Move byte vector: vector[0x01, 0x02, ..., 0x30, 0x30]
```

`PCR*_VECTOR` は、48 byte PCR hex を decimal byte 配列へ変換した値です。`0102` は `[1,2]` です。

```bash
PACKAGE_ID="<published-package-id>"
ADMIN_ADDRESS="<admin-wallet-address>"
ADMIN_CAP_ID="<admin-cap-object-id>"
VERIFIER_REGISTRY_ID="<verifier-registry-object-id>"
PCR0_VECTOR='[1,2,3]'
PCR1_VECTOR='[4,5,6]'
PCR2_VECTOR='[7,8,9]'
```

登録または更新後は transaction digest の event を確認します。`VerifierConfigCreated` と `VerifierConfigPcrsUpdated` では、actor が `ADMIN_ADDRESS` であること、PCR と config version が想定通りであることを確認します。

緊急停止後は `VerifierConfigDisabled` を確認します。この event は PCR0/1/2 を持たないため、actor が `ADMIN_ADDRESS` であること、config version が停止対象と一致することを確認します。

この手順の PR 前検証では `pnpm check:move` と README test を実行します。本番 AWS 実行はこの手順の必須検証ではありません。実 stack で attestation flow を確認する場合は、別 issue で ASG cleanup と schedule disabled を gate にします。

## Earthquake PCR config の admin 入口

| 操作 | 関数 | 権限 |
| --- | --- | --- |
| 初回登録 | `admin::create_earthquake_verifier_config` | `&AdminCap` |
| PCR 更新 | `admin::update_earthquake_verifier_config_pcrs` | `&AdminCap` |
| 緊急停止 | `admin::disable_earthquake_verifier_config` | `&AdminCap` |

これらの関数は外部 transaction から呼べる `public fun` です。ただし、成功には `&AdminCap` が必要です。AdminCap を持たない wallet は、呼び出しを試せても config を変更できません。

Earthquake EIF を作るときは、先に `pnpm build:aws-earthquake-eif` を実行します。この script は内部で `nitro-cli build-enclave` を呼び、build output に PCR0 / PCR1 / PCR2 を出します。

EarthquakeTeeEifSha256 は EIF file の SHA-256 checksum です。S3 から EC2 が取得した EIF file の改ざん検知に使います。PCR0/1/2 は attestation document の measurement です。Move の `VerifierConfig` は PCR0/1/2 を見て、起動中の enclave が登録済み code/config かを確認します。

初回登録:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function create_earthquake_verifier_config \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "$PCR0_VECTOR" "$PCR1_VECTOR" "$PCR2_VECTOR" \
  --gas-budget 100000000
```

検証コードや measurement 対象 config を変えた後の PCR 更新:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function update_earthquake_verifier_config_pcrs \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "$PCR0_VECTOR" "$PCR1_VECTOR" "$PCR2_VECTOR" \
  --gas-budget 100000000
```

問題発生時の緊急停止:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function disable_earthquake_verifier_config \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" \
  --gas-budget 100000000
```

## Membership identity PCR config の admin 入口

| 操作 | 関数 | 権限 |
| --- | --- | --- |
| 初回登録（real submit） | `admin::create_identity_verifier_config` | `&AdminCap` |
| PCR 更新（real submit） | `admin::update_identity_verifier_config_pcrs` | `&AdminCap` |
| 緊急停止 | `admin::disable_identity_verifier_config` | `&AdminCap` |

これらの関数は外部 transaction から呼べる `public fun` です。ただし、成功には `&AdminCap` が必要です。AdminCap を持たない wallet は、呼び出しを試せても config を変更できません。

**register（real submit）と update（dry-run）の semantics（#129 案A）:** `create_identity_verifier_config` は VerifierRegistry に membership identity config を新規作成する real submit です。`update_identity_verifier_config_pcrs` は登録済み config の PCR を更新する real submit です。全部 dry-run は登録済み enclave state を要するため不可です。初回は必ず `create_identity_verifier_config` で実 submit してください。更新時の `update_identity_verifier_config_pcrs` も実 submit です。smoke test の dummy proof は実際の config 登録とは無関係で、devnet/testnet 専用の動作確認に使います。

Membership identity EIF を作るときは、先に `pnpm build:aws-membership-identity-eif` を実行します。この script は内部で `nitro-cli build-enclave` を呼び、build output に PCR0 / PCR1 / PCR2 を出します。

GitHub Actions deploy workflow を使った場合は、run summary の `### Membership Identity EIF PCRs` セクションに PCR の値が表示されます。手元で EIF を build した場合は、次のコマンドで PCR を取得できます。

```bash
nitro-cli describe-eif \
  --eif-path dist/aws/membership-identity-tee.eif
```

MembershipIdentityTeeEifSha256 は EIF file の SHA-256 checksum です。S3 から EC2 が取得した EIF file の改ざん検知に使います。PCR0/1/2 は attestation document の measurement です。Move の `VerifierConfig` は PCR0/1/2 を見て、起動中の enclave が登録済み code/config かを確認します。

初回登録（real submit）:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function create_identity_verifier_config \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "$PCR0_VECTOR" "$PCR1_VECTOR" "$PCR2_VECTOR" \
  --gas-budget 100000000
```

検証コードや measurement 対象 config を変えた後の PCR 更新（real submit）:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function update_identity_verifier_config_pcrs \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "$PCR0_VECTOR" "$PCR1_VECTOR" "$PCR2_VECTOR" \
  --gas-budget 100000000
```

問題発生時の緊急停止:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function disable_identity_verifier_config \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" \
  --gas-budget 100000000
```

## Nitro PCR3 と enclave runtime

`NitroEnclaveImageSha384` は EIF の `PCR0` measurement です。`NitroEnclavePcr3` は、48 個の NUL byte に deterministic runner role ARN を続けた値の SHA-384 digest です。

地震 verifier は Nautilus の server pattern に合わせ、EIF 内で起動時に enclave-local な Ed25519 key を生成し、NSM attestation document の `public_key` にその public key を入れます。runner host は `/opt/sonari/bin/run-earthquake-enclave` から VSOCK で `/health_check`、`/get_attestation`、`/process_data` を呼びます。host は Walrus / Sui config を bootstrap するだけで、finalized payload の署名鍵は host に置きません。

Launch template の user data は、AWS Nitro Enclaves allocator の `/etc/nitro_enclaves/allocator.yaml` を `NitroEnclaveCpuCount` / `NitroEnclaveMemoryMiB` に合わせて更新し、`nitro-enclaves-allocator.service` を restart します。`nitro-cli run-enclave --memory` より小さい hugepage 予約で instance を起動してはいけません。

```bash
RUNNER_ROLE_ARN="arn:aws:iam::$EXPECTED_ACCOUNT_ID:role/sonari-verifier-runner-$STACK_NAME-runner"
NITRO_ENCLAVE_PCR3="$(ROLE_ARN="$RUNNER_ROLE_ARN" python3 - <<'PY'
import hashlib
import os

digest = hashlib.sha384()
digest.update(b"\0" * 48)
digest.update(os.environ["ROLE_ARN"].encode("utf-8"))
print(digest.hexdigest())
PY
)"
```
