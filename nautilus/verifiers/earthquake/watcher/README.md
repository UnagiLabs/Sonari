# Earthquake Watcher

AWS Lambda-based watcher for the earthquake oracle. It polls the USGS recent feed, performs lightweight screening, manages DynamoDB state, starts the Step Functions runner workflow, and accepts manual submissions.

- **Role**: Candidate detection, offchain state management, and launching the runner workflow.
- **Trust boundary**: Watcher input is untrusted at the contract boundary; it screens and queues candidates but never determines finalization.

## Where to Read More
- [../../../../docs/verifiers/earthquake_watcher.md](../../../../docs/verifiers/earthquake_watcher.md) — full design / spec
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier system overview

---

# Earthquake Watcher（日本語）

地震オラクル用の AWS Lambda ベース watcher です。USGS recent feed を定期取得し、軽量 screening、DynamoDB 状態管理、Step Functions runner workflow の起動、手動投入を担当します。

- **役割**: 候補検出、オフチェーン状態管理、runner workflow の起動。
- **信頼境界**: watcher 入力は contract boundary では untrusted。候補を screening / queue するだけで finalization は決めない。

## 詳細資料
- [../../../../docs/verifiers/earthquake_watcher.md](../../../../docs/verifiers/earthquake_watcher.md) — 完全な設計 / 仕様
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier 全体概要
