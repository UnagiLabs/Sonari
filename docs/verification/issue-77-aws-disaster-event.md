# Issue 77 AWS disaster event verification

確認日時: 2026-05-29 UTC

## 結論

STEP 1「AWS deploy と artifact を確認する」は完了です。

- ローカル worktree は編集前に `d83000d992616a56a769cdb0706acb919ee66b4e` で clean でした。
- GitHub Actions の dev deploy run `26619377088` は success でした。
- AWS の dev stack は `UPDATE_COMPLETE` でした。
- Lambda artifact と TEE artifact は、どちらも deploy commit SHA を含む S3 key で存在しました。
- artifact bucket は CloudFormation parameters から確認しました。
- TEE artifact SHA-256 を CloudFormation parameter / output で確認しました。
- ASG は `DesiredCapacity=0` で、起動中インスタンスはありませんでした。
- EventBridge Scheduler の schedule は `DISABLED` でした。

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

## Step 状態

| Step | 状態 | メモ |
| --- | --- | --- |
| STEP 1: AWS deploy と artifact を確認する | 完了 | 本 report で evidence を記録 |
| STEP 2 以降 | 未着手 | この作業では実施しない |

## 注意事項

- production code は変更していません。
- secret 値は取得・記載していません。
- AWS credential や local MCP 設定は記載していません。
