# Earthquake Verifier

Sonari's earthquake oracle implementation. It re-fetches and verifies public USGS / ShakeMap data inside a Nautilus TEE, then produces a signed finalized payload (affected-cell Merkle root + BCS bytes) that the Sui contracts trust to create disaster event roots.

- **Role**: Detect USGS earthquake candidates, verify them in the TEE, and emit signed finalized payloads.
- **Trust boundary**: The signed TEE result is the trust boundary; watcher / runner / relayer may move the payload but must not change its meaning.

## Where to Read More
- [../../../docs/verifiers/earthquake.md](../../../docs/verifiers/earthquake.md) — full design / spec
- [../../../docs/verifiers/overview.md](../../../docs/verifiers/overview.md) — verifier system overview

---

# Earthquake Verifier（日本語）

Sonari の地震オラクル実装です。公開 USGS / ShakeMap データを Nautilus TEE 内で再取得・検証し、Sui コントラクトが災害イベント root を作成するために信頼する署名済み finalized payload（被災セル Merkle root + BCS bytes）を生成します。

- **役割**: USGS 地震候補を検出し、TEE 内で検証して署名済み finalized payload を生成する。
- **信頼境界**: 署名済み TEE result が信頼境界。watcher / runner / relayer は payload を運ぶだけで、その意味を変更してはいけない。

## 詳細資料
- [../../../docs/verifiers/earthquake.md](../../../docs/verifiers/earthquake.md) — 完全な設計 / 仕様
- [../../../docs/verifiers/overview.md](../../../docs/verifiers/overview.md) — verifier 全体概要
