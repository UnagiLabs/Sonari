# IdentityVerificationResult BCS contract

This document fixes the BCS bytes signed by the Membership identity verifier.
The Sui contract trusts only these signed bytes and the verifier public key.
Relayers, UI code, and external APIs must not reinterpret the payload.

## Scope

`IdentityVerificationResult` is the result produced by the Membership identity
TEE after a provider check succeeds. In the MVP, World ID can be represented by
a dummy verifier in devnet or testnet, but the result still uses this payload
shape before signing.

`verified=false` results are status outputs only. They are not signable payloads,
and they must not carry `payload_bcs_hex`, `signature`, or `public_key`.

## Field order

BCS has no field names in the encoded bytes. The order below is therefore part
of the contract.

| Order | Field | BCS type | Meaning |
| --- | --- | --- | --- |
| 1 | `intent` | `vector<u8>` | ASCII `SONARI_IDENTITY_VERIFICATION_V1` |
| 2 | `verifier_family` | `vector<u8>` | ASCII `identity` |
| 3 | `verifier_version` | `u64` | Version `1` |
| 4 | `registry_id` | 32 raw bytes | Identity registry object id |
| 5 | `membership_id` | 32 raw bytes | MembershipPass object id |
| 6 | `owner` | 32 raw bytes | MembershipPass owner address |
| 7 | `provider` | `u8` | Identity provider enum |
| 8 | `verified` | `bool` | Must be `true` for signing and Move acceptance |
| 9 | `duplicate_key_hash` | 32 raw bytes | Provider-specific duplicate key hash |
| 10 | `evidence_hash` | 32 raw bytes | Hash of non-PII verification evidence |
| 11 | `issued_at_ms` | `u64` | Verification issue time in milliseconds |
| 12 | `expires_at_ms` | `u64` | Verification expiry time in milliseconds |
| 13 | `terms_version` | `u64` | User statement terms version |
| 14 | `signed_statement_hash` | 32 raw bytes | Hash of the signed membership statement |

## Provider enum

| Provider | BCS value |
| --- | --- |
| `kyc` | `1` |
| `world_id` | `2` |

## Golden vector

The machine-readable vector lives at
`schemas/examples/identity_result_vectors.json`.

Rust, TypeScript, and Move tests must use that vector as the shared reference.
Move tests cannot read JSON directly, so a repository test checks that the Move
hex literal still equals the JSON vector.

## Privacy

Golden vectors must not contain raw PII, real World ID proof values, provider
credentials, or secrets. Hashes in this file are deterministic test values only.
