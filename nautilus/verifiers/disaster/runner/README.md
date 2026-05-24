# Disaster Runner

disaster verifier 用の AWS EC2 host service です。Cloudflare Worker が利用する runner HTTP contract を公開します。

- `GET /health`
- `POST /start`
- `POST /process`
- `POST /stop`
- `POST /relayer/preview`
- `POST /relayer/dry_run`

すべての endpoint は `Authorization: Bearer <RUNNER_TOKEN>` を必須とします。`/process` が受け付ける body は次の形式だけです。

```json
{
  "payload": {
    "source_event_id": "us7000...",
    "hazard_type": 1,
    "primary_source": 1,
    "geo_resolution": 7
  }
}
```

lifecycle contract:

1. `POST /start` を `{}` で呼び出します。response は `{ "ok": true, "runner_id": "..." }` を含みます。
2. 上記 payload wrapper と `x-runner-id: <runner_id>` header を付けて `POST /process` を呼び出します。runner は runner id がない request、または unknown runner id の request を拒否します。
3. `{ "runner_id": "..." }` で `POST /stop` を呼び出します。対象 runner で TEE command が実行中の場合、service はそれを abort し、spawn 済み child process を終了します。unknown runner id は error です。

`RUNNER_BACKEND=aws` の場合、設定された `NITRO_ENCLAVE_PROCESS_COMMAND` を実行し、request JSON を stdin で渡します。`RUNNER_BACKEND=aws` でない場合、local verification 用に `cargo run --manifest-path <TEE_CARGO_MANIFEST_PATH> -- production --input <tmp>` を使います。

本番必須 environment:

```txt
RUNNER_TOKEN=<bearer-token>
RUNNER_BACKEND=aws
NITRO_ENCLAVE_PROCESS_COMMAND=<host-to-enclave-command>
SONARI_TEE_SIGNING_KEY_SEED=<32-byte-hex-seed>
SONARI_WALRUS_AGGREGATOR_URL=<url>
```

EC2 bootstrap script が Secrets Manager の値を runner service user から読める local file として materialize する場合は、`RUNNER_TOKEN_FILE` と `SONARI_TEE_SIGNING_KEY_SEED_FILE` も利用できます。
