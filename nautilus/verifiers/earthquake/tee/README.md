# Earthquake TEE Core

The Rust verification core that runs inside the Nautilus / Nitro Enclave. It parses USGS / ShakeMap data, computes affected H3 cells, builds the Merkle tree, serializes the BCS payload, and Ed25519-signs the finalized result.

- **Role**: Deterministic, auditable verification engine that turns USGS / ShakeMap source data into a signed finalized payload.
- **Trust boundary**: Source re-fetch, verification, normalization, Merkle root, BCS payload, and signing all happen inside the TEE; signing keys never leave the enclave.

## Where to Read More
- [../../../../docs/verifiers/earthquake_tee.md](../../../../docs/verifiers/earthquake_tee.md) — full design / spec
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier system overview

---

# Earthquake TEE Core（日本語）

Nautilus / Nitro Enclave 内で動く Rust 製の検証コアです。USGS / ShakeMap データを解析し、被災 H3 セルを計算し、Merkle ツリーを構築し、BCS payload をシリアライズして finalized result を Ed25519 署名します。

- **役割**: USGS / ShakeMap source data を署名済み finalized payload に変換する、決定的で監査しやすい検証エンジン。
- **信頼境界**: source 再取得、検証、正規化、Merkle root、BCS payload、署名はすべて TEE 内で行い、署名鍵は enclave 外へ出さない。

## 詳細資料
- [../../../../docs/verifiers/earthquake_tee.md](../../../../docs/verifiers/earthquake_tee.md) — 完全な設計 / 仕様
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier 全体概要
