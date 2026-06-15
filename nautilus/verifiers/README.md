# Sonari Verifiers

The Nautilus / TEE side of Sonari. Each verifier re-fetches its source data inside a Nitro Enclave, normalizes it, and signs a `payload_bcs` result that Sui Move re-verifies. Off-chain parts only carry the signed bytes — they cannot change the meaning.

- **Role**: produce TEE-signed earthquake and identity results (plus Merkle roots / proofs) for on-chain verification
- **Trust boundary**: the enclave is the only root of trust; watchers, runners, relayers, and caches are untrusted transport

## Where to Read More

- [docs/verifiers/overview.md](../../docs/verifiers/overview.md) — full overview: Nautilus pattern, trust model, implemented flows, and the exact payload field order
- Earthquake: [earthquake.md](../../docs/verifiers/earthquake.md) · [shared](../../docs/verifiers/earthquake_shared.md) · [tee](../../docs/verifiers/earthquake_tee.md) · [watcher](../../docs/verifiers/earthquake_watcher.md) · [relayer](../../docs/verifiers/earthquake_relayer.md) · [runner](../../docs/verifiers/earthquake_runner.md)
- Identity: [identity.md](../../docs/verifiers/identity.md) · [tee](../../docs/verifiers/identity_tee.md) · [runner](../../docs/verifiers/identity_runner.md)
- Proof workers: [proof_workers.md](../../docs/verifiers/proof_workers.md)

---

# Sonari Verifiers（日本語）

Sonari の Nautilus / TEE 側です。各 verifier は Nitro Enclave の中で source データを再取得し、正規化し、Sui Move が再検証する `payload_bcs` 結果に署名します。off-chain の各部は署名済みバイトを運ぶだけで、意味を変えることはできません。

- **役割**: on-chain 検証のための TEE 署名済み地震 / identity 結果（および Merkle root / proof）の生成
- **信頼境界**: enclave のみが信頼の起点。watcher / runner / relayer / cache は信頼しない transport

## 詳細資料

- [docs/verifiers/overview.md](../../docs/verifiers/overview.md) — 完全な概要: Nautilus パターン、信頼モデル、実装済みフロー、payload の field 順
- 地震: [earthquake.md](../../docs/verifiers/earthquake.md) · [shared](../../docs/verifiers/earthquake_shared.md) · [tee](../../docs/verifiers/earthquake_tee.md) · [watcher](../../docs/verifiers/earthquake_watcher.md) · [relayer](../../docs/verifiers/earthquake_relayer.md) · [runner](../../docs/verifiers/earthquake_runner.md)
- identity: [identity.md](../../docs/verifiers/identity.md) · [tee](../../docs/verifiers/identity_tee.md) · [runner](../../docs/verifiers/identity_runner.md)
- proof worker: [proof_workers.md](../../docs/verifiers/proof_workers.md)
