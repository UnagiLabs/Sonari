# Census TEE

`census-tee` is the Rust crate reserved for the Sonari census verifier.

## Responsibility

- Own census verifier constants exposed to local Rust tests and future CLI code.
- Depend on the shared verifier registry for canonical numbering and attestation labels.
- Provide the workspace package, library target, and binary target used by later census TEE steps.

## Out of Scope

- BCS payload encoding.
- Affected root calculation.
- Census aggregation.
- Nautilus server mode.
- External source fetching or submission.
