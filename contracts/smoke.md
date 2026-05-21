# Contracts MVP Smoke

この smoke sequence は、現在の contracts MVP を deploy 時に dry run するための手順である。public API または `AdminCap` gated API だけを使い、raw 個人情報を必要としない。

## 前提条件

- package publish により genesis `AdminCap`、`PauseState`、`MainPool`、`OperationsPool`、`DonorRegistry`、`MembershipRegistry`、`VerifierRegistry` が作成済みである。
- admin wallet が `AdminCap` を保持している。
- verifier public key は環境別の secret storage から取得し、committed config には置かない。
- donor、member verification fee、pool funding transaction 用の USDC coin が利用可能である。

## Object Setup

1. 地震 campaign 用の Designated Pool を `admin::create_designated_pool` で作成する。
2. Disaster Relief `Program` を `admin::create_program` で作成する。
3. その Program 配下の `Campaign` を、明示的な claim window 付きで `admin::create_campaign` で作成する。
4. default disaster `PayoutPolicy` を `admin::create_default_disaster_policy` で作成する。
5. `ClaimIndex` を `admin::create_claim_index` で作成する。
6. `DisasterRegistry` を `admin::create_disaster_registry` で作成する。
7. Residence verifier key と Disaster Oracle verifier key を `admin::add_verifier_key` で登録する。
8. pool funding 後に `CampaignBudget` を `admin::open_campaign_budget_from_designated_and_main` で開く。

## Happy Path

1. donor が `accessor::donate_designated_usdc` で USDC を送る。
   - 期待値: `DonorPassIssued`、`DonationRecorded`、split 後の pool balance が記録される。
2. recipient が `accessor::register_member_usdc` で登録する。
   - 期待値: `MembershipPassIssued` が発火し、verification fee は `OperationsPool` だけを増やす。
3. Residence verifier が `accessor::update_residence_metadata` を提出する。
   - 期待値: Residence metadata のみを更新する `PassMetadataUpdated` が発火する。
4. relayer が `disaster_event::create_from_signed_payload` へ Disaster Oracle v1 BCS bytes、signature、public key を提出する。引数には `DisasterRegistry`、`VerifierRegistry`、Sui `Clock` を渡す。
   - 期待値: `DisasterEventCreated` が発火し、同じ `(event_uid, event_revision)` の再投稿は拒否される。
   - 認可条件: `AdminCap` は不要である。登録済み Disaster Oracle verifier signature と Clock-based freshness が認可境界であり、relayer は payload の意味を変更しない配送者として扱う。
5. admin が作成済み DisasterEvent と campaign を `admin::bind_disaster_campaign` で bind する。`DisasterRegistry` を渡し、campaign binding index を更新する。
   - 期待値: `DisasterCampaignBound` が発火する。無関係な campaign / event による claim は拒否され、同一 campaign の二重 binding も拒否される。
6. recipient が binding、`AffectedCellLeaf`、Merkle proof を渡して `accessor::claim_disaster_usdc` を提出する。
   - 期待値: `ClaimPaid`、`ClaimReceiptCreated`、owned `ClaimReceipt` が作成され、`MembershipPass.payout_address` へ支払われる。
   - 支払い順序: Designated Pool budget を先に使い、不足分を Main Pool backstop から支払う。
   - pause 期待値: global、Program、Campaign、Designated Pool、Main Pool のいずれかが paused の場合、duplicate claim index や budget claimed を更新する前に abort する。

## Read Model Checks

- `pools::*_balance_usdc` と `*_total_received_usdc` で pool balance を確認できる。
- `membership::membership_record_summary` で current pass lineage、owner、payout address、active status を確認できる。
- `payout_policy::campaign_budget_claimed_usdc` と `campaign_budget_remaining_usdc` で budget usage を確認できる。
- `claim::claim_receipt_summary` で raw residence / identity data を出さずに claim history を確認できる。
- `disaster_event::DisasterEventCreated` には oracle output と claim を結びつける root と count が含まれる。

## Required Local Verification

```bash
pnpm check:move
git diff --check
```

TypeScript または Rust を変更した場合、または release PR 前には、より広い repository gate として `pnpm check` も実行する。
