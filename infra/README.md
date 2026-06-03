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
