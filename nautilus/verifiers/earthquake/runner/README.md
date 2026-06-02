# 地震 Runner

地震検証器用の EC2 host service です。Nitro Enclave / TEE に地震 verifier request を渡し、TEE が返した result JSON を呼び出し元へ返すための薄い HTTP server です。

現在の CloudFormation 本線では、この HTTP server は必須経路ではありません。本番 AWS workflow は、Step Functions が RunnerControl Lambda を呼び、RunnerControl Lambda が SSM Run Command で EC2 host に直接 command を送ります。

```mermaid
flowchart TB
  subgraph Current["現在の AWS 本線"]
    SFN["Step Functions"] --> Control["RunnerControl Lambda"]
    Control --> SSM["SSM Run Command"]
    SSM --> Host["EC2 host"]
    Host --> TEE["Nitro Enclave / TEE"]
  end

  subgraph Optional["この package の HTTP server"]
    Client["curl / test client / future private caller"] --> Runner["runner HTTP server"]
    Runner --> Tee2["Nitro Enclave / TEE"]
  end
```

この package は、主に次の用途のために残しています。

- ローカル検証や手動テストで `curl` から TEE 実行を試す。
- EC2 host 上で `/health` を確認する。
- 将来、SSM Run Command ではなく private network 内の runner service として動かす。
- relayer preview / dry-run を sidecar 的に試す。

提供するエンドポイント:

- `GET /health`
- `GET /health_check`
- `POST /start`
- `POST /get_attestation`
- `POST /process_data`
- `POST /stop`
- `POST /relayer/preview`
- `POST /relayer/dry_run`

すべてのエンドポイントは `Authorization: Bearer <RUNNER_TOKEN>` を必須とします。`/process_data` は、Move 登録後に得た enclave tracking metadata を必須にします。

```json
{
  "payload": {
    "source_event_id": "us7000...",
    "hazard_type": 1,
    "primary_source": 1,
    "geo_resolution": 7
  },
  "registration_metadata": {
    "verifier_config_key": 1,
    "verifier_config_version": 1,
    "enclave_instance_public_key": "0x..."
  }
}
```

ライフサイクル契約:

1. `POST /start` を `{}` で呼び出す。応答は `{ "ok": true, "runner_id": "..." }` を含む。
2. `GET /health_check` で TEE が外部 source へ到達できる状態か確認する。
3. `x-runner-id: <runner_id>` header を付けて `POST /get_attestation` を呼び、attestation document と enclave public key を取得する。
4. watcher / workflow が Move 登録を行い、`verifier_config_key`、`verifier_config_version`、`enclave_instance_public_key` を取得する。
5. 上記 payload wrapper と `x-runner-id: <runner_id>` header を付けて `POST /process_data` を呼び出す。Runner は登録 metadata がない request、runner id がない request、または unknown runner id の request を拒否する。
6. `{ "runner_id": "..." }` で `POST /stop` を呼び出す。対象 runner で TEE command が実行中の場合、service はそれを abort し、spawn 済み child process を終了する。Unknown runner id は error にする。

`RUNNER_BACKEND=aws` の場合、設定された `NITRO_ENCLAVE_PROCESS_COMMAND` を実行し、request JSON を stdin で渡します。`RUNNER_BACKEND=aws` 以外では、local verification 用に `cargo run --manifest-path <TEE_CARGO_MANIFEST_PATH> -- production --input <tmp>` を使います。

HTTP server を AWS backend で起動する場合の環境変数:

```txt
RUNNER_TOKEN=<bearer-token>
RUNNER_BACKEND=aws
NITRO_ENCLAVE_PROCESS_COMMAND=<host-to-enclave-command>
SONARI_WALRUS_CLI=<path-to-walrus-cli>
SONARI_EARTHQUAKE_EGRESS_PROXY_URL=<url>
```

## 本番 TEE backend の条件

Nautilus 準拠の本番 backend は、`get_attestation` と `process_data` を同じ enclave instance で処理します。`get_attestation` は enclave 内で生成した公開鍵を含む Nitro attestation document を返し、`process_data` は同じ公開鍵に対応する秘密鍵で finalized payload を署名します。

SSM Run Command 経由で `NITRO_ENCLAVE_PROCESS_COMMAND` を複数回呼ぶ場合でも、この条件は変わりません。Host command は永続 enclave service、vsock bridge、または同等の stateful TEE bridge へ委譲する必要があります。Host 上の一時ファイル、環境変数、固定 seed で鍵を共有する実装は本番経路として扱いません。

固定 seed を使う経路は fixture / debug / test 専用です。EC2 bootstrap script が local file を materialize する場合でも、runner token には `RUNNER_TOKEN_FILE` だけを使い、earthquake finalized signing material は EC2 host へ渡しません。
