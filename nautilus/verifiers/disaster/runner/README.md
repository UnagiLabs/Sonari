# Disaster Runner

AWS EC2 host service for the disaster verifier. It exposes the runner HTTP contract used by the Cloudflare Worker:

- `GET /health`
- `POST /start`
- `POST /process`
- `POST /stop`
- `POST /relayer/preview`
- `POST /relayer/dry_run`

All endpoints require `Authorization: Bearer <RUNNER_TOKEN>`. `/process` accepts only:

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

`RUNNER_BACKEND=aws` runs the configured `NITRO_ENCLAVE_PROCESS_COMMAND` and passes the request JSON on stdin. Without `RUNNER_BACKEND=aws`, the service uses `cargo run --manifest-path <TEE_CARGO_MANIFEST_PATH> -- production --input <tmp>` for local verification.

Required production environment:

```txt
RUNNER_TOKEN=<bearer-token>
RUNNER_BACKEND=aws
NITRO_ENCLAVE_PROCESS_COMMAND=<host-to-enclave-command>
SONARI_TEE_SIGNING_KEY_SEED=<32-byte-hex-seed>
SONARI_WALRUS_AGGREGATOR_URL=<url>
```

`RUNNER_TOKEN_FILE` and `SONARI_TEE_SIGNING_KEY_SEED_FILE` are also supported for EC2 bootstrap scripts that materialize Secrets Manager values as local root-readable files.
