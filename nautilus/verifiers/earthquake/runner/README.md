# Earthquake Runner

A thin EC2 host HTTP server that bridges earthquake verifier requests to the Nitro Enclave / TEE and returns the TEE result JSON. It is an optional / local-and-manual path; the production AWS workflow drives the enclave via SSM Run Command instead.

- **Role**: Launch / bridge TEE execution (start, attestation, process, stop) for local verification and as a future private runner service.
- **Trust boundary**: Host bridge only; `get_attestation` and `process_data` must use the same enclave instance key, and finalized signing material never reaches the EC2 host.

## Where to Read More
- [../../../../docs/verifiers/earthquake_runner.md](../../../../docs/verifiers/earthquake_runner.md) — full design / spec
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier system overview

---

# Earthquake Runner（日本語）

地震 verifier request を Nitro Enclave / TEE へ橋渡しし、TEE result JSON を返す薄い EC2 host HTTP server です。これは optional かつローカル / 手動向けの経路で、本番 AWS workflow は代わりに SSM Run Command で enclave を駆動します。

- **役割**: ローカル検証や将来の private runner service として TEE 実行（start / attestation / process / stop）を起動・橋渡しする。
- **信頼境界**: host bridge のみ。`get_attestation` と `process_data` は同じ enclave instance の鍵を使う必要があり、finalized signing material は EC2 host へ渡さない。

## 詳細資料
- [../../../../docs/verifiers/earthquake_runner.md](../../../../docs/verifiers/earthquake_runner.md) — 完全な設計 / 仕様
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier 全体概要
