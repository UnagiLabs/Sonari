# Move public API audit

Issue #105 Step 3 inventory. Scope is `contracts/sources` after moving
external/user/UI read getters behind `contracts::accessor` and keeping
AdminCap-gated operations in `contracts::admin`.

## Accessor public

External user, relayer, and proof-construction API should enter through
`contracts::accessor`:

- `accessor`: `donate_general_usdc`, `donate_general_usdc_with_pass`,
  `donate_designated_usdc`, `donate_designated_usdc_with_pass`,
  `donate_operations_usdc`, `donate_operations_usdc_with_pass`,
  `register_member`, `new_residence_proof_step_left`,
  `new_residence_proof_step_right`, `update_member_home_cell`,
  `update_identity_verification`, `create_disaster_event_from_signed_payload`,
  `new_affected_cell_leaf`, `new_affected_cell_proof_step_left`,
  `new_affected_cell_proof_step_right`, `claim_disaster_usdc`,
  `donor_pass_tier_label`, `donation_record_summary`, `donor_registry_id`,
  `registry_kind_donor`, `membership_registry_id`,
  `registry_kind_membership`, `target_kind_membership_registry`,
  `membership_registry_issued_count`, `membership_owner_lineage_id`,
  `membership_record_summary`, `membership_pass_owner`,
  `membership_pass_lineage_id`, `membership_pass_status`,
  `membership_pass_issued_at_ms`, `membership_pass_display_labels`,
  `membership_pass_mvp_summary`, `membership_status_active`, `membership_status_suspended`,
  `membership_status_revoked`, `membership_status_migrated`, `claim_index_claim_count`,
  `claim_receipt_summary`, `claim_receipt_tier_label`, `quote_usdc`,
  `main_backstop_budget_usdc`, `future_reserve_floor_usdc`,
  `liquid_reserve_target_usdc`, `campaign_budget_claimed_usdc`,
  `campaign_budget_remaining_usdc`, `main_remaining_usdc`,
  `designated_remaining_usdc`, `policy_id`, `min_claim_band`,
  `affected_cells_root`, `disaster_event_uid`,
  `disaster_event_revision`, `occurred_at_ms`,
  `disaster_registry_event_count`, `disaster_event_id`,
  `affected_cell_leaf_hash`, `verify_affected_cell_proof`,
  `affected_cell_h3_index`, `affected_cell_band`,
  `affected_cell_event_uid`, `affected_cell_event_revision`.

`create_disaster_event_from_signed_payload` intentionally has no `PauseState`
argument and performs no pause checks; this preserves current relayer behavior.

## Package-internal

Production functions classified as `public(package)` are internal contract
building blocks. They should not be external transaction targets:

- `affected_cell`: `new_leaf`, `new_proof_step_left`,
  `new_proof_step_right`, `leaf_hash`, `verify_proof`, `h3_index`,
  `cell_band`, `event_uid`, `event_revision`.
- `allowed_residence_cell`: `create_registry`, `update_root`,
  `new_proof_step_left`, `new_proof_step_right`, `is_valid_home_cell`.
- `claim`: `create_claim_index`, `claim_usdc`, `claim_disaster_usdc`,
  `claim_index_claim_count`, `claim_receipt_summary`,
  `claim_receipt_tier_label`.
- `disaster_event`: `create_disaster_registry`,
  `create_from_signed_payload`, `bind_campaign`, `affected_cells_root`,
  `event_uid`, `event_revision`, `occurred_at_ms`,
  `disaster_registry_event_count`, `disaster_event_id`.
- `donation`: `create_donor_registry`, `donate_general_usdc`,
  `donate_general_usdc_with_pass`, `donate_designated_usdc`,
  `donate_designated_usdc_with_pass`, `donate_operations_usdc`,
  `donate_operations_usdc_with_pass`, `donation_record_summary`,
  `donor_pass_owner`, `donor_pass_total_donated_usdc`,
  `donor_pass_donation_count`, `donor_pass_tier`,
  `donor_pass_tier_label`, `registry_id`, `registry_kind_donor`,
  `donation_type_general`, `donation_type_designated`,
  `donation_type_operations`, `tier_none`, `tier_bronze`, `tier_silver`,
  `tier_gold`, `bronze_threshold_usdc`, `silver_threshold_usdc`,
  `gold_threshold_usdc`, `coin_type_usdc`.
- `identity_registry`: `create_identity_registry`, `bind_duplicate_key`,
  `assert_duplicate_key_bound_to_pass`, `apply_identity_verification_result`.
- `identity_result_v1`: `registry_id`, `membership_id`, `owner`,
  `provider`, `duplicate_key_hash`, `expires_at_ms`, `terms_version`,
  `signed_statement_hash`.
- `membership`: `register_member`, `update_home_cell`,
  `create_membership_registry`, `apply_identity_verification`,
  `registry_id`, `registry_kind_membership`,
  `target_kind_membership_registry`, `membership_registry_issued_count`,
  `membership_owner_lineage_id`, `membership_record_summary`,
  `membership_pass_owner`, `membership_pass_lineage_id`,
  `membership_pass_status`, `membership_pass_issued_at_ms`,
  `membership_pass_display_labels`, `membership_pass_mvp_summary`,
  `status_active`, `status_suspended`, `status_revoked`, `status_migrated`.
- `metadata_verifier`: `create_verifier_registry`, `add_verifier_key`,
  `disable_verifier_key`, `assert_signed_bytes`.
- `payout_policy`: `create_default_disaster_policy`,
  `open_campaign_budget_from_main`,
  `open_campaign_budget_from_designated_and_main`, `assert_budget_matches`,
  `assert_designated_pool_matches`, `record_claim`, `quote_usdc`,
  `main_backstop_budget_usdc`, `future_reserve_floor_usdc`,
  `liquid_reserve_target_usdc`, `campaign_budget_claimed_usdc`,
  `campaign_budget_remaining_usdc`, `main_remaining_usdc`,
  `designated_remaining_usdc`, `policy_id`, `min_claim_band`.
- `pools`: `create_main_pool`, `create_designated_pool`,
  `create_operations_pool`, `deposit_main_usdc`, `deposit_designated_usdc`,
  `deposit_operations_usdc`, `withdraw_main_usdc`,
  `withdraw_designated_usdc`, `main_pool_id`, `designated_pool_id`,
  `operations_pool_id`, `main_pool_balance_usdc`,
  `main_pool_total_received_usdc`, `designated_pool_balance_usdc`,
  `designated_pool_total_received_usdc`, `operations_pool_balance_usdc`,
  `operations_pool_total_received_usdc`, `pool_kind_main`,
  `pool_kind_designated`, `pool_kind_operations`, `target_kind_main_pool`,
  `target_kind_designated_pool`, `target_kind_operations_pool`.
- `program`: `create_program`, `create_campaign`, `assert_claim_precheck`,
  `assert_claim_window`,
  `assert_budget_not_opened_and_mark`, `assert_campaign_program_match`,
  `assert_payout_policy_matches`, `assert_no_effective_designated_pool`,
  `assert_effective_designated_pool_matches`.
- `admin`: `assert_claim_precheck`, `assert_not_globally_paused`,
  `assert_target_not_paused`.

## Admin public

AdminCap-gated production `public fun` declarations remain in `admin`, not
`accessor`, so external admin/config/status transactions enter through the
admin module and preserve existing admin-cap checks:

- `admin`: `create_designated_pool`, `create_program`, `create_campaign`,
  `create_default_disaster_policy`, `create_disaster_registry`,
  `bind_disaster_campaign`, `open_campaign_budget_from_main`,
  `open_campaign_budget_from_designated_and_main`, `add_verifier_key`,
  `disable_verifier_key`,
  `create_allowed_residence_cell_registry`,
  `update_allowed_residence_cell_root`, `pause_global`, `unpause_global`,
  `pause_target`, `unpause_target`.

## Public retained for future steps

These are production `public fun` declarations outside `accessor`. They remain
public after Step 3 as non-admin read accessors, constants, or externally useful
helpers. Later steps can decide whether to keep them module-public, move them
behind dedicated view modules, or narrow them.

- `admin`: `is_global_paused`, `is_target_paused`, `paused_target_count`,
  `scope_global`, `scope_target`, `target_kind_none`, `genesis_kind_admin_cap`,
  `genesis_kind_pause_state`, `genesis_kind_main_pool`,
  `genesis_kind_operations_pool`, `genesis_kind_donor_registry`,
  `genesis_kind_membership_registry`, `genesis_kind_verifier_registry`,
  `genesis_kind_claim_index`, `genesis_kind_identity_registry`.
- `disaster_event`: `assert_campaign_binding`.
- `identity_registry`: `registry_id`, `registry_kind_identity`,
  `target_kind_identity_registry`, `provider_kyc`, `provider_world_id`.
- `identity_result_v1`: `decode_verified`, `identity_result_summary`,
  `provider_kyc`, `provider_world_id`.
- `membership`: `assert_current_pass_precheck`, `duplicate_claim_key`.
- `metadata_verifier`: `registry_id`, `registry_kind_verifier`,
  `verifier_family_earthquake_oracle`, `verifier_family_identity`,
  `verifier_version_v1`, `target_kind_verifier_registry`.
- `payload`: `decode_finalized`, `payload_summary`, `event_uid`,
  `event_revision`, `hazard_type`, `oracle_version`, `source_event_id`,
  `title`, `region`, `magnitude_x100`, `verified_at_ms`,
  `source_updated_at_ms`, `primary_source`, `source_set_hash`,
  `raw_data_hash`, `raw_data_uri`, `affected_cells_root`,
  `affected_cells_uri`, `affected_cells_data_hash`, `affected_cell_count`,
  `occurred_at_ms`, `freshness_deadline_ms`,
  `intent_earthquake_oracle_payload`, `hazard_type_earthquake`,
  `status_finalized`.
- `program`: `id`, `campaign_id`, `required_pass_metadata`,
  `required_verifier_family`, `payout_policy_id`,
  `campaign_claim_start_ms`, `campaign_claim_end_ms`, `status_active`,
  `status_inactive`, `status_closed`, `target_kind_program`,
  `target_kind_campaign`.

## Private

No production `public fun` is reclassified to private in Step 3. Existing
private helpers remain private within their modules.

## Test-only

`#[test_only] public fun` declarations are excluded from the production API.
They remain test helpers for event field extraction, fixture object creation,
state mutation, and negative-path setup in:

- `admin`, `allowed_residence_cell`, `claim`, `disaster_event`, `donation`,
  `identity_registry`, `membership`, `metadata_verifier`, `payout_policy`,
  `pools`, `program`.
