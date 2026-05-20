# Contracts MVP Smoke

This smoke sequence is the deploy-time dry run for the current contracts MVP. It intentionally uses only public or `AdminCap`-gated entry points and does not require raw personal data.

## Preconditions

- Package publish has produced the genesis `AdminCap`, `PauseState`, `MainPool`, `OperationsPool`, `DonorRegistry`, `MembershipRegistry`, and `VerifierRegistry`.
- The admin wallet controls `AdminCap`.
- Verifier public keys are available from environment-specific secret storage, not committed config.
- USDC coins are available for donor, member verification fee, and pool funding transactions.

## Object Setup

1. Create a Designated Pool for the earthquake campaign with `admin::create_designated_pool`.
2. Create a Disaster Relief `Program` with `program::create_program`.
3. Create a `Campaign` under that Program with an explicit claim window.
4. Create the default disaster `PayoutPolicy` with `payout_policy::create_default_disaster_policy`.
5. Create a `ClaimIndex` with `claim::create_claim_index`.
6. Create a `DisasterRegistry` with `disaster_event::create_disaster_registry`.
7. Add Residence and Disaster Oracle verifier keys through `admin::add_verifier_key`.
8. Open `CampaignBudget` after pool funding with `payout_policy::open_campaign_budget_from_designated_and_main`.

## Happy Path

1. Donor sends USDC through `accessor::donate_designated_usdc`.
   - Expected: `DonorPassIssued`, `DonationRecorded`, and split pool balances.
2. Recipient registers with `accessor::register_member_usdc`.
   - Expected: `MembershipPassIssued`; verification fee only increases `OperationsPool`.
3. Residence verifier submits `accessor::update_residence_metadata`.
   - Expected: `PassMetadataUpdated` with Residence metadata only.
4. Relayer submits Disaster Oracle v1 BCS bytes, signature, and public key through `disaster_event::create_from_signed_payload`.
   - Expected: `DisasterEventCreated`; duplicate `(event_uid, event_revision)` is rejected.
5. Admin binds the campaign to the created DisasterEvent with `disaster_event::bind_campaign`.
   - Expected: `DisasterCampaignBound`; unrelated campaigns or events cannot claim against this binding.
6. Recipient submits `accessor::claim_disaster_usdc` with the binding, `AffectedCellLeaf`, and Merkle proof.
   - Expected: `ClaimPaid`, `ClaimReceiptCreated`, owned `ClaimReceipt`, payout to `MembershipPass.payout_address`.
   - Expected funding order: Designated Pool budget first, Main Pool backstop second.

## Read Model Checks

- `pools::*_balance_usdc` and `*_total_received_usdc` expose pool balances.
- `membership::membership_record_summary` verifies current pass lineage, owner, payout address, and active status.
- `payout_policy::campaign_budget_claimed_usdc` and `campaign_budget_remaining_usdc` expose budget usage.
- `claim::claim_receipt_summary` exposes claim history without raw residence or identity data.
- `disaster_event::DisasterEventCreated` carries the root and count needed to link oracle output to claims.

## Required Local Verification

```bash
pnpm check:move
git diff --check
```

Run `pnpm check` as the broader repository gate when TypeScript or Rust files are changed, or before opening a release PR.
