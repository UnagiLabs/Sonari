# Issue 77 AWS disaster event verification

確認日時: 2026-05-29 UTC

## 結論

STEP 1「AWS deploy と artifact を確認する」は完了です。
STEP 2「Sui testnet の object 設定を確認する」も完了です。

- ローカル worktree は編集前に `d83000d992616a56a769cdb0706acb919ee66b4e` で clean でした。
- GitHub Actions の dev deploy run `26619377088` は success でした。
- AWS の dev stack は `UPDATE_COMPLETE` でした。
- Lambda artifact と TEE artifact は、どちらも deploy commit SHA を含む S3 key で存在しました。
- artifact bucket は CloudFormation parameters から確認しました。
- TEE artifact SHA-256 を CloudFormation parameter / output で確認しました。
- ASG は `DesiredCapacity=0` で、起動中インスタンスはありませんでした。
- EventBridge Scheduler の schedule は `DISABLED` でした。
- 既存 testnet package は古い `payload_v1` を含んでいました。
- #76 後の contract を `infra` 配下の Sui config で publish しました。
- 新 package は `payload` module を含んでいます。
- 新 `DisasterRegistry` を作成しました。
- 新 `VerifierRegistry` に AWS TEE public key を登録しました。

## 確認対象

| 項目 | 値 |
| --- | --- |
| Repository | `UnagiLabs/Sonari` |
| Worktree | `/home/manji/github/Sonari/.codex/state/worktrees/issue-77-aws-disaster-event-verification` |
| Branch | `feature/issue-77-aws-disaster-event-verification` |
| Commit | `d83000d992616a56a769cdb0706acb919ee66b4e` |
| GitHub Actions run | `26619377088` |
| AWS region | `ap-northeast-1` |
| CloudFormation stack | `sonari-earthquake-runner-dev` |
| Sui config | `infra/aws/earthquake-runner/.local/sonari-dev/sui_config.yaml` |
| Sui active address | `0x61771ffa71b0d4fc02ffb63d975f78573f844157b38a816c19bcce5b275c108b` |
| New package ID | `0x972abc4b8b18da735539f5deb3999b32420a343196c64aca07e6b6a32465c3ea` |
| DisasterRegistry ID | `0x98e90c54da1241b7ecda39dfd11365861f85429d14f0300a07063915ea654aa7` |
| VerifierRegistry ID | `0x9676df2dc8a4de782f51c7fae7b90186936d1e21889dee43ec2e5274240220a1` |

## 実行コマンドと結果

### 1. ローカル worktree

```bash
git rev-parse HEAD
```

結果: `d83000d992616a56a769cdb0706acb919ee66b4e`

```bash
git status --short --branch
```

結果: `## feature/issue-77-aws-disaster-event-verification`

短い差分表示が空だったため、report 編集前の worktree は clean でした。

### 2. GitHub Actions deploy run

```bash
gh run view 26619377088 --repo UnagiLabs/Sonari --json conclusion,headSha,url
```

結果:

| 項目 | 値 |
| --- | --- |
| conclusion | `success` |
| headSha | `d83000d992616a56a769cdb0706acb919ee66b4e` |
| url | `https://github.com/UnagiLabs/Sonari/actions/runs/26619377088` |

deploy commit は `d83000d992616a56a769cdb0706acb919ee66b4e` です。

### 3. CloudFormation stack と deploy parameters

```bash
aws cloudformation describe-stacks \
  --stack-name sonari-earthquake-runner-dev \
  --region ap-northeast-1
```

必要な項目だけを確認しました。

| 項目 | 値 |
| --- | --- |
| StackStatus | `UPDATE_COMPLETE` |
| LastUpdatedTime | `2026-05-29T05:16:40.791000+00:00` |
| GitCommitSha | `d83000d992616a56a769cdb0706acb919ee66b4e` |
| ScheduleState | `DISABLED` |
| LambdaCodeS3Bucket | `sonari-dev-eq-runner-artifacts-595103996064-ap-northeast-1` |
| TeeArtifactS3Bucket | `sonari-dev-eq-runner-artifacts-595103996064-ap-northeast-1` |
| LambdaCodeS3Key | `earthquake-runner/d83000d992616a56a769cdb0706acb919ee66b4e/earthquake-runner-lambda.zip` |
| TeeArtifactS3Key | `earthquake-runner/d83000d992616a56a769cdb0706acb919ee66b4e/earthquake-tee-artifact.tar.gz` |
| TeeArtifactSha256 | `60a15c743aa72a5159fc12471c45bc9b853b3ac4dc32b5bd4da3978e88b8499e` |

artifact bucket は CloudFormation parameters の
`LambdaCodeS3Bucket` と `TeeArtifactS3Bucket` から確認しました。

### 4. Lambda artifact

```bash
aws s3api head-object \
  --bucket sonari-dev-eq-runner-artifacts-595103996064-ap-northeast-1 \
  --key earthquake-runner/d83000d992616a56a769cdb0706acb919ee66b4e/earthquake-runner-lambda.zip \
  --region ap-northeast-1
```

結果:

| 項目 | 値 |
| --- | --- |
| ContentLength | `1077775` |
| LastModified | `2026-05-29T05:16:21+00:00` |
| ETag | `"207a3d9c095c95ba05d69a41356f3e7a"` |
| ServerSideEncryption | `AES256` |

S3 key に deploy commit SHA が含まれています。

### 5. TEE artifact

```bash
aws s3api head-object \
  --bucket sonari-dev-eq-runner-artifacts-595103996064-ap-northeast-1 \
  --key earthquake-runner/d83000d992616a56a769cdb0706acb919ee66b4e/earthquake-tee-artifact.tar.gz \
  --region ap-northeast-1
```

結果:

| 項目 | 値 |
| --- | --- |
| ContentLength | `26958096` |
| LastModified | `2026-05-29T05:16:24+00:00` |
| ETag | `"ed685ec33fc0816150739c6e923d2f15-4"` |
| ServerSideEncryption | `AES256` |

S3 key に deploy commit SHA が含まれています。

TEE artifact SHA-256:

```text
60a15c743aa72a5159fc12471c45bc9b853b3ac4dc32b5bd4da3978e88b8499e
```

この値は CloudFormation の `TeeArtifactSha256` parameter と
`TeeArtifactSha256Output` output で一致しました。

### 6. Auto Scaling Group

```bash
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names sonari-earthquake-runner-dev-RunnerAutoScalingGroup-yupMpZMVR2FX \
  --region ap-northeast-1
```

結果:

| 項目 | 値 |
| --- | --- |
| AutoScalingGroupName | `sonari-earthquake-runner-dev-RunnerAutoScalingGroup-yupMpZMVR2FX` |
| MinSize | `0` |
| MaxSize | `1` |
| DesiredCapacity | `0` |
| Instances | `[]` |

待機費用を生む EC2 runner instance はありません。

### 7. Scheduler

```bash
aws scheduler get-schedule \
  --name sonari-earthquake-runner-dev-WatcherSchedule-1G9XRH5PDUSYE \
  --region ap-northeast-1
```

結果:

| 項目 | 値 |
| --- | --- |
| Name | `sonari-earthquake-runner-dev-WatcherSchedule-1G9XRH5PDUSYE` |
| State | `DISABLED` |
| ScheduleExpression | `rate(5 minutes)` |
| FlexibleTimeWindow | `OFF` |

定期実行は無効化されています。

### 8. Sui config と active address

`infra` 配下の Sui config を明示指定しました。

```bash
sui client \
  --client.config infra/aws/earthquake-runner/.local/sonari-dev/sui_config.yaml \
  active-env
```

結果: `testnet`

```bash
sui client \
  --client.config infra/aws/earthquake-runner/.local/sonari-dev/sui_config.yaml \
  active-address
```

結果:

```text
0x61771ffa71b0d4fc02ffb63d975f78573f844157b38a816c19bcce5b275c108b
```

この config は `infra` 配下の検証用設定です。
ローカルの個人用 Sui config は正として扱っていません。

### 9. 既存 package の確認

既存の owned `AdminCap` から package を確認しました。

```bash
sui client \
  --client.config infra/aws/earthquake-runner/.local/sonari-dev/sui_config.yaml \
  objects --json
```

既存 package:

```text
0x647f7530300691a6822cc7274ff04d690696eaa131bbc4fd5fe44caf018a56ae
```

この package は `payload_v1` module を含んでいました。
そのため #76 後の contract ではありませんでした。

### 10. 新 contract の Move build

publish 前に、現在の contract が build できることを確認しました。

```bash
sui move build -p contracts --force --lint --warnings-are-errors
```

結果: success

### 11. 新 contract の publish

まず dry-run しました。

```bash
sui client \
  --client.config infra/aws/earthquake-runner/.local/sonari-dev/sui_config.yaml \
  publish contracts \
  --skip-dependency-verification \
  --gas-budget 500000000 \
  --dry-run \
  --json
```

結果:

| 項目 | 値 |
| --- | --- |
| status | `success` |
| computationCost | `3300000` |
| storageCost | `329604400` |

dry-run が通ったため、testnet に publish しました。

```bash
sui client \
  --client.config infra/aws/earthquake-runner/.local/sonari-dev/sui_config.yaml \
  publish contracts \
  --skip-dependency-verification \
  --gas-budget 500000000 \
  --json
```

結果:

| 項目 | 値 |
| --- | --- |
| tx digest | `AQNT9tx21JH42ntbF6UCSEeYmX5kxbPBupybYeBbVeYS` |
| status | `success` |
| package ID | `0x972abc4b8b18da735539f5deb3999b32420a343196c64aca07e6b6a32465c3ea` |
| AdminCap ID | `0xc5a584bc3390048ac44fce28c81fd4bdb7b3664fde66a02503b77295239914cd` |
| VerifierRegistry ID | `0x9676df2dc8a4de782f51c7fae7b90186936d1e21889dee43ec2e5274240220a1` |

publish された module には `payload` が含まれていました。
古い `payload_v1` は含まれていません。

### 12. DisasterRegistry の作成

新 package 用の `DisasterRegistry` を作成しました。

```bash
sui client \
  --client.config infra/aws/earthquake-runner/.local/sonari-dev/sui_config.yaml \
  call \
  --package 0x972abc4b8b18da735539f5deb3999b32420a343196c64aca07e6b6a32465c3ea \
  --module admin \
  --function create_disaster_registry \
  --args 0xc5a584bc3390048ac44fce28c81fd4bdb7b3664fde66a02503b77295239914cd \
  --gas-budget 50000000 \
  --json
```

結果:

| 項目 | 値 |
| --- | --- |
| tx digest | `5ogLdtwMSQJwJtkAR6h8hNvmwXeMxiPdn6BQ73Q34VXj` |
| status | `success` |
| DisasterRegistry ID | `0x98e90c54da1241b7ecda39dfd11365861f85429d14f0300a07063915ea654aa7` |

object type:

```text
0x972abc4b8b18da735539f5deb3999b32420a343196c64aca07e6b6a32465c3ea::disaster_event::DisasterRegistry
```

### 13. TEE public key の登録

AWS TEE signing seed から public key だけを導出しました。
seed の値は表示せず、report にも残していません。

登録した public key:

```text
0xea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c
```

`VerifierRegistry` へ登録しました。

```bash
sui client \
  --client.config infra/aws/earthquake-runner/.local/sonari-dev/sui_config.yaml \
  call \
  --package 0x972abc4b8b18da735539f5deb3999b32420a343196c64aca07e6b6a32465c3ea \
  --module admin \
  --function add_verifier_key \
  --args <AdminCap ID> <VerifierRegistry ID> 3 1 <public key bytes> \
  --gas-budget 50000000 \
  --json
```

結果:

| 項目 | 値 |
| --- | --- |
| tx digest | `CC1zFxe3exCfEoYp6r45R73z3BzdDXZ5aBBa8UtgDyUe` |
| status | `success` |
| verifier_family | `3` |
| verifier_version | `1` |
| enabled | `true` |
| VerifierRegistry ID | `0x9676df2dc8a4de782f51c7fae7b90186936d1e21889dee43ec2e5274240220a1` |

event の public key は base64 では次の値でした。

```text
6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=
```

これは上の hex public key と同じ bytes です。

### 14. 新 object の確認

```bash
sui client \
  --client.config infra/aws/earthquake-runner/.local/sonari-dev/sui_config.yaml \
  object 0x9676df2dc8a4de782f51c7fae7b90186936d1e21889dee43ec2e5274240220a1 \
  --json
```

結果:

```text
0x972abc4b8b18da735539f5deb3999b32420a343196c64aca07e6b6a32465c3ea::metadata_verifier::VerifierRegistry
```

```bash
sui client \
  --client.config infra/aws/earthquake-runner/.local/sonari-dev/sui_config.yaml \
  object 0x98e90c54da1241b7ecda39dfd11365861f85429d14f0300a07063915ea654aa7 \
  --json
```

結果:

```text
0x972abc4b8b18da735539f5deb3999b32420a343196c64aca07e6b6a32465c3ea::disaster_event::DisasterRegistry
```

## Step 状態

| Step | 状態 | メモ |
| --- | --- | --- |
| STEP 1: AWS deploy と artifact を確認する | 完了 | 本 report で evidence を記録 |
| STEP 2: Sui testnet の object 設定を確認する | 完了 | 新 package / registry / verifier key を確定 |
| STEP 3 以降 | 未着手 | この作業では実施しない |

## 注意事項

- production code は変更していません。
- secret 値は report に記載していません。
- `infra` 配下の Sui / Walrus 設定を使いました。
- 既存 testnet package は古かったため、新 package を publish しました。
- AWS credential や local MCP 設定は記載していません。
