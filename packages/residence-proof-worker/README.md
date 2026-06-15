# Residence Proof Worker

居住セル allowlist の Merkle proof を R2 から取り出す Cloudflare Worker。フロントエンドへ per-cell の `home_cell + proof` と、地図表示用の static tile を配信します。

- **Role**: R2 に保存された residence allowlist の proof / tile を fail-closed で配信する配布 surface。
- **Trust boundary**: Worker / R2 は配布層であり信頼しない。最終的な正しさは Move contract が登録済み Merkle root と proof で検証する。

## Where to Read More
- [../../docs/verifiers/proof_workers.md](../../docs/verifiers/proof_workers.md) — full design / spec
- [../../docs/verifiers/overview.md](../../docs/verifiers/overview.md) — verifier system overview

---

# Residence Proof Worker（日本語）

居住セル allowlist の Merkle proof を R2 から取り出す Cloudflare Worker。フロントエンドへ per-cell の `home_cell + proof` と、地図表示用の static tile を配信します。

- **役割**: R2 に保存された residence allowlist の proof / tile を fail-closed で配信する配布 surface。
- **信頼境界**: Worker / R2 は配布層であり信頼しない。最終的な正しさは Move contract が登録済み Merkle root と proof で検証する。

## 詳細資料
- [../../docs/verifiers/proof_workers.md](../../docs/verifiers/proof_workers.md) — 完全な設計 / 仕様
- [../../docs/verifiers/overview.md](../../docs/verifiers/overview.md) — verifier 全体概要
