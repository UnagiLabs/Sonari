# Technical Architecture

This document explains how the Sonari dapp, Nautilus verifiers, storage services, relayers, and Sui Move contracts work together.

![Sonari technical system flow](assets/Sonari_SystemFlow_en.svg)

## 1. How To Read The Diagram

Sonari has five kinds of components:

| Component | Role | Trust level |
| --- | --- | --- |
| dapp / frontend | User interface for donation, membership, verification, and claims | Not trusted for final decisions |
| watcher / runner / relayer | Finds candidates, starts verifier jobs, delivers signed bytes | Not trusted for meaning |
| Nautilus TEE | Re-fetches external data, verifies it, normalizes it, signs result bytes | Trusted only through attestation and registered keys |
| storage / proof workers | Stores artifacts and serves Merkle proofs | Not trusted without hash/root checks |
| Sui Move contracts | Hold funds and re-check signatures, payloads, proofs, ownership, timing, and balances | Final public enforcement boundary |

The most important point is that delivery systems can move data, but they cannot decide truth. The TEE signs verified results, and Sui verifies those results before updating state or moving money.

## 2. Disaster Path

The disaster path starts with official source data and ends with an on-chain `DisasterEvent` and `Campaign`.

1. A watcher finds a candidate official disaster event.
2. A runner starts a Nautilus TEE job.
3. The TEE re-fetches source data, verifies it, computes affected cells, and signs a finalized payload.
4. Artifacts such as source manifests and affected-cell files are stored with hash/root commitments.
5. A relayer submits the signed bytes to Sui.
6. Sui verifies the enclave registration, signature, payload fields, status, freshness, and affected-cells root.
7. If the payload is valid and claimable, a `DisasterEvent` and `Campaign` are created.

For the MVP, this path uses USGS and ShakeMap data for earthquakes. Other official disaster sources can be added by defining source policy, payload semantics, fixtures, verifier logic, and Move checks.

## 3. Identity Path

The identity path binds an external proof to a Membership SBT without exposing raw personal data.

1. A user owns or creates a Membership SBT.
2. The dapp collects a provider proof, World ID in the MVP.
3. A runner starts the membership identity verifier.
4. The Nautilus TEE checks the provider proof and signs a minimal identity result.
5. A relayer delivers the signed result.
6. Sui verifies the enclave key, signature, owner, membership id, provider, duplicate key hash, and expiry.
7. The membership identity state is updated if the result is valid.

KYC, student ID, university account, and enrollment checks can use the same pattern later. The provider changes, but the trust boundary remains the same.

## 4. Claim And Money Path

The claim path is where technical verification turns into money movement.

1. A donor funds a Campaign, Category, or Main Pool.
2. The contract splits the donation immediately and emits events.
3. A verified disaster provides the affected-cells root.
4. A verified identity result proves the claimant is eligible under an identity provider.
5. The claimant submits a Merkle proof for their registered home cell.
6. Move checks membership owner, residence timing, affected-cell proof, identity expiry, duplicate-claim state, campaign windows, pool balances, and pause/version guards.
7. If all checks pass, the contract pays either floor payout or campaign payout and records the receipt.

The frontend, proof worker, and relayer can help the user assemble inputs, but the contract verifies the security-critical parts again.

## 5. Trust Boundaries

Sonari intentionally separates responsibilities.

| Boundary | Rule |
| --- | --- |
| External services | Treated as source data, not as direct contract authority |
| Runner / relayer | Can start and deliver work, but cannot alter signed bytes |
| Nautilus TEE | Signs only verified results, with keys tied to attestation |
| Storage | Provides artifacts and proofs, but hashes and Merkle roots must match |
| Sui Move | Final verifier and fund controller |

Failure should be fail-closed. If a signature is wrong, a key is unknown, a proof does not match, a payload is malformed, or a result is expired, the transaction stops instead of writing a false result or moving funds.

## 6. Related Documents

For additional details:

- [Disaster Oracle](disaster_oracle.md)
- [Identity Verification](identity_verification.md)
- [Donation Flow](donation_flow.md)
- [Verifier overview](verifiers/overview.md)
- [Earthquake verifier](verifiers/earthquake.md)
- [Identity verifier](verifiers/identity.md)
- [Contracts specification](internal/contracts_spec.md)
- [`schemas/`](../schemas/)

---

# 技術アーキテクチャ（日本語）

この文書は、Sonari の dapp、Nautilus verifier、storage service、relayer、Sui Move contract がどのようにつながるかを説明します。

![Sonari technical system flow](assets/Sonari_SystemFlow_en.svg)

## 1. 図の読み方

Sonari には5種類の component があります。

| Component | 役割 | Trust level |
| --- | --- | --- |
| dapp / frontend | donation、membership、verification、claim の UI | 最終判断では信頼しない |
| watcher / runner / relayer | candidate 検出、verifier job 起動、signed bytes 配送 | 意味の判断では信頼しない |
| Nautilus TEE | external data を再取得し、検証・正規化・署名する | attestation と登録済み key を通じてのみ信頼 |
| storage / proof workers | artifact 保存と Merkle proof 配布 | hash/root check なしでは信頼しない |
| Sui Move contracts | 資金を保持し、signature、payload、proof、ownership、timing、balance を再検証 | 最終的な公開 enforcement boundary |

最も重要なのは、配送システムはデータを運べても、真実を決められないことです。TEE が検証済み result に署名し、Sui が state 更新や資金移動の前にそれを検証します。

## 2. Disaster Path

disaster path は公式 source data から始まり、on-chain の `DisasterEvent` と `Campaign` で終わります。

1. watcher が公式災害 event candidate を見つける。
2. runner が Nautilus TEE job を開始する。
3. TEE が source data を再取得し、検証し、affected cells を計算し、finalized payload に署名する。
4. source manifest や affected-cell file などの artifacts を hash/root commitment 付きで保存する。
5. relayer が signed bytes を Sui に submit する。
6. Sui が enclave registration、signature、payload fields、status、freshness、affected-cells root を検証する。
7. payload が valid かつ claimable なら、`DisasterEvent` と `Campaign` が作成される。

MVP では、この path は USGS と ShakeMap の地震データを使います。他の公式災害 source は、source policy、payload semantics、fixtures、verifier logic、Move checks を定義して追加できます。

## 3. Identity Path

identity path は、raw personal data を公開せずに external proof を Membership SBT に結び付けます。

1. user が Membership SBT を所有または作成する。
2. dapp が provider proof を集める。MVP では World ID。
3. runner が membership identity verifier を開始する。
4. Nautilus TEE が provider proof を検証し、最小限の identity result に署名する。
5. relayer が signed result を配送する。
6. Sui が enclave key、signature、owner、membership id、provider、duplicate key hash、expiry を検証する。
7. result が valid なら membership identity state が更新される。

KYC、学生証、大学アカウント、在学確認も将来同じ pattern を使えます。provider は変わりますが、trust boundary は同じです。

## 4. Claim And Money Path

claim path は、技術的な検証が資金移動に変わる場所です。

1. donor が Campaign、Category、Main Pool に寄付する。
2. contract が寄付を即時分割し、event を出す。
3. verified disaster が affected-cells root を提供する。
4. verified identity result が claimant の identity provider eligibility を証明する。
5. claimant が登録済み home cell の Merkle proof を提出する。
6. Move が membership owner、residence timing、affected-cell proof、identity expiry、duplicate-claim state、campaign windows、pool balances、pause/version guards を検証する。
7. すべて通れば、contract が floor payout または campaign payout を支払い、receipt を記録する。

frontend、proof worker、relayer は user が inputs を組み立てるのを助けられますが、security-critical な部分は contract が再検証します。

## 5. Trust Boundaries

Sonari は責務を意図的に分けています。

| Boundary | Rule |
| --- | --- |
| External services | source data として扱い、contract authority としては扱わない |
| Runner / relayer | work の開始と配送はできるが、signed bytes は変更できない |
| Nautilus TEE | attestation に紐付く key で、検証済み result だけに署名する |
| Storage | artifacts と proofs を提供するが、hash と Merkle root が一致する必要がある |
| Sui Move | 最終 verifier かつ fund controller |

失敗時は fail-closed です。signature が不正、key が未知、proof が root と合わない、payload が malformed、result が expired の場合、誤った result を書いたり資金を動かしたりせず、transaction を止めます。

## 6. 関連資料

補足資料:

- [Disaster Oracle](disaster_oracle.md)
- [Identity Verification](identity_verification.md)
- [Donation Flow](donation_flow.md)
- [Verifier overview](verifiers/overview.md)
- [Earthquake verifier](verifiers/earthquake.md)
- [Identity verifier](verifiers/identity.md)
- [Contracts specification](internal/contracts_spec.md)
- [`schemas/`](../schemas/)
