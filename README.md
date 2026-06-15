<p align="center">
  <img src="dapp/public/assets/sonari_logo.png" alt="Sonari logo" width="260" />
</p>

# Sonari

**A transparent donation platform for verified aid on Sui.**

Sonari helps donations move to people who are eligible for support, while keeping both the money flow and the eligibility decision verifiable. Donors can see where funds are held. Recipients can see why they qualify. Sui Move contracts enforce the final rules, and Nautilus-backed verifiers turn real-world facts into signed results that the contracts can check.

The MVP focuses on earthquake relief:

1. Official earthquake data is verified inside a Nautilus TEE.
2. A verified disaster creates an on-chain relief campaign.
3. A recipient proves membership, residence, and identity.
4. Sui Move checks the signed disaster result, the identity result, the affected-area proof, duplicate-claim state, and pool balances before paying relief.

Sonari is **not insurance**. Donations do not guarantee payouts. Relief depends on pool balances, program rules, verification requirements, fraud controls, and claim timing.

## Why Sonari

After a disaster, material support such as food, water, blankets, and supplies can reach affected areas. But direct financial support to individual survivors is much harder to deliver at scale. The hard parts are not only payments. A program must decide who is affected, who is a real person, who already registered before the disaster, who has already claimed, and how to follow different legal and institutional rules across countries.

That complexity is why direct cash aid often depends on slow manual review, local intermediaries, or country-specific systems. It is difficult for people around the world to fund a transparent campaign and know that money can quickly reach verified individuals instead of disappearing into an opaque process.

Sonari uses Sui and Nautilus to make this possible:

- **Nautilus verifies real-world facts** such as official disaster data and identity proofs inside a TEE.
- **Sui Move enforces the rules** for funds, eligibility, duplicate claims, timing, and payouts.
- **Donors can support from anywhere** because the campaign and fund movement are visible on-chain.
- **Recipients can receive faster** because verification is programmatic instead of being only a manual, local process.

The result is a donation platform where global support can move directly to verified people under transparent rules.

## MVP

| Area | MVP behavior |
| --- | --- |
| Disaster source | USGS earthquake detail data and ShakeMap data |
| Disaster verification | Nautilus TEE re-fetches source data, computes affected H3 cells, signs a finalized payload |
| Identity route | World ID is the live MVP route |
| Planned identity providers | KYC, student ID, university account, and similar provider checks can be added later |
| Chain | Sui Move contracts hold funds, verify signed results, and enforce claim rules |
| Currency | USDC |
| Aid model | Two-stage relief: immediate floor payout and later pro-rata campaign payout |

## Extension Direction

The earthquake MVP is the first use case, not the limit of the design.

**Other disasters.** Sonari can extend to floods, typhoons, tsunami, wildfire, evacuation orders, or other public emergencies when an official source policy is defined. Each new disaster type needs clear source data, payload meaning, fixtures, verifier logic, and Move checks. The key rule stays the same: the official data is re-fetched and verified inside Nautilus, then Sui accepts only the signed result.

**Student and community support.** The same pattern can support non-disaster programs. A verifier can check a student ID, university email, university SSO account, enrollment API, or other eligibility proof, then produce a signed result for Sui. The contract can then route donations to student support, scholarships, tuition assistance, emergency grants, or other community aid programs without storing raw personal data on-chain.

## How It Works

![Sonari system overview](docs/assets/Sonari_Overview.svg)

1. **Donors fund pools.** Donations are split by the contract into campaign, category, main support, and operations pools.
2. **Nautilus verifies facts.** External facts such as earthquake data or identity proof are checked inside a TEE and signed.
3. **Sui verifies the signed results.** Move contracts verify the enclave key, signature, payload bytes, status, and proof roots.
4. **Recipients claim relief.** A valid claim combines identity, membership, residence timing, affected-area proof, and duplicate-claim protection.
5. **Receipts make the flow inspectable.** Donations, payouts, and claim receipts connect funds to the campaign and verification results.

## Details

| Document | Purpose |
| --- | --- |
| [Disaster Oracle](docs/disaster_oracle.md) | How official disaster information becomes a signed Sui result |
| [Identity Verification](docs/identity_verification.md) | How World ID works today, and how KYC / student credentials can be added |
| [Donation Flow](docs/donation_flow.md) | How money moves, how payouts are calculated, and why payouts are not first-come-first-served |
| [Technical Architecture](docs/technical_architecture.md) | How the dapp, Nautilus, relayers, storage, and Sui contracts fit together |

Additional technical references are available in [`docs/verifiers/`](docs/verifiers/), [`docs/internal/contracts_spec.md`](docs/internal/contracts_spec.md), and [`schemas/`](schemas/).

---

# Sonari（日本語）

**Sui 上で、寄付資金と受給資格を検証可能にする寄付プラットフォーム。**

Sonari は、寄付されたお金がどこにあり、誰がなぜ支援を受け取れるのかを検証可能にする仕組みです。資金の流れは Sui Move コントラクトが管理し、現実世界の事実は Nautilus を使った verifier が TEE 内で検証して署名します。

MVP は地震支援に絞っています。

1. 公式地震データを Nautilus TEE 内で検証する。
2. 検証済み災害から on-chain の支援 Campaign を作る。
3. 受給者は membership、居住地域、本人確認を示す。
4. Sui Move が署名済み災害結果、本人確認結果、被災地域 proof、重複 claim、Pool 残高を検証してから支払う。

Sonari は **保険ではありません**。寄付は保証された支払いを生みません。支援は Pool 残高、プログラムルール、検証要件、不正対策、申請タイミングに依存します。

## なぜ Sonari か

災害が起きると、食料・水・毛布・物資のような物的支援は被災地に届きます。一方で、被災者個人へ直接お金が届く支援を大規模に行うことは、まだとても難しいのが現状です。難しいのは送金だけではありません。誰が被災者か、誰が実在する本人か、災害前に登録していたか、すでに受け取っていないか、そして国ごとに異なる法律や制度にどう合わせるかを判断する必要があります。

そのため、直接的な cash aid は、遅い手作業の審査、地域の中間組織、国ごとの閉じた仕組みに依存しがちです。世界中の人が透明な Campaign に寄付し、そのお金が検証済みの個人へすばやく届く仕組みは、まだ実現しにくい領域です。

Sonari は、この課題を Sui と Nautilus で解決します。

- **Nautilus が現実世界の事実を検証する。** 公式災害情報や本人確認 proof を TEE 内で確認します。
- **Sui Move がルールを強制する。** 資金、受給資格、重複 claim、時刻、支払額をコントラクトで検証します。
- **寄付者は世界中から支援できる。** Campaign と資金移動は on-chain で見えるため、透明性があります。
- **受給者はより早く受け取れる。** 検証がプログラムされた仕組みで行われ、手作業や地域限定の処理だけに依存しません。

Sonari は、世界中からの支援を、透明なルールのもとで検証済みの個人へ直接届ける寄付プラットフォームです。

## MVP

| 領域 | MVP の内容 |
| --- | --- |
| 災害 source | USGS earthquake detail data と ShakeMap data |
| 災害検証 | Nautilus TEE が source data を再取得し、被災 H3 cell を計算し、finalized payload に署名 |
| 本人確認 | World ID が MVP の live route |
| 将来 provider | KYC、学生証、大学アカウントなどを後から追加可能 |
| Chain | Sui Move が資金を保持し、署名済み結果を検証し、claim rules を強制 |
| 通貨 | USDC |
| 支援モデル | 即時の床払いと、後日の Campaign 按分払いの2段階 |

## 今後の拡張

地震 MVP は最初のユースケースであり、設計の上限ではありません。

**他の災害。** 公式 source policy を定義すれば、洪水、台風、津波、火災、避難情報などにも拡張できます。新しい災害種別ごとに、source data、payload の意味、fixture、verifier logic、Move checks を定義します。基本は同じです。公式情報を Nautilus 内で再取得・検証し、Sui は署名済み結果だけを受け入れます。

**学生・コミュニティ支援。** 同じ仕組みは災害以外にも使えます。学生証、大学メール、大学 SSO、在学証明 API などを verifier provider として追加すれば、学生支援、奨学金型支援、授業料補助、緊急給付などに応用できます。raw personal data を on-chain に保存せず、検証済み result だけを使う設計です。

## 仕組み

![Sonari system overview](docs/assets/Sonari_Overview.svg)

1. **寄付者が Pool に資金を入れる。** コントラクトが寄付を Campaign、Category、Main support、Operations Pool に分割します。
2. **Nautilus が事実を検証する。** 地震データや本人確認 proof などの外部事実を TEE 内で確認し、署名します。
3. **Sui が署名済み結果を検証する。** Move が enclave key、signature、payload bytes、status、proof root を検証します。
4. **受給者が claim する。** 有効な claim には identity、membership、居住登録時刻、被災地域 proof、重複 claim 防止が必要です。
5. **receipt で追跡できる。** 寄付、支払い、claim receipt が Campaign と検証結果に結び付きます。

## 詳細資料

| Document | Purpose |
| --- | --- |
| [Disaster Oracle](docs/disaster_oracle.md) | 公式災害情報を署名済み Sui result にする仕組み |
| [Identity Verification](docs/identity_verification.md) | World ID の現状と、KYC / 学生 credential への拡張 |
| [Donation Flow](docs/donation_flow.md) | お金の流れ、計算式、早い者勝ちにならない理由 |
| [Technical Architecture](docs/technical_architecture.md) | dapp、Nautilus、relayer、storage、Sui contract の全体像 |

追加の技術資料は [`docs/verifiers/`](docs/verifiers/)、[`docs/internal/contracts_spec.md`](docs/internal/contracts_spec.md)、[`schemas/`](schemas/) にあります。
