# Shared TEE

`shared-tee` は、Rust 製 TEE crate で共有する小さな utility crate です。

地震 verifier や membership verifier の domain logic はここに置きません。ここには、TEE 境界で繰り返し必要になる署名、hash、hex、seed、artifact の helper だけを置きます。

## 提供するもの

- SHA-256 hash helper。
- 32-byte hex parse / format helper。
- Ed25519 payload signer interface と local signer。
- signing seed の env / file 読み込み。
- dev fixture 用 signing seed。
- signature artifact の共通型。

## 使い方の方針

Domain-specific な payload の意味は、呼び出し側 crate が決めます。`shared-tee` は bytes を hash / sign するだけです。

本番 logic で dev signing seed に暗黙 fallback しないでください。fixture や local test では deterministic な seed を使えますが、production entrypoint では env または file から明示的に seed を渡します。

## 検証

```bash
cargo test --manifest-path nautilus/verifiers/shared-tee/Cargo.toml
```
