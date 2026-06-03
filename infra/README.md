# Sonari infra 管理メモ

この README は、管理者が contract publish と infra 更新で迷わないための入口です。
AWS runner の細かい手順は `infra/aws/sonari-verifier-runner/README.md` を見てください。

## まず結論

Contract publish は手動で行います。
GitHub Actions / CI は publish しません。

管理者 wallet の秘密鍵は GitHub、AWS、Lambda、EC2、SSM、GitHub Secrets に入れません。
publish はローカル端末の admin wallet から実行します。

## 使う admin wallet

admin / publisher 用 wallet はここに置きます。

```bash
.local/sonari-dev/sui_wallets/admin/sui_config.yaml
```

現在の admin address は次で確認します。

```bash
sui client --client.config .local/sonari-dev/sui_wallets/admin/sui_config.yaml active-address
```

`active-env` は `testnet` にしてください。

```bash
sui client --client.config .local/sonari-dev/sui_wallets/admin/sui_config.yaml active-env
```

## Publish 前にやること

1. admin wallet に SUI があることを確認します。

```bash
sui client --client.config .local/sonari-dev/sui_wallets/admin/sui_config.yaml balance
```

2. Move contract が通ることを確認します。

```bash
pnpm check:move
```

3. GitHub Actions / AWS に admin private key を追加していないことを確認します。

## Publish する

publish すると、Move が `contracts/Published.toml` を生成または更新します。
これは package ID や upgrade capability ID を持つ公開 metadata なので、git 管理します。
private key は入りません。

```bash
sui client \
  --client.config .local/sonari-dev/sui_wallets/admin/sui_config.yaml \
  --client.env testnet \
  publish contracts \
  --gas-budget 1000000000
```

publish したアカウントが `AdminCap` と `Publisher` を持ちます。
admin account を変えた場合は、新しい admin wallet で再 publish してください。

## Publish 後に控えるもの

`contracts/Published.toml` に記録されるもの:

- `PACKAGE_ID`
- upgrade capability object ID

publish の terminal output から控えるもの:

- `AdminCap` object ID
- `PauseState` object ID
- `DisasterRegistry` object ID
- `MembershipRegistry` object ID
- `VerifierRegistry` object ID
- `IdentityRegistry` object ID
- `MainPool` / `OperationsPool` object ID

これらは後続の admin transaction、relayer、smoke test で使います。

## GitHub / AWS 側で更新するもの

publish 後、dev deploy 用の GitHub Actions variables を新しい package に合わせます。

地震 relayer:

```text
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_TARGET=<PACKAGE_ID>::accessor::create_disaster_event_from_signed_payload
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_REGISTRY=<DisasterRegistry object ID>
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_VERIFIER_REGISTRY=<VerifierRegistry object ID>
```

membership identity の手元確認や smoke では、次の値も新しい object ID に合わせます。

```text
SONARI_IDENTITY_PACKAGE_ID=<PACKAGE_ID>
SONARI_IDENTITY_PAUSE_STATE_ID=<PauseState object ID>
SONARI_IDENTITY_REGISTRY_ID=<IdentityRegistry object ID>
SONARI_MEMBERSHIP_REGISTRY_ID=<MembershipRegistry object ID>
SONARI_VERIFIER_REGISTRY_ID=<VerifierRegistry object ID>
```

admin private key は更新先に含めません。
SourceArchiver private key secret も、admin account 変更だけでは変更しません。

## GitHub Actions がやること

AWS dev stack の deploy は GitHub Actions で行います。
管理者が AWS CLI で CloudFormation deploy を直接実行する必要はありません。

使う workflow:

```text
.github/workflows/aws-sonari-verifier-runner-dev-deploy.yml
```

この workflow は次を行います。

- Lambda / earthquake TEE / earthquake EIF / membership TEE / membership EIF を build する
- earthquake EIF の PCR0 / PCR1 / PCR2 を読み取り、GitHub Actions summary に表示する
- artifact を S3 に upload する
- CloudFormation stack を更新する
- deploy 後に ASG が止まっていること、schedule が disabled のままであることを確認する

submit を有効にする場合、GitHub Actions variables は次の形にします。

```text
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_MODE=submit
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_ALLOW_SUBMIT=true
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_NETWORK=testnet
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_GRPC_URL=https://fullnode.testnet.sui.io:443
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_SENDER_ADDRESS=<relayer signer address>
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_SIGNER_SECRET_ARN=<relayer signer secret ARN>
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_TARGET=<PACKAGE_ID>::accessor::create_disaster_event_from_signed_payload
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_REGISTRY=<DisasterRegistry object ID>
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_VERIFIER_REGISTRY=<VerifierRegistry object ID>
```

## 管理者が必ず手でやること

GitHub Actions の外で必要なのは、AdminCap が必要な Sui 操作だけです。

1. contract publish

GitHub Actions は contract を publish しません。
publish は admin wallet で手動実行します。

2. publish 後の object ID を GitHub Actions variables に入れる

`PACKAGE_ID`、`DisasterRegistry`、`VerifierRegistry` などを新しい publish 結果に合わせます。

3. earthquake PCR を VerifierRegistry に登録する

GitHub Actions の run summary に出た PCR0 / PCR1 / PCR2 を使います。
`VerifierRegistry` に config がまだない場合は `create_earthquake_verifier_config`、すでにある場合は `update_earthquake_verifier_config_pcrs` を使います。

```bash
sui client \
  --client.config .local/sonari-dev/sui_wallets/admin/sui_config.yaml \
  --client.env testnet \
  call \
  --package "$PACKAGE_ID" \
  --module admin \
  --function create_earthquake_verifier_config \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "0x$PCR0" "0x$PCR1" "0x$PCR2" \
  --gas-budget 100000000
```

更新する場合:

```bash
sui client \
  --client.config .local/sonari-dev/sui_wallets/admin/sui_config.yaml \
  --client.env testnet \
  call \
  --package "$PACKAGE_ID" \
  --module admin \
  --function update_earthquake_verifier_config_pcrs \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "0x$PCR0" "0x$PCR1" "0x$PCR2" \
  --gas-budget 100000000
```

4. identity PCR を VerifierRegistry に登録する

identity verifier は earthquake と同じ `VerifierRegistry` に、別の config として載ります。
identity の config は config_key=2、family=IDENTITY です。
earthquake の config（config_key=1、family=EARTHQUAKE_ORACLE）とは別枠なので、両方を登録できます。

実際の identity PCR0 / PCR1 / PCR2 は AWS deploy フェーズで membership identity TEE の EIF から確定します。
ここでは admin tx の API 手順だけを earthquake と並べて記録します。実 PCR 値が出たら同じ手順で登録します。
`VerifierRegistry` に identity config がまだない場合は `create_identity_verifier_config`、すでにある場合は `update_identity_verifier_config_pcrs` を使います。

identity の PCR は earthquake とは別の TEE（membership identity runner の EIF）由来です。
直前の earthquake 手順で使った `$PCR0` / `$PCR1` / `$PCR2` をそのまま流用すると、
identity config に earthquake の PCR を誤登録します。
取り違えを防ぐため、identity 用は別名の `$IDENTITY_PCR0` / `$IDENTITY_PCR1` / `$IDENTITY_PCR2` に
identity TEE の値を入れてから実行します。

```bash
sui client \
  --client.config .local/sonari-dev/sui_wallets/admin/sui_config.yaml \
  --client.env testnet \
  call \
  --package "$PACKAGE_ID" \
  --module admin \
  --function create_identity_verifier_config \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "0x$IDENTITY_PCR0" "0x$IDENTITY_PCR1" "0x$IDENTITY_PCR2" \
  --gas-budget 100000000
```

更新する場合:

```bash
sui client \
  --client.config .local/sonari-dev/sui_wallets/admin/sui_config.yaml \
  --client.env testnet \
  call \
  --package "$PACKAGE_ID" \
  --module admin \
  --function update_identity_verifier_config_pcrs \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "0x$IDENTITY_PCR0" "0x$IDENTITY_PCR1" "0x$IDENTITY_PCR2" \
  --gas-budget 100000000
```

5. relayer signer に testnet SUI を入れる

submit では `RELAYER_SIGNER_SECRET_ARN` の private key から復元される address が gas を払います。
この address に testnet SUI がないと、Disaster event 作成 transaction は失敗します。

## Publish しない場所

次では contract publish しません。

- `.github/workflows/ci.yml`
- `.github/workflows/aws-sonari-verifier-runner-dev-deploy.yml`
- AWS CloudFormation deploy
- SourceArchiver Lambda
- Relayer

これらは、すでに publish 済みの `PACKAGE_ID` と object ID を使うだけです。

## 最後に見るもの

publish 後は、次を確認してから AWS deploy や smoke test に進みます。

- admin wallet が新しい `AdminCap` を持っている
- `PACKAGE_ID` が GitHub / AWS 側の値と一致している
- `RelayerTarget` が新しい `PACKAGE_ID` を指している
- registry object ID が publish 結果と一致している
- admin private key が GitHub / AWS に置かれていない
