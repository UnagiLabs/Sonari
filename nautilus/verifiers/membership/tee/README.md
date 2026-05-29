# Membership TEE

Rust library skeleton for the Sonari membership identity verifier TEE.

This crate owns the identity verification payload surface shared with `nautilus/verifiers/membership/shared`. The current step intentionally defines only the reviewable library skeleton: contract constants, skeletal error types, and serializable request/result structs.

The result payload keeps `verifier_family` as the string value `identity` and provider values as `kyc` or `world_id`, matching the shared TypeScript identity result contract.
