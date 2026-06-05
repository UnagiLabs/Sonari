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
Sui registration config present:
Sui registration signer configured:

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

dummy World ID proof は testnet / devnet のみ記録します。mainnet では live gate が
deploy 前に拒否するため、dummy を記録してはいけません。

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

## Sui registration config

IDENTITY_RELAYER_MODE:
SONARI_IDENTITY_PACKAGE_ID:
SONARI_VERIFIER_REGISTRY_ID:
RELAYER_NETWORK:
RELAYER_GRPC_URL:
RELAYER_ALLOW_SUBMIT:
RELAYER_SIGNER_SECRET_ARN:

## Verification log

Local unit tests:
AWS deployment smoke:
Nitro Enclave start:
vsock-proxy World ID real API smoke:
VerifierRegistry registration:
TEE process_data:
AWS idle cleanup (DesiredCapacity / InService / running EC2 / schedule):

## VerifierRegistry registration metadata

verifier_config_key:
verifier_config_version:
enclave_instance_public_key:

## TEE result

status:
payload_bcs_hex (verified only):
signature present (verified only):
public_key present (verified only):
signature absent (non-verified only):
public_key absent (non-verified only):
job tx_digest (TEE-only digest, not registration proof):

## Close-out

Issue #74 DoD met:
Remaining blockers:
