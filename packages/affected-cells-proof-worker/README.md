# affected-cells-proof-worker

地震影響セル（affected cells）の Merkle proof を登録・配信する Cloudflare Worker。Walrus 由来データを検証して R2 に保存し、フロントエンドへ per-cell proof を返します。

- **Role**: AWS から affected cells を受け取り Merkle proof を R2 に登録し、h3_index ごとの proof を fail-closed で配信する配布 surface。
- **Trust boundary**: Worker / R2 は配布層であり信頼しない。最終的な正しさは Move contract が登録済み Merkle root と proof で検証する。

## Where to Read More
- [../../docs/verifiers/proof_workers.md](../../docs/verifiers/proof_workers.md) — full design / spec
- [../../docs/verifiers/overview.md](../../docs/verifiers/overview.md) — verifier system overview

---

# affected-cells-proof-worker（日本語）

地震影響セル（affected cells）の Merkle proof を登録・配信する Cloudflare Worker。Walrus 由来データを検証して R2 に保存し、フロントエンドへ per-cell proof を返します。

- **役割**: AWS から affected cells を受け取り Merkle proof を R2 に登録し、h3_index ごとの proof を fail-closed で配信する配布 surface。
- **信頼境界**: Worker / R2 は配布層であり信頼しない。最終的な正しさは Move contract が登録済み Merkle root と proof で検証する。

## 詳細資料
- [../../docs/verifiers/proof_workers.md](../../docs/verifiers/proof_workers.md) — 完全な設計 / 仕様
- [../../docs/verifiers/overview.md](../../docs/verifiers/overview.md) — verifier 全体概要
