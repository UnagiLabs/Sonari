# Membership identity AWS runner evidence

Use this template for issue #74 live verification. Leave secrets, raw proof
body, signing seed plaintext, and private keys out of this file.

## Run identity

Stack name:
Git commit SHA:
Operator:
AWS account:
AWS region:
Sui network:
Run started at:
Run completed at:

## Credentials gate

AWS credentials present:
World ID app/proof inputs present:
Sui object IDs present:
Sui submit signer configured:

If any item is missing, stop and record the blocker here. credential absence
means issue cannot be closed.

## Artifacts

Artifact path:
Artifact checksum:
EIF path:
EIF checksum:
EIF identity:
ImageSha384:
PCR3:

## Encrypted signing material

Signing material ciphertext S3 bucket:
Signing material ciphertext S3 key:
KMS key id:
KMS/Nitro attestation measurements checked:

## World ID app/proof inputs

World ID proof mode (real/dummy):
World ID app id:
World ID API base:
World ID action:
World ID proof job id or redacted reference:
TEE stdout status:
Public key:

## Stack parameters

VpcId:
SubnetIds:
AmiId:
LambdaCodeS3Bucket:
LambdaCodeS3Key:
TeeArtifactS3Bucket:
TeeArtifactS3Key:
TeeArtifactSha256:
TeeEifS3Bucket:
TeeEifS3Key:
TeeEifSha256:
NitroEnclaveImageSha384:
NitroEnclavePcr3:
WorldIdAppId:
WorldIdApiBase:
ScheduleState:

## Sui object IDs

SONARI_IDENTITY_PACKAGE_ID:
SONARI_IDENTITY_PAUSE_STATE_ID:
SONARI_IDENTITY_REGISTRY_ID:
SONARI_MEMBERSHIP_REGISTRY_ID:
SONARI_VERIFIER_REGISTRY_ID:
SONARI_MEMBERSHIP_PASS_ID:
SONARI_SUI_CLOCK_ID:
RELAYER_NETWORK:
RELAYER_GRPC_URL:
RELAYER_SENDER_ADDRESS:

## Verification log

Local unit tests:
AWS deployment smoke:
Nitro Enclave start:
vsock-proxy World ID real API smoke:
Sui dry-run:
Sui submit:

## Sui result

Tx digest:
Submit effects summary:
Post-tx readback:
Membership pass object id:
Identity verified:
Provider:
Verified at:
Expires at:
Terms version:
Signed statement hash:

## Close-out

Issue #74 DoD met:
Remaining blockers:
