# Operations Index

Operational runbooks and setup guides for running Sonari's contract publish, AWS verifier runners, smoke tests, and residence-cell data pipeline.

- [./contract_republish_runbook.md](./contract_republish_runbook.md) — contract re-publish runbook: republishing the Move package and reconciling on-chain object IDs and PCR config
- [./admin_setup.md](./admin_setup.md) — admin / genesis setup: manual contract publish, admin wallet handling, GitHub Variables and PCR registration ordering
- [./verifier_runner.md](./verifier_runner.md) — Sonari verifier runner AWS stack runbook: deploy, PCR config, smoke acceptance, Floor Census, troubleshooting
- [./membership_runner.md](./membership_runner.md) — membership identity AWS runner runbook: artifact build, deploy, World ID verification, VerifierRegistry registration, Sui submit
- [./aws_smoke.md](./aws_smoke.md) — AWS smoke scripts: `pnpm aws:*` verification/smoke commands, invariants, and script boundaries
- [./residence_cells_pipeline.md](./residence_cells_pipeline.md) — residence-cell generation pipeline: allowlist, Merkle root, proof shards, map tiles, R2/S3 distribution

---

# 運用インデックス

Sonari の contract publish、AWS verifier runner、smoke test、residence-cell データパイプラインを運用するための runbook とセットアップ手順をまとめます。

- [./contract_republish_runbook.md](./contract_republish_runbook.md) — contract 再 publish runbook。Move package を再 publish し、on-chain object ID と PCR config を再整合する
- [./admin_setup.md](./admin_setup.md) — admin / genesis セットアップ。手動 contract publish、admin wallet の扱い、GitHub Variables と PCR 登録の順番
- [./verifier_runner.md](./verifier_runner.md) — Sonari verifier runner AWS stack の runbook。deploy、PCR config、smoke acceptance、Floor Census、詰まりどころ
- [./membership_runner.md](./membership_runner.md) — membership identity AWS runner の runbook。artifact build、deploy、World ID verification、VerifierRegistry registration、Sui submit
- [./aws_smoke.md](./aws_smoke.md) — AWS smoke スクリプト。`pnpm aws:*` の verification / smoke コマンド、invariants、script boundaries
- [./residence_cells_pipeline.md](./residence_cells_pipeline.md) — residence-cell 生成パイプライン。allowlist、Merkle root、proof shard、map tile、R2/S3 配布
