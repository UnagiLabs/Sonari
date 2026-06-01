# Move public API audit

Issue #105 public-function allowlist after trimming unnecessary wrappers.
Production `public fun` entry points are intentionally concentrated by role:

- `contracts::accessor`: user and relayer entry points that perform state
  transitions or construct transaction arguments.
- `contracts::admin`: AdminCap-gated setup/configuration/pause operations.
- `contracts::reader`: read-only wrappers and constants that external clients
  may need to build transactions or decode events.

`#[test_only] public fun` declarations are excluded from the production API.
Domain modules may still expose `public(package)` functions for internal
composition and package tests, but those are not external entry points.

## Accessor public

`contracts::accessor` contains operational entry points only:

- Donations: `donate_general_usdc`, `donate_general_usdc_with_pass`,
  `donate_designated_usdc`, `donate_designated_usdc_with_pass`,
  `donate_operations_usdc`, `donate_operations_usdc_with_pass`.
- Membership and identity flows: `register_member`,
  `new_residence_proof_step_left`, `new_residence_proof_step_right`,
  `update_member_home_cell`, `update_identity_verification`.
- Disaster relayer and claim flows: `create_disaster_event_from_signed_payload`,
  `new_affected_cell_leaf`, `new_affected_cell_proof_step_left`,
  `new_affected_cell_proof_step_right`, `claim_disaster_usdc`.

`create_disaster_event_from_signed_payload` intentionally has no `PauseState`
argument and performs no pause checks; this preserves current relayer behavior.

## Admin public

`contracts::admin` contains AdminCap-gated production entry points:

- Setup/configuration: `create_designated_pool`, `create_program`,
  `create_campaign`, `create_default_disaster_policy`,
  `create_disaster_registry`, `bind_disaster_campaign`,
  `open_campaign_budget_from_main`,
  `open_campaign_budget_from_designated_and_main`, `add_verifier_key`,
  `disable_verifier_key`, `create_allowed_residence_cell_registry`,
  `update_allowed_residence_cell_root`.
- Pause operations: `pause_global`, `unpause_global`, `pause_target`,
  `unpause_target`.

Read-only pause helpers and constants are intentionally not public from
`admin`; `reader` exposes the small external read surface.

## Reader public

`contracts::reader` is the only public module for read-only wrappers. It is
kept small so frontend-specific reads can be added intentionally later:

- Donation read needed by existing tests and donor-pass clients:
  `donation_record_summary`.
- Claim input constants: `identity_provider_kyc`, `identity_provider_world_id`.
- Pause target constants needed to build admin pause transactions:
  `target_kind_program`, `target_kind_campaign`,
  `target_kind_membership_registry`, `target_kind_identity_registry`,
  `target_kind_verifier_registry`, `target_kind_main_pool`,
  `target_kind_designated_pool`, `target_kind_operations_pool`.
- Verifier constants needed to register keys and construct signed payloads:
  `verifier_family_earthquake_oracle`, `verifier_family_identity`,
  `verifier_version_v1`.
## Package-internal

Payload and identity-result decoders and field getters remain
`public(package)` because they are contract-internal BCS contracts, not
external APIs.

Domain object getters, status constants, hash/proof helpers, event constants,
and test setup helpers also remain package-internal unless a frontend or
external transaction needs a stable public read API. Add those future reads to
`reader`, not to domain modules, `accessor`, or `admin`.

## Remaining production public outside allowlisted modules

None. Production `public fun` declarations should appear only in
`accessor.move`, `admin.move`, and `reader.move`. Other source modules may
declare `#[test_only] public fun` test helpers.
