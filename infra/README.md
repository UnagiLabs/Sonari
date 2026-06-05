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

## GitHub / AWS 側

- admin private key は GitHub / AWS / Lambda / EC2 / SSM に置かない
- 具体的な環境変数は直下の順番セクションで一括で更新する

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

submit を有効にする場合は、上記 `Relayer` の値に加えて submit 専用変数を別途設定します（既存運用通り）。

## publish → GitHub Variables 更新 → PCR登録 Transaction の順番（最小手順）

この順番だけ実行すれば、AIでも迷いにくいです。

1. Contract publish

```bash
sui client \
  --client.config .local/sonari-dev/sui_wallets/admin/sui_config.yaml \
  --client.env testnet \
  publish contracts \
  --gas-budget 1000000000
```

2. publish 出力と `contracts/Published.toml` から値を集めて変数化

```bash
PACKAGE_ID="<published package id>"
ADMIN_CAP_ID="<published admin cap id>"
DISASTER_REGISTRY_ID="<DisasterRegistry object id>"
MEMBERSHIP_REGISTRY_ID="<MembershipRegistry object id>"
VERIFIER_REGISTRY_ID="<VerifierRegistry object id>"
PAUSE_STATE_ID="<PauseState object id>"
IDENTITY_REGISTRY_ID="<IdentityRegistry object id>"
```

3. GitHub Actions の Variables を更新

以下3つは必須。`testnet` 運用では下記を dev env / repo 変数へ入れます。

```text
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_TARGET=${PACKAGE_ID}::accessor::create_disaster_event_from_signed_payload
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_REGISTRY=$DISASTER_REGISTRY_ID
AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_VERIFIER_REGISTRY=$VERIFIER_REGISTRY_ID
```

手元確認や smoke で使うもの:

```text
SONARI_IDENTITY_PACKAGE_ID=$PACKAGE_ID
SONARI_IDENTITY_PAUSE_STATE_ID=$PAUSE_STATE_ID
SONARI_IDENTITY_REGISTRY_ID=$IDENTITY_REGISTRY_ID
SONARI_MEMBERSHIP_REGISTRY_ID=$MEMBERSHIP_REGISTRY_ID
SONARI_VERIFIER_REGISTRY_ID=$VERIFIER_REGISTRY_ID
```

## Membership dummy smoke fixture

dummy World ID smoke の前に、testnet 用 MembershipPass fixture を用意します。
この script は mainnet では動きません。

既存 object を使う場合は、先に env を渡します。

```bash
export SONARI_IDENTITY_PACKAGE_ID="$PACKAGE_ID"
export SONARI_IDENTITY_ADMIN_CAP_ID="$ADMIN_CAP_ID"
export SONARI_IDENTITY_PAUSE_STATE_ID="$PAUSE_STATE_ID"
export SONARI_IDENTITY_REGISTRY_ID="$IDENTITY_REGISTRY_ID"
export SONARI_MEMBERSHIP_REGISTRY_ID="$MEMBERSHIP_REGISTRY_ID"
export SONARI_VERIFIER_REGISTRY_ID="$VERIFIER_REGISTRY_ID"

pnpm identity:testnet-fixture \
  --sui-config .local/sonari-dev/sui_wallets/admin/sui_config.yaml \
  --sui-env testnet
```

必要な object がなく、新しく publish してよい場合だけ
`--publish-if-missing` を付けます。
publish は `contracts/Published.toml` を更新することがあります。
実行後は git diff を確認してください。

出力は `.local/sonari-dev/membership-identity-fixture/` に保存します。
`fixture.env` は runner / handoff 用の object id を持ちます。
`dummy-world-id-request.json` は AWS submit Lambda へ渡す request です。
`manifest.json` は AdminCap と allowlist registry も含む作業メモです。
secret、private key、wallet file は保存しません。

4. PCR 登録トランザクションをまとめて実行

GA サマリの PCR をセットします。

```bash
EARTHQUAKE_EIF_PCR0="..."
EARTHQUAKE_EIF_PCR1="..."
EARTHQUAKE_EIF_PCR2="..."
MEMBERSHIP_IDENTITY_EIF_PCR0="..."
MEMBERSHIP_IDENTITY_EIF_PCR1="..."
MEMBERSHIP_IDENTITY_EIF_PCR2="..."
```

まとめて実行:

```bash
./scripts/register-verifier-configs.sh \
  --package-id "$PACKAGE_ID" \
  --admin-cap-id "$ADMIN_CAP_ID" \
  --verifier-registry-id "$VERIFIER_REGISTRY_ID" \
  --earthquake-pcr0 "$EARTHQUAKE_EIF_PCR0" \
  --earthquake-pcr1 "$EARTHQUAKE_EIF_PCR1" \
  --earthquake-pcr2 "$EARTHQUAKE_EIF_PCR2" \
  --identity-pcr0 "$MEMBERSHIP_IDENTITY_EIF_PCR0" \
  --identity-pcr1 "$MEMBERSHIP_IDENTITY_EIF_PCR1" \
  --identity-pcr2 "$MEMBERSHIP_IDENTITY_EIF_PCR2"
```

補足:

- `--skip-identity` を付けると earthquake のみ先に登録できます。
- identity config は `config_key=2`（family=IDENTITY）なので、earthquake 用 PCR を流用しないこと。

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
