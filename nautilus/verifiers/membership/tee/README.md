# Membership TEE

Rust crate for the Sonari membership identity verifier TEE.

This crate owns the identity verification payload surface shared with
`nautilus/verifiers/membership/shared`. The signed payload keeps
`verifier_family` as `identity` and provider values as `kyc` or `world_id`,
matching the shared TypeScript identity result contract.

## CLI contract

`membership-tee fixture` and `membership-tee production` read one
`IdentityVerifyRequest` JSON from stdin and write one status-tagged JSON result
to stdout.

Input request fields:

- `registry_id`
- `membership_id`
- `owner`
- `provider`
- `terms_version`
- `signed_statement_hash`
- `issued_at_ms`
- `validity_ms`
- `world_id.world_app_id`
- `world_id.action`
- `world_id.nullifier_hash`
- `world_id.proof`
- `world_id.merkle_root`
- `world_id.verification_level`
- `world_id.signal_hash`

Unknown fields are rejected. This applies to top-level request fields and nested
`world_id` fields.

Output statuses:

- `verified`: includes `payload_bcs_hex`, `signature`, `public_key`,
  `duplicate_key_hash`, and `expires_at_ms`.
- `rejected`: includes only `error_code`.
- `pending_source`: includes only `error_code`.
- `unsupported`: includes only `error_code`.

Only `verified` results are signed. The signature covers the payload BCS bytes
themselves. It does not include an intent prefix.

## Modes

`fixture` is deterministic and may use the dev signing seed. It supports
`--world-id-status verified|rejected|pending-source` for tests.

`production` uses `CloudWorldIdVerifier::from_env()`. It requires
`SONARI_TEE_SIGNING_KEY_SEED` or `SONARI_TEE_SIGNING_KEY_SEED_FILE`. It does not
accept a signing seed as a command-line argument.

`membership-tee --encode-only` reads a full `IdentityTeeResult` payload JSON from
stdin and returns only:

```json
{"payload_bcs_hex":"0x..."}
```

`--encode-only` rejects payloads where `verified` is not `true`.
