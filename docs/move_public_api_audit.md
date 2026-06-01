# Move public API audit

Issue #105 Step 4 final public-function allowlist. Production `public fun`
entry points are intentionally concentrated in `contracts::accessor` for
user, relayer, proof-construction, and read APIs, and `contracts::admin` for
AdminCap-gated setup/configuration APIs and admin-facing constants/read helpers.

`#[test_only] public fun` declarations are excluded from the production API.
Domain modules may still expose `public(package)` functions for internal
composition and tests in this package, but those are not external entry points.

## Accessor public

External user, relayer, proof-construction, and read APIs enter through
`contracts::accessor`:

- Donations: `donate_general_usdc`, `donate_general_usdc_with_pass`,
  `donate_designated_usdc`, `donate_designated_usdc_with_pass`,
  `donate_operations_usdc`, `donate_operations_usdc_with_pass`.
- Membership and identity user flows: `register_member`,
  `new_residence_proof_step_left`, `new_residence_proof_step_right`,
  `update_member_home_cell`, `update_identity_verification`.
- Disaster relayer and claim flows: `create_disaster_event_from_signed_payload`,
  `new_affected_cell_leaf`, `new_affected_cell_proof_step_left`,
  `new_affected_cell_proof_step_right`, `claim_disaster_usdc`.
- Donation reads: `donor_pass_tier_label`, `donation_record_summary`,
  `donor_registry_id`, `registry_kind_donor`.
- Membership reads: `membership_registry_id`, `registry_kind_membership`,
  `target_kind_membership_registry`, `membership_registry_issued_count`,
  `membership_owner_lineage_id`, `membership_record_summary`,
  `membership_pass_owner`, `membership_pass_lineage_id`,
  `membership_pass_status`, `membership_pass_issued_at_ms`,
  `membership_pass_display_labels`, `membership_pass_mvp_summary`,
  `membership_status_active`, `membership_status_suspended`,
  `membership_status_revoked`, `membership_status_migrated`.
- Identity reads/constants: `identity_registry_id`, `registry_kind_identity`,
  `identity_provider_kyc`, `identity_provider_world_id`.
- Claim and payout reads: `claim_index_claim_count`, `claim_receipt_summary`,
  `claim_receipt_tier_label`, `quote_usdc`, `main_backstop_budget_usdc`,
  `future_reserve_floor_usdc`, `liquid_reserve_target_usdc`,
  `campaign_budget_claimed_usdc`, `campaign_budget_remaining_usdc`,
  `main_remaining_usdc`, `designated_remaining_usdc`, `policy_id`,
  `min_claim_band`.
- Program/campaign reads: `program_id`, `campaign_id`,
  `program_required_pass_metadata`, `program_required_verifier_family`,
  `program_payout_policy_id`, `campaign_claim_start_ms`,
  `campaign_claim_end_ms`, `program_status_active`,
  `program_status_inactive`, `program_status_closed`.
- Disaster event and affected-cell reads/proofs: `affected_cells_root`,
  `disaster_event_uid`, `disaster_event_revision`, `occurred_at_ms`,
  `disaster_registry_event_count`, `disaster_event_id`,
  `affected_cell_leaf_hash`, `verify_affected_cell_proof`,
  `affected_cell_h3_index`, `affected_cell_band`,
  `affected_cell_event_uid`, `affected_cell_event_revision`.

`create_disaster_event_from_signed_payload` intentionally has no `PauseState`
argument and performs no pause checks; this preserves current relayer behavior.

## Admin public

AdminCap-gated production entry points and admin-facing constants/read helpers
remain in `contracts::admin`, not `accessor`:

- Setup/configuration: `create_designated_pool`, `create_program`,
  `create_campaign`, `create_default_disaster_policy`,
  `create_disaster_registry`, `bind_disaster_campaign`,
  `open_campaign_budget_from_main`,
  `open_campaign_budget_from_designated_and_main`, `add_verifier_key`,
  `disable_verifier_key`, `create_allowed_residence_cell_registry`,
  `update_allowed_residence_cell_root`.
- Pause operations and reads: `pause_global`, `unpause_global`,
  `pause_target`, `unpause_target`, `is_global_paused`, `is_target_paused`,
  `paused_target_count`, `scope_global`, `scope_target`, `target_kind_none`.
- Admin target constants: `target_kind_program`, `target_kind_campaign`,
  `target_kind_identity_registry`, `target_kind_verifier_registry`.
- Verifier admin constants/reads: `verifier_registry_id`,
  `registry_kind_verifier`, `verifier_family_earthquake_oracle`,
  `verifier_family_identity`, `verifier_version_v1`.
- Genesis event constants: `genesis_kind_admin_cap`,
  `genesis_kind_pause_state`, `genesis_kind_main_pool`,
  `genesis_kind_operations_pool`, `genesis_kind_donor_registry`,
  `genesis_kind_membership_registry`, `genesis_kind_verifier_registry`,
  `genesis_kind_claim_index`, `genesis_kind_identity_registry`.

## Package-internal

The payload and identity-result decoders and field getters are
`public(package)` because they are contract-internal BCS contracts, not
external API:

- `payload`: `decode_finalized`, `payload_summary`, all payload field getters,
  and payload enum/constant getters.
- `identity_result_v1`: `decode_verified`, `identity_result_summary`, field
  getters, and provider constants.

Other internal helpers narrowed in Step 4:

- `disaster_event::assert_campaign_binding`.
- `membership::assert_current_pass_precheck`.
- `membership::duplicate_claim_key`.
- `identity_registry`: registry/provider/target getters now feed
  `accessor` or `admin` wrappers.
- `metadata_verifier`: registry/verifier getters now feed `admin` wrappers.
- `program`: program/campaign getters and status/target constants now feed
  `accessor` or `admin` wrappers.

## Remaining production public outside accessor/admin

None. The only `public fun` declarations outside `accessor` and `admin` are
marked `#[test_only]` test helpers.
