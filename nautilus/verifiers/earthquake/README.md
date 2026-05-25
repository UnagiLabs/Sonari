# Sonari Earthquake Verifier

## Overview

The Earthquake verifier is the Sonari MVP earthquake oracle implementation. It verifies public earthquake data inside Nautilus / TEE and produces the signed, finalized payload used by Sui contracts to create the claim-facing disaster event root.

MVP scope is earthquake only. Tsunami, flood, fire, nuclear accident, and other secondary hazards are not finalized by this verifier.

## Responsibilities

- Detect USGS earthquake candidates through the watcher and keep off-chain state in DynamoDB.
- Re-fetch and verify source data inside TEE instead of trusting the worker, watcher, relayer, UI, or external API responses.
- Compute ShakeMap MMI, H3 cells, affected cells, Merkle root, source hashes, BCS payload bytes, and TEE signature.
- Return `pending_source`, `pending_mmi`, `rejected`, `ignored_small`, `failed`, or `finalized` as off-chain processing state.
- Send only signed `finalized` payloads toward Sui submission.

## Trust Boundary

The trust boundary is the signed TEE result. Worker, Lambda, watcher, runner, relayer, and UI code may detect candidates, enqueue work, store state, and deliver payloads, but they must not change payload meaning.

Sui contracts verify the registered Earthquake verifier key, intent, `oracle_version`, freshness, revision, source, hashes, affected cell root, and finalized status. Membership / residence eligibility remains in `nautilus/verifiers/membership/`.

Generic Move names such as `DisasterEvent` and `disaster_event` remain generic disaster-relief contract concepts. They are not the name of this verifier implementation.

## Data Sources

- MVP primary source: USGS earthquake detail GeoJSON and ShakeMap `grid.xml.zip`.
- Future sources may include JMA or other public earthquake datasets, but they must be added as explicit source policies.
- Watcher summary fields such as magnitude, summary MMI, alert, and tsunami flag are only runner-start screening signals. Finalization depends on TEE-retrieved source data and cell-level MMI.

## AWS Execution Model

AWS runs the verifier only when there is work:

1. EventBridge Scheduler invokes the watcher Lambda.
2. The watcher scans USGS recent earthquake feeds and records event state in DynamoDB.
3. Eligible or manually submitted events start a Step Functions workflow.
4. The workflow scales an Auto Scaling Group from `0 -> 1`.
5. EC2 + Nitro Enclave runs the production TEE command.
6. Results are written to S3 and applied back to DynamoDB.
7. The workflow scales the ASG back to `1 -> 0`.

Normal idle state is `DesiredCapacity = 0`. Relayer execution defaults to preview / dry-run. Real submit must be explicitly enabled and remains fail-closed without signer configuration.

The CloudFormation template lives in `infra/aws/earthquake-runner/README.md`.

## Local Development

```bash
pnpm --filter @sonari/earthquake-shared test
pnpm --filter @sonari/earthquake-watcher test
pnpm --filter @sonari/earthquake-relayer test
pnpm --filter @sonari/earthquake-runner test
cargo test --manifest-path nautilus/verifiers/earthquake/tee/Cargo.toml
python3 nautilus/verifiers/earthquake/fixtures/verify_fixtures.py
```

Root verification:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm test:oracle
```

## Directory Structure

```txt
nautilus/verifiers/earthquake/
  README.md
  shared/      TypeScript contracts, constants, and validators
  tee/         Rust / Nautilus core
  watcher/     Candidate scan, state management, runner workflow start
  runner/      EC2 host service and Nitro Enclave command bridge
  relayer/     Sui preview, dry-run, and explicit submit
  fixtures/    USGS fixtures and golden output checks
```

Detailed component notes live in each subdirectory README.

## Output

TEE output is one of:

- `pending_source`: source or ShakeMap is not available yet.
- `pending_mmi`: source exists but usable MMI grid data is not available.
- `rejected`: source was verified but cannot produce claimable affected cells.
- `finalized`: signed Earthquake Oracle v1 payload with affected cells root, artifact hashes, BCS bytes, public key, and signature.

Only `finalized` output is eligible for Sui submission.

## Privacy / Security

- This verifier does not process personal residence, student, phone, GPS, address, or document evidence.
- Raw earthquake source artifacts are hashed and may be archived through Walrus-backed references.
- TEE signing keys stay inside the production TEE boundary.
- Watcher and relayer input is treated as untrusted at contract boundaries.
- Failures in source fetch, archive verification, BCS serialization, Merkle generation, or signing fail closed.

## Future Work

- Add explicitly versioned source policies for JMA or other public earthquake feeds.
- Support additional ShakeMap formats only with new fixtures and golden vectors.
- Add multi-region runner fallback after the single-region MVP is stable.
- Add operational dashboards for pending, rejected, failed, and finalized states.
- Generalize common runner or relayer utilities only after duplication appears across verifier families.
