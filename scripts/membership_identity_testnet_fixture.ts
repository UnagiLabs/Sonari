import { pathToFileURL } from "node:url";

export const DEFAULT_FIXTURE_OUTPUT_DIR = ".local/sonari-dev/membership-identity-fixture";
export const FIXTURE_MANIFEST_FILE = "manifest.json";
export const FIXTURE_ENV_FILE = "fixture.env";
export const FIXTURE_DUMMY_WORLD_ID_REQUEST_FILE = "dummy-world-id-request.json";
export const DEFAULT_TERMS_VERSION = 1;
export const DEFAULT_SIGNED_STATEMENT_HASH = `0x${"44".repeat(32)}`;
export const DEFAULT_WORLD_ID_SIGNAL_HASH = `0x${"55".repeat(32)}`;
export const WORLD_ID_ACTION = "sonari_membership_register_v1";

export type FixtureNetwork = "devnet" | "testnet";

export interface MembershipIdentityFixtureObjects {
    readonly packageId: string;
    readonly adminCapId: string;
    readonly pauseStateId: string;
    readonly identityRegistryId: string;
    readonly membershipRegistryId: string;
    readonly verifierRegistryId: string;
    readonly allowedResidenceCellRegistryId: string;
    readonly membershipPassId: string;
}

export interface MembershipIdentityFixtureSmokeInput {
    readonly registryId: string;
    readonly membershipId: string;
    readonly owner: string;
    readonly termsVersion: number;
    readonly signedStatementHash: string;
    readonly worldId: MembershipIdentityFixtureWorldIdInput;
}

export interface MembershipIdentityFixtureWorldIdInput {
    readonly worldAppId: string;
    readonly nullifierHash: string;
    readonly merkleRoot: string;
    readonly proof: string;
    readonly verificationLevel: string;
    readonly action: string;
    readonly signalHash: string;
}

export interface MembershipIdentityFixtureManifestInput {
    readonly network: FixtureNetwork;
    readonly generatedAt: string;
    readonly suiClientConfig: string;
    readonly objects: MembershipIdentityFixtureObjects;
    readonly smoke: MembershipIdentityFixtureSmokeInput;
}

export interface MembershipIdentityFixtureManifest {
    readonly schema: "sonari.membership_identity.testnet_fixture";
    readonly version: 1;
    readonly network: FixtureNetwork;
    readonly generated_at: string;
    readonly sui_client_config: string;
    readonly objects: {
        readonly package_id: string;
        readonly admin_cap_id: string;
        readonly pause_state_id: string;
        readonly identity_registry_id: string;
        readonly membership_registry_id: string;
        readonly verifier_registry_id: string;
        readonly allowed_residence_cell_registry_id: string;
        readonly membership_pass_id: string;
    };
    readonly smoke: {
        readonly registry_id: string;
        readonly membership_id: string;
        readonly owner: string;
        readonly provider: "world_id";
        readonly terms_version: number;
        readonly signed_statement_hash: string;
        readonly world_id: {
            readonly world_app_id: string;
            readonly nullifier_hash: string;
            readonly merkle_root: string;
            readonly proof: string;
            readonly verification_level: string;
            readonly action: string;
            readonly signal_hash: string;
        };
    };
}

export type MembershipIdentityDummyWorldIdRequest = MembershipIdentityFixtureManifest["smoke"];

export interface MembershipIdentityFixtureFiles {
    readonly manifestJson: string;
    readonly envFile: string;
    readonly dummyWorldIdRequestJson: string;
}

export function assertFixtureNetwork(input: string): FixtureNetwork {
    if (input === "devnet" || input === "testnet") {
        return input;
    }
    throw new Error("membership identity fixture only supports devnet or testnet");
}

export function buildMembershipIdentityFixtureFiles(
    input: MembershipIdentityFixtureManifestInput,
): MembershipIdentityFixtureFiles {
    const manifest = buildMembershipIdentityFixtureManifest(input);
    return {
        manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
        envFile: renderMembershipIdentityFixtureEnv(manifest),
        dummyWorldIdRequestJson: `${JSON.stringify(buildDummyWorldIdRequest(manifest), null, 2)}\n`,
    };
}

export function buildMembershipIdentityFixtureManifest(
    input: MembershipIdentityFixtureManifestInput,
): MembershipIdentityFixtureManifest {
    assertFixtureNetwork(input.network);
    validateFixtureObjects(input.objects);
    validateSmokeInput(input.smoke);
    if (input.objects.identityRegistryId !== input.smoke.registryId) {
        throw new Error("smoke registry_id must match SONARI_IDENTITY_REGISTRY_ID");
    }
    if (input.objects.membershipPassId !== input.smoke.membershipId) {
        throw new Error("smoke membership_id must match SONARI_MEMBERSHIP_PASS_ID");
    }

    return {
        schema: "sonari.membership_identity.testnet_fixture",
        version: 1,
        network: input.network,
        generated_at: input.generatedAt,
        sui_client_config: input.suiClientConfig,
        objects: {
            package_id: input.objects.packageId,
            admin_cap_id: input.objects.adminCapId,
            pause_state_id: input.objects.pauseStateId,
            identity_registry_id: input.objects.identityRegistryId,
            membership_registry_id: input.objects.membershipRegistryId,
            verifier_registry_id: input.objects.verifierRegistryId,
            allowed_residence_cell_registry_id: input.objects.allowedResidenceCellRegistryId,
            membership_pass_id: input.objects.membershipPassId,
        },
        smoke: {
            registry_id: input.smoke.registryId,
            membership_id: input.smoke.membershipId,
            owner: input.smoke.owner,
            provider: "world_id",
            terms_version: input.smoke.termsVersion,
            signed_statement_hash: input.smoke.signedStatementHash,
            world_id: {
                world_app_id: input.smoke.worldId.worldAppId,
                nullifier_hash: input.smoke.worldId.nullifierHash,
                merkle_root: input.smoke.worldId.merkleRoot,
                proof: input.smoke.worldId.proof,
                verification_level: input.smoke.worldId.verificationLevel,
                action: input.smoke.worldId.action,
                signal_hash: input.smoke.worldId.signalHash,
            },
        },
    };
}

export function buildDummyWorldIdRequest(
    manifest: MembershipIdentityFixtureManifest,
): MembershipIdentityDummyWorldIdRequest {
    return manifest.smoke;
}

export function renderMembershipIdentityFixtureEnv(
    manifest: MembershipIdentityFixtureManifest,
): string {
    return [
        `SONARI_IDENTITY_PACKAGE_ID=${manifest.objects.package_id}`,
        `SONARI_IDENTITY_PAUSE_STATE_ID=${manifest.objects.pause_state_id}`,
        `SONARI_IDENTITY_REGISTRY_ID=${manifest.objects.identity_registry_id}`,
        `SONARI_MEMBERSHIP_REGISTRY_ID=${manifest.objects.membership_registry_id}`,
        `SONARI_VERIFIER_REGISTRY_ID=${manifest.objects.verifier_registry_id}`,
        `SONARI_MEMBERSHIP_PASS_ID=${manifest.objects.membership_pass_id}`,
        "",
    ].join("\n");
}

export function validateFixtureObjects(objects: MembershipIdentityFixtureObjects): void {
    assertHexObjectId(objects.packageId, "packageId");
    assertHexObjectId(objects.adminCapId, "adminCapId");
    assertHexObjectId(objects.pauseStateId, "pauseStateId");
    assertHexObjectId(objects.identityRegistryId, "identityRegistryId");
    assertHexObjectId(objects.membershipRegistryId, "membershipRegistryId");
    assertHexObjectId(objects.verifierRegistryId, "verifierRegistryId");
    assertHexObjectId(objects.allowedResidenceCellRegistryId, "allowedResidenceCellRegistryId");
    assertHexObjectId(objects.membershipPassId, "membershipPassId");
}

export function validateSmokeInput(input: MembershipIdentityFixtureSmokeInput): void {
    assertHexObjectId(input.registryId, "registryId");
    assertHexObjectId(input.membershipId, "membershipId");
    assertHexObjectId(input.owner, "owner");
    assertHex32(input.signedStatementHash, "signedStatementHash");
    assertHex32(input.worldId.signalHash, "worldId.signalHash");
    if (!Number.isSafeInteger(input.termsVersion) || input.termsVersion < 0) {
        throw new Error("termsVersion must be a non-negative safe integer");
    }
    assertNonEmpty(input.worldId.worldAppId, "worldId.worldAppId");
    assertNonEmpty(input.worldId.nullifierHash, "worldId.nullifierHash");
    assertNonEmpty(input.worldId.merkleRoot, "worldId.merkleRoot");
    assertNonEmpty(input.worldId.proof, "worldId.proof");
    assertNonEmpty(input.worldId.verificationLevel, "worldId.verificationLevel");
    if (input.worldId.action !== WORLD_ID_ACTION) {
        throw new Error(`worldId.action must be ${WORLD_ID_ACTION}`);
    }
}

function assertHexObjectId(value: string, fieldName: string): void {
    if (!/^0x[0-9a-fA-F]+$/.test(value)) {
        throw new Error(`${fieldName} must be a 0x-prefixed hex object id`);
    }
}

function assertHex32(value: string, fieldName: string): void {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`${fieldName} must be 32-byte 0x-prefixed hex`);
    }
}

function assertNonEmpty(value: string, fieldName: string): void {
    if (value.length === 0) {
        throw new Error(`${fieldName} must be non-empty`);
    }
}

async function main(): Promise<void> {
    throw new Error("membership identity fixture execution is implemented in a later step");
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
