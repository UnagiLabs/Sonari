import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_FIXTURE_OUTPUT_DIR = ".local/sonari-dev/membership-identity-fixture";
export const FIXTURE_MANIFEST_FILE = "manifest.json";
export const FIXTURE_ENV_FILE = "fixture.env";
export const FIXTURE_DUMMY_WORLD_ID_REQUEST_FILE = "dummy-world-id-request.json";
export const DEFAULT_HOME_CELL = "608819013597790207";
export const DEFAULT_GEO_RESOLUTION = "7";
export const DEFAULT_ALLOWLIST_VERSION = "1";
export const DEFAULT_TERMS_VERSION = 2;
export const DEFAULT_SIGNED_STATEMENT_HASH = `0x${"44".repeat(32)}`;
export const DEFAULT_WORLD_ID_SIGNAL_HASH = `0x${"55".repeat(32)}`;
export const DEFAULT_RESIDENCE_ROOT =
    "0xa26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020";
export const DEFAULT_RESIDENCE_SOURCE_HASH = `0x${"11".repeat(32)}`;
export const DEFAULT_RESIDENCE_PROOF_LEFT =
    "0x07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569";
export const DEFAULT_RESIDENCE_PROOF_RIGHT =
    "0x8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7";
export const WORLD_ID_ACTION = "sonari_membership_register_v1";
export const GENESIS_KIND_PAUSE_STATE = 2;
export const GENESIS_KIND_MEMBERSHIP_REGISTRY = 6;
export const GENESIS_KIND_VERIFIER_REGISTRY = 7;
export const GENESIS_KIND_IDENTITY_REGISTRY = 9;

export const EXPECTED_OBJECT_TYPES = {
    adminCap: "::admin::AdminCap",
    pauseState: "::admin::PauseState",
    identityRegistry: "::identity_registry::IdentityRegistry",
    membershipRegistry: "::membership::MembershipRegistry",
    verifierRegistry: "::metadata_verifier::VerifierRegistry",
    allowedResidenceCellRegistry: "::allowed_residence_cell::AllowedResidenceCellRegistry",
    membershipPass: "::membership::MembershipPass",
} as const;

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

export interface MembershipIdentityFixtureRunResult {
    readonly outputDir: string;
    readonly manifestPath: string;
    readonly envPath: string;
    readonly dummyWorldIdRequestPath: string;
    readonly manifest: MembershipIdentityFixtureManifest;
}

export interface SuiCommandResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface SuiObjectReadback {
    readonly objectId: string;
    readonly type: string;
    readonly fields: Record<string, unknown>;
}

export interface SuiPublishFixtureObjects {
    readonly packageId: string;
    readonly adminCapId: string;
    readonly pauseStateId: string;
    readonly identityRegistryId: string;
    readonly membershipRegistryId: string;
    readonly verifierRegistryId: string;
}

export interface SuiCommandPlan {
    readonly command: "sui";
    readonly args: readonly string[];
}

export interface SuiClientOptions {
    readonly clientConfig: string;
    readonly env: FixtureNetwork;
    readonly gasBudget?: string;
}

export type SuiCommandExecutor = (plan: SuiCommandPlan) => Promise<SuiCommandResult>;

export interface MembershipIdentityFixtureBaseObjects {
    readonly packageId: string;
    readonly adminCapId: string;
    readonly pauseStateId: string;
    readonly identityRegistryId: string;
    readonly membershipRegistryId: string;
    readonly verifierRegistryId: string;
}

export interface MembershipIdentityFixtureBaseObjectCandidates {
    readonly packageId?: string;
    readonly adminCapId?: string;
    readonly pauseStateId?: string;
    readonly identityRegistryId?: string;
    readonly membershipRegistryId?: string;
    readonly verifierRegistryId?: string;
}

export interface ResolveBaseFixtureObjectsInput {
    readonly candidates: MembershipIdentityFixtureBaseObjectCandidates;
    readonly options: SuiClientOptions;
    readonly executor: SuiCommandExecutor;
    readonly publishIfMissing?: boolean;
}

export interface RunMembershipIdentityTestnetFixtureOptions {
    readonly env: FixtureNetwork;
    readonly clientConfig: string;
    readonly outputDir: string;
    readonly publishIfMissing?: boolean;
    readonly executor?: SuiCommandExecutor;
    readonly processEnv?: Record<string, string | undefined>;
    readonly now?: () => Date;
}

export interface ResidenceFixtureInput {
    readonly packageId: string;
    readonly adminCapId: string;
    readonly root: string;
    readonly geoResolution: string;
    readonly allowlistVersion: string;
    readonly sourceHash: string;
}

export interface MembershipPassFixtureInput {
    readonly packageId: string;
    readonly pauseStateId: string;
    readonly membershipRegistryId: string;
    readonly allowedResidenceCellRegistryId: string;
    readonly homeCell: string;
    readonly proofLeft: string;
    readonly proofRight: string;
    readonly termsVersion: number;
    readonly signedStatementHash: string;
}

export interface MembershipPassReadback {
    readonly passId: string;
    readonly owner: string;
    readonly identityVerified: false;
    readonly providerLabel: "Unverified";
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

export function parseSuiJsonCommandResult(result: SuiCommandResult, context: string): unknown {
    if (result.code !== 0) {
        const detail = result.stderr.length > 0 ? result.stderr : result.stdout;
        throw new Error(`${context} failed: ${detail.trim()}`);
    }
    try {
        return JSON.parse(result.stdout) as unknown;
    } catch (error) {
        throw new Error(`${context} returned invalid JSON: ${errorMessage(error)}`);
    }
}

export function parseSuiActiveEnv(input: unknown): string {
    if (typeof input === "string") {
        return input;
    }
    if (isRecord(input)) {
        const activeEnv = input.active_env ?? input.activeEnv ?? input.alias;
        if (typeof activeEnv === "string") {
            return activeEnv;
        }
    }
    throw new Error("sui active-env JSON did not include an active env");
}

export function parseSuiObjectReadback(input: unknown): SuiObjectReadback {
    const data = isRecord(input) && isRecord(input.data) ? input.data : input;
    if (!isRecord(data)) {
        throw new Error("sui object JSON must be an object");
    }
    const objectId = stringField(data, ["objectId", "object_id"], "object id");
    const type = stringField(data, ["type", "objectType", "object_type"], "object type");
    const content = isRecord(data.content) ? data.content : undefined;
    const fields = content !== undefined && isRecord(content.fields) ? content.fields : {};
    return { objectId, type, fields };
}

export function assertSuiObjectType(
    object: SuiObjectReadback,
    expectedType: string,
    fieldName: string,
): void {
    if (object.type !== expectedType) {
        throw new Error(`${fieldName} must be ${expectedType}, got ${object.type}`);
    }
}

export function parsePublishFixtureObjects(input: unknown): SuiPublishFixtureObjects {
    const packageId = parsePublishedPackageId(input);
    const adminCapId = parseCreatedObjectId(
        input,
        expectedPackageType(packageId, EXPECTED_OBJECT_TYPES.adminCap),
        "AdminCap",
    );
    const genesis = parseGenesisObjectIds(input);
    const pauseStateId = genesis.get(GENESIS_KIND_PAUSE_STATE);
    const membershipRegistryId = genesis.get(GENESIS_KIND_MEMBERSHIP_REGISTRY);
    const verifierRegistryId = genesis.get(GENESIS_KIND_VERIFIER_REGISTRY);
    const identityRegistryId = genesis.get(GENESIS_KIND_IDENTITY_REGISTRY);

    if (pauseStateId === undefined) {
        throw new Error("publish result did not include PauseState genesis object");
    }
    if (membershipRegistryId === undefined) {
        throw new Error("publish result did not include MembershipRegistry genesis object");
    }
    if (verifierRegistryId === undefined) {
        throw new Error("publish result did not include VerifierRegistry genesis object");
    }
    if (identityRegistryId === undefined) {
        throw new Error("publish result did not include IdentityRegistry genesis object");
    }

    return {
        packageId,
        adminCapId,
        pauseStateId,
        identityRegistryId,
        membershipRegistryId,
        verifierRegistryId,
    };
}

export function parseMembershipPassIssuedId(input: unknown): string {
    for (const event of readEvents(input)) {
        const parsedJson = readParsedJson(event);
        const passId = parsedJson.pass_id ?? parsedJson.passId;
        if (
            typeof passId === "string" &&
            eventTypeIncludes(event, "::membership::MembershipPassIssued")
        ) {
            assertHexObjectId(passId, "MembershipPassIssued.pass_id");
            return passId;
        }
    }
    throw new Error("transaction result did not include MembershipPassIssued event");
}

export function buildSuiObjectCommand(objectId: string, options: SuiClientOptions): SuiCommandPlan {
    assertHexObjectId(objectId, "objectId");
    return {
        command: "sui",
        args: [
            "client",
            "--client.config",
            options.clientConfig,
            "--client.env",
            options.env,
            "object",
            objectId,
            "--json",
        ],
    };
}

export function buildSuiPublishCommand(options: SuiClientOptions): SuiCommandPlan {
    return {
        command: "sui",
        args: [
            "client",
            "--client.config",
            options.clientConfig,
            "--client.env",
            options.env,
            "publish",
            "contracts",
            "--gas-budget",
            options.gasBudget ?? "1000000000",
            "--json",
        ],
    };
}

export function buildSuiCallCommand(input: {
    readonly options: SuiClientOptions;
    readonly packageId: string;
    readonly module: string;
    readonly functionName: string;
    readonly args: readonly string[];
}): SuiCommandPlan {
    assertHexObjectId(input.packageId, "packageId");
    return {
        command: "sui",
        args: [
            "client",
            "--client.config",
            input.options.clientConfig,
            "--client.env",
            input.options.env,
            "call",
            "--package",
            input.packageId,
            "--module",
            input.module,
            "--function",
            input.functionName,
            "--args",
            ...input.args,
            "--gas-budget",
            input.options.gasBudget ?? "100000000",
            "--json",
        ],
    };
}

export function buildCreateAllowedResidenceCellRegistryCommand(
    input: ResidenceFixtureInput,
    options: SuiClientOptions,
): SuiCommandPlan {
    assertHexObjectId(input.packageId, "packageId");
    assertHexObjectId(input.adminCapId, "adminCapId");
    assertHex32(input.root, "residence.root");
    assertHex32(input.sourceHash, "residence.sourceHash");
    return buildSuiCallCommand({
        options,
        packageId: input.packageId,
        module: "admin",
        functionName: "create_allowed_residence_cell_registry",
        args: [
            input.adminCapId,
            input.root,
            input.geoResolution,
            input.allowlistVersion,
            input.sourceHash,
        ],
    });
}

export function buildSuiPtbCommand(
    options: SuiClientOptions,
    transactions: readonly string[],
): SuiCommandPlan {
    if (transactions.length === 0) {
        throw new Error("PTB requires at least one transaction argument");
    }
    return {
        command: "sui",
        args: [
            "client",
            "--client.config",
            options.clientConfig,
            "--client.env",
            options.env,
            "ptb",
            ...transactions,
            "--gas-budget",
            options.gasBudget ?? "100000000",
            "--json",
        ],
    };
}

export function buildRegisterMemberPtbCommand(
    input: MembershipPassFixtureInput,
    options: SuiClientOptions,
): SuiCommandPlan {
    assertHexObjectId(input.packageId, "packageId");
    assertHexObjectId(input.pauseStateId, "pauseStateId");
    assertHexObjectId(input.membershipRegistryId, "membershipRegistryId");
    assertHexObjectId(input.allowedResidenceCellRegistryId, "allowedResidenceCellRegistryId");
    assertHex32(input.proofLeft, "residence.proofLeft");
    assertHex32(input.proofRight, "residence.proofRight");
    assertHex32(input.signedStatementHash, "signedStatementHash");
    const proofType = `<${input.packageId}::allowed_residence_cell::ProofStep>`;
    return buildSuiPtbCommand(options, [
        "--move-call",
        `${input.packageId}::accessor::new_residence_proof_step_left`,
        input.proofLeft,
        "--assign",
        "proof_left",
        "--move-call",
        `${input.packageId}::accessor::new_residence_proof_step_right`,
        input.proofRight,
        "--assign",
        "proof_right",
        "--make-move-vec",
        proofType,
        "[proof_left,proof_right]",
        "--assign",
        "residence_proof",
        "--move-call",
        `${input.packageId}::accessor::register_member`,
        `@${input.pauseStateId}`,
        `@${input.membershipRegistryId}`,
        `@${input.allowedResidenceCellRegistryId}`,
        input.homeCell,
        "residence_proof",
        input.termsVersion.toString(),
        input.signedStatementHash,
    ]);
}

export async function resolveBaseFixtureObjects(
    input: ResolveBaseFixtureObjectsInput,
): Promise<MembershipIdentityFixtureBaseObjects> {
    assertFixtureNetwork(input.options.env);
    const candidates = input.candidates;
    const missing = missingBaseObjectFields(candidates);
    if (missing.length > 0 && input.publishIfMissing !== true) {
        throw new Error(
            `missing fixture object ids: ${missing.join(", ")}; pass --publish-if-missing to publish contracts`,
        );
    }

    const baseObjects =
        missing.length > 0
            ? await publishBaseFixtureObjects(input.options, input.executor)
            : completeBaseObjectCandidates(candidates);

    await verifyBaseObjectReadbacks(baseObjects, input.options, input.executor);
    return baseObjects;
}

export function parseAllowedResidenceCellRegistryId(input: unknown): string {
    for (const event of readEvents(input)) {
        if (
            !eventTypeIncludes(event, "::allowed_residence_cell::AllowedResidenceCellRootUpdated")
        ) {
            continue;
        }
        const parsedJson = readParsedJson(event);
        const registryId = parsedJson.registry_id ?? parsedJson.registryId;
        if (typeof registryId !== "string") {
            throw new Error("AllowedResidenceCellRootUpdated event is missing registry_id");
        }
        assertHexObjectId(registryId, "AllowedResidenceCellRootUpdated.registry_id");
        return registryId;
    }
    throw new Error("transaction result did not include AllowedResidenceCellRootUpdated event");
}

export function parseUnverifiedMembershipPassReadback(
    input: unknown,
    expectedPassId: string,
    expectedPackageId: string,
): MembershipPassReadback {
    assertHexObjectId(expectedPassId, "expectedPassId");
    assertHexObjectId(expectedPackageId, "expectedPackageId");
    const object = parseSuiObjectReadback(input);
    if (object.objectId !== expectedPassId) {
        throw new Error(`membership pass readback id mismatch: expected ${expectedPassId}`);
    }
    assertSuiObjectType(
        object,
        expectedPackageType(expectedPackageId, EXPECTED_OBJECT_TYPES.membershipPass),
        "membershipPassId",
    );
    const owner = readStringField(object.fields, "owner");
    assertHexObjectId(owner, "membershipPass.owner");
    const identityVerified = object.fields.identity_verified ?? object.fields.identityVerified;
    if (identityVerified !== false) {
        throw new Error("membership pass fixture must start with identity_verified=false");
    }
    const providerLabel = readStringField(object.fields, "provider_label");
    if (providerLabel !== "Unverified") {
        throw new Error("membership pass fixture must start with provider_label=Unverified");
    }
    return {
        passId: object.objectId,
        owner,
        identityVerified: false,
        providerLabel: "Unverified",
    };
}

export function parsePublishedTomlPackageId(
    input: string,
    env: FixtureNetwork,
): string | undefined {
    const sectionPattern = new RegExp(`\\[published\\.${env}\\]([\\s\\S]*?)(?:\\n\\[|$)`);
    const section = sectionPattern.exec(input)?.[1];
    if (section === undefined) {
        return undefined;
    }
    const publishedAt = /^\s*published-at\s*=\s*"([^"]+)"/m.exec(section)?.[1];
    if (publishedAt === undefined) {
        return undefined;
    }
    assertHexObjectId(publishedAt, `published.${env}.published-at`);
    return publishedAt;
}

export async function runMembershipIdentityTestnetFixture(
    options: RunMembershipIdentityTestnetFixtureOptions,
): Promise<MembershipIdentityFixtureRunResult> {
    const fixtureEnv = assertFixtureNetwork(options.env);
    const executor = options.executor ?? executeSuiCommand;
    const runtimeEnv = options.processEnv ?? process.env;
    const existingManifest = await readExistingManifest(options.outputDir);
    const publishedTomlPackageId = await readPublishedTomlPackageId(fixtureEnv);
    const allowedResidenceCellRegistryCandidate =
        runtimeEnv.SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID ??
        existingManifest?.objects.allowed_residence_cell_registry_id;
    const membershipPassCandidate =
        runtimeEnv.SONARI_MEMBERSHIP_PASS_ID ?? existingManifest?.objects.membership_pass_id;
    const baseObjects = await resolveBaseFixtureObjects({
        candidates: buildBaseObjectCandidates(runtimeEnv, existingManifest, publishedTomlPackageId),
        options: {
            clientConfig: options.clientConfig,
            env: fixtureEnv,
        },
        executor,
        ...(options.publishIfMissing === undefined
            ? {}
            : { publishIfMissing: options.publishIfMissing }),
    });
    const allowedResidenceCellRegistryId = await resolveAllowedResidenceCellRegistryId({
        baseObjects,
        options: {
            clientConfig: options.clientConfig,
            env: fixtureEnv,
        },
        executor,
        ...(allowedResidenceCellRegistryCandidate === undefined
            ? {}
            : { candidate: allowedResidenceCellRegistryCandidate }),
    });
    const passReadback = await resolveMembershipPassReadback({
        baseObjects,
        allowedResidenceCellRegistryId,
        options: {
            clientConfig: options.clientConfig,
            env: fixtureEnv,
        },
        executor,
        ...(membershipPassCandidate === undefined ? {} : { candidate: membershipPassCandidate }),
    });
    const manifest = buildMembershipIdentityFixtureManifest({
        network: fixtureEnv,
        generatedAt: (options.now ?? (() => new Date()))().toISOString(),
        suiClientConfig: options.clientConfig,
        objects: {
            packageId: baseObjects.packageId,
            adminCapId: baseObjects.adminCapId,
            pauseStateId: baseObjects.pauseStateId,
            identityRegistryId: baseObjects.identityRegistryId,
            membershipRegistryId: baseObjects.membershipRegistryId,
            verifierRegistryId: baseObjects.verifierRegistryId,
            allowedResidenceCellRegistryId,
            membershipPassId: passReadback.passId,
        },
        smoke: {
            registryId: baseObjects.identityRegistryId,
            membershipId: passReadback.passId,
            owner: passReadback.owner,
            termsVersion: DEFAULT_TERMS_VERSION,
            signedStatementHash: DEFAULT_SIGNED_STATEMENT_HASH,
            worldId: defaultWorldIdInput(),
        },
    });
    await writeFixtureFiles(
        options.outputDir,
        buildMembershipIdentityFixtureFilesFromManifest(manifest),
    );
    return {
        outputDir: options.outputDir,
        manifestPath: path.join(options.outputDir, FIXTURE_MANIFEST_FILE),
        envPath: path.join(options.outputDir, FIXTURE_ENV_FILE),
        dummyWorldIdRequestPath: path.join(options.outputDir, FIXTURE_DUMMY_WORLD_ID_REQUEST_FILE),
        manifest,
    };
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

function buildMembershipIdentityFixtureFilesFromManifest(
    manifest: MembershipIdentityFixtureManifest,
): MembershipIdentityFixtureFiles {
    return {
        manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
        envFile: renderMembershipIdentityFixtureEnv(manifest),
        dummyWorldIdRequestJson: `${JSON.stringify(buildDummyWorldIdRequest(manifest), null, 2)}\n`,
    };
}

function defaultWorldIdInput(): MembershipIdentityFixtureWorldIdInput {
    return {
        worldAppId: "app_staging_123",
        nullifierHash: "12345678901234567890",
        merkleRoot: "987654321",
        proof: "0xproof",
        verificationLevel: "orb",
        action: WORLD_ID_ACTION,
        signalHash: DEFAULT_WORLD_ID_SIGNAL_HASH,
    };
}

async function resolveAllowedResidenceCellRegistryId(input: {
    readonly baseObjects: MembershipIdentityFixtureBaseObjects;
    readonly options: SuiClientOptions;
    readonly executor: SuiCommandExecutor;
    readonly candidate?: string;
}): Promise<string> {
    if (input.candidate !== undefined) {
        assertHexObjectId(input.candidate, "allowedResidenceCellRegistryId");
        const readback = await input.executor(
            buildSuiObjectCommand(input.candidate, input.options),
        );
        const parsed = parseSuiJsonCommandResult(
            readback,
            "sui object allowedResidenceCellRegistryId",
        );
        assertSuiObjectType(
            parseSuiObjectReadback(parsed),
            expectedPackageType(
                input.baseObjects.packageId,
                EXPECTED_OBJECT_TYPES.allowedResidenceCellRegistry,
            ),
            "allowedResidenceCellRegistryId",
        );
        return input.candidate;
    }

    const created = await input.executor(
        buildCreateAllowedResidenceCellRegistryCommand(
            {
                packageId: input.baseObjects.packageId,
                adminCapId: input.baseObjects.adminCapId,
                root: DEFAULT_RESIDENCE_ROOT,
                geoResolution: DEFAULT_GEO_RESOLUTION,
                allowlistVersion: DEFAULT_ALLOWLIST_VERSION,
                sourceHash: DEFAULT_RESIDENCE_SOURCE_HASH,
            },
            input.options,
        ),
    );
    const parsed = parseSuiJsonCommandResult(created, "create allowed residence cell registry");
    return parseAllowedResidenceCellRegistryId(parsed);
}

async function resolveMembershipPassReadback(input: {
    readonly baseObjects: MembershipIdentityFixtureBaseObjects;
    readonly allowedResidenceCellRegistryId: string;
    readonly options: SuiClientOptions;
    readonly executor: SuiCommandExecutor;
    readonly candidate?: string;
}): Promise<MembershipPassReadback> {
    if (input.candidate !== undefined) {
        return readMembershipPass(
            input.candidate,
            input.baseObjects.packageId,
            input.options,
            input.executor,
        );
    }

    const created = await input.executor(
        buildRegisterMemberPtbCommand(
            {
                packageId: input.baseObjects.packageId,
                pauseStateId: input.baseObjects.pauseStateId,
                membershipRegistryId: input.baseObjects.membershipRegistryId,
                allowedResidenceCellRegistryId: input.allowedResidenceCellRegistryId,
                homeCell: DEFAULT_HOME_CELL,
                proofLeft: DEFAULT_RESIDENCE_PROOF_LEFT,
                proofRight: DEFAULT_RESIDENCE_PROOF_RIGHT,
                termsVersion: DEFAULT_TERMS_VERSION,
                signedStatementHash: DEFAULT_SIGNED_STATEMENT_HASH,
            },
            input.options,
        ),
    );
    const parsed = parseSuiJsonCommandResult(created, "register membership pass");
    const passId = parseMembershipPassIssuedId(parsed);
    return readMembershipPass(passId, input.baseObjects.packageId, input.options, input.executor);
}

async function readMembershipPass(
    passId: string,
    packageId: string,
    options: SuiClientOptions,
    executor: SuiCommandExecutor,
): Promise<MembershipPassReadback> {
    const output = await executor(buildSuiObjectCommand(passId, options));
    const parsed = parseSuiJsonCommandResult(output, "sui object membershipPassId");
    return parseUnverifiedMembershipPassReadback(parsed, passId, packageId);
}

function buildBaseObjectCandidates(
    env: Record<string, string | undefined>,
    manifest: MembershipIdentityFixtureManifest | undefined,
    publishedTomlPackageId: string | undefined,
): MembershipIdentityFixtureBaseObjectCandidates {
    const packageId =
        env.SONARI_IDENTITY_PACKAGE_ID ?? manifest?.objects.package_id ?? publishedTomlPackageId;
    const adminCapId =
        env.SONARI_IDENTITY_ADMIN_CAP_ID ?? env.ADMIN_CAP_ID ?? manifest?.objects.admin_cap_id;
    const pauseStateId = env.SONARI_IDENTITY_PAUSE_STATE_ID ?? manifest?.objects.pause_state_id;
    const identityRegistryId =
        env.SONARI_IDENTITY_REGISTRY_ID ?? manifest?.objects.identity_registry_id;
    const membershipRegistryId =
        env.SONARI_MEMBERSHIP_REGISTRY_ID ?? manifest?.objects.membership_registry_id;
    const verifierRegistryId =
        env.SONARI_VERIFIER_REGISTRY_ID ?? manifest?.objects.verifier_registry_id;
    return {
        ...(packageId === undefined ? {} : { packageId }),
        ...(adminCapId === undefined ? {} : { adminCapId }),
        ...(pauseStateId === undefined ? {} : { pauseStateId }),
        ...(identityRegistryId === undefined ? {} : { identityRegistryId }),
        ...(membershipRegistryId === undefined ? {} : { membershipRegistryId }),
        ...(verifierRegistryId === undefined ? {} : { verifierRegistryId }),
    };
}

async function readExistingManifest(
    outputDir: string,
): Promise<MembershipIdentityFixtureManifest | undefined> {
    try {
        const parsed = JSON.parse(
            await readFile(path.join(outputDir, FIXTURE_MANIFEST_FILE), "utf8"),
        ) as unknown;
        if (!isRecord(parsed) || parsed.schema !== "sonari.membership_identity.testnet_fixture") {
            throw new Error("existing manifest has an unexpected schema");
        }
        return parsed as unknown as MembershipIdentityFixtureManifest;
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

async function readPublishedTomlPackageId(env: FixtureNetwork): Promise<string | undefined> {
    try {
        return parsePublishedTomlPackageId(await readFile("contracts/Published.toml", "utf8"), env);
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

async function writeFixtureFiles(
    outputDir: string,
    files: MembershipIdentityFixtureFiles,
): Promise<void> {
    await mkdir(outputDir, { recursive: true });
    await Promise.all([
        writeFile(path.join(outputDir, FIXTURE_MANIFEST_FILE), files.manifestJson),
        writeFile(path.join(outputDir, FIXTURE_ENV_FILE), files.envFile),
        writeFile(
            path.join(outputDir, FIXTURE_DUMMY_WORLD_ID_REQUEST_FILE),
            files.dummyWorldIdRequestJson,
        ),
    ]);
}

async function executeSuiCommand(plan: SuiCommandPlan): Promise<SuiCommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(plan.command, plan.args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
            resolve({ code: code ?? 1, stdout, stderr });
        });
    });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

function parsePublishedPackageId(input: unknown): string {
    for (const change of readObjectChanges(input)) {
        if (!isRecord(change)) {
            continue;
        }
        if (change.type === "published" && typeof change.packageId === "string") {
            assertHexObjectId(change.packageId, "published.packageId");
            return change.packageId;
        }
        if (change.type === "published" && typeof change.package_id === "string") {
            assertHexObjectId(change.package_id, "published.package_id");
            return change.package_id;
        }
    }
    throw new Error("publish result did not include published package id");
}

async function publishBaseFixtureObjects(
    options: SuiClientOptions,
    executor: SuiCommandExecutor,
): Promise<MembershipIdentityFixtureBaseObjects> {
    const output = await executor(buildSuiPublishCommand(options));
    const parsed = parseSuiJsonCommandResult(output, "sui publish");
    return parsePublishFixtureObjects(parsed);
}

async function verifyBaseObjectReadbacks(
    objects: MembershipIdentityFixtureBaseObjects,
    options: SuiClientOptions,
    executor: SuiCommandExecutor,
): Promise<void> {
    await verifyObjectType(objects.adminCapId, EXPECTED_OBJECT_TYPES.adminCap, "adminCapId");
    await verifyObjectType(objects.pauseStateId, EXPECTED_OBJECT_TYPES.pauseState, "pauseStateId");
    await verifyObjectType(
        objects.identityRegistryId,
        EXPECTED_OBJECT_TYPES.identityRegistry,
        "identityRegistryId",
    );
    await verifyObjectType(
        objects.membershipRegistryId,
        EXPECTED_OBJECT_TYPES.membershipRegistry,
        "membershipRegistryId",
    );
    await verifyObjectType(
        objects.verifierRegistryId,
        EXPECTED_OBJECT_TYPES.verifierRegistry,
        "verifierRegistryId",
    );

    async function verifyObjectType(
        objectId: string,
        expectedType: string,
        fieldName: string,
    ): Promise<void> {
        const output = await executor(buildSuiObjectCommand(objectId, options));
        const parsed = parseSuiJsonCommandResult(output, `sui object ${fieldName}`);
        const object = parseSuiObjectReadback(parsed);
        assertSuiObjectType(
            object,
            expectedPackageType(objects.packageId, expectedType),
            fieldName,
        );
    }
}

function completeBaseObjectCandidates(
    candidates: MembershipIdentityFixtureBaseObjectCandidates,
): MembershipIdentityFixtureBaseObjects {
    return {
        packageId: requiredCandidate(candidates.packageId, "packageId"),
        adminCapId: requiredCandidate(candidates.adminCapId, "adminCapId"),
        pauseStateId: requiredCandidate(candidates.pauseStateId, "pauseStateId"),
        identityRegistryId: requiredCandidate(candidates.identityRegistryId, "identityRegistryId"),
        membershipRegistryId: requiredCandidate(
            candidates.membershipRegistryId,
            "membershipRegistryId",
        ),
        verifierRegistryId: requiredCandidate(candidates.verifierRegistryId, "verifierRegistryId"),
    };
}

function missingBaseObjectFields(
    candidates: MembershipIdentityFixtureBaseObjectCandidates,
): string[] {
    const missing: string[] = [];
    if (candidates.packageId === undefined) {
        missing.push("packageId");
    }
    if (candidates.adminCapId === undefined) {
        missing.push("adminCapId");
    }
    if (candidates.pauseStateId === undefined) {
        missing.push("pauseStateId");
    }
    if (candidates.identityRegistryId === undefined) {
        missing.push("identityRegistryId");
    }
    if (candidates.membershipRegistryId === undefined) {
        missing.push("membershipRegistryId");
    }
    if (candidates.verifierRegistryId === undefined) {
        missing.push("verifierRegistryId");
    }
    return missing;
}

function requiredCandidate(value: string | undefined, fieldName: string): string {
    if (value === undefined) {
        throw new Error(`missing required fixture candidate: ${fieldName}`);
    }
    assertHexObjectId(value, fieldName);
    return value;
}

function expectedPackageType(packageId: string, typeSuffix: string): string {
    assertHexObjectId(packageId, "packageId");
    return `${packageId}${typeSuffix}`;
}

function parseCreatedObjectId(input: unknown, expectedType: string, name: string): string {
    for (const change of readObjectChanges(input)) {
        if (!isRecord(change)) {
            continue;
        }
        const objectType = change.objectType ?? change.object_type;
        const objectId = change.objectId ?? change.object_id;
        if (objectType === expectedType) {
            if (typeof objectId !== "string") {
                throw new Error(`${name} object change did not include object id`);
            }
            assertHexObjectId(objectId, name);
            return objectId;
        }
    }
    throw new Error(`publish result did not include ${name}`);
}

function parseGenesisObjectIds(input: unknown): Map<number, string> {
    const ids = new Map<number, string>();
    for (const event of readEvents(input)) {
        if (!eventTypeIncludes(event, "::admin::GenesisObjectCreated")) {
            continue;
        }
        const parsedJson = readParsedJson(event);
        const objectKind = parsedJson.object_kind ?? parsedJson.objectKind;
        const objectId = parsedJson.object_id ?? parsedJson.objectId;
        if (typeof objectKind !== "number" || typeof objectId !== "string") {
            throw new Error("GenesisObjectCreated event is missing object_kind or object_id");
        }
        assertHexObjectId(objectId, "GenesisObjectCreated.object_id");
        ids.set(objectKind, objectId);
    }
    return ids;
}

function readEvents(input: unknown): readonly Record<string, unknown>[] {
    const events = isRecord(input) && Array.isArray(input.events) ? input.events : [];
    return events.filter(isRecord);
}

function readObjectChanges(input: unknown): readonly unknown[] {
    return isRecord(input) && Array.isArray(input.objectChanges) ? input.objectChanges : [];
}

function readParsedJson(event: Record<string, unknown>): Record<string, unknown> {
    if (isRecord(event.parsedJson)) {
        return event.parsedJson;
    }
    throw new Error("Sui event did not include parsedJson");
}

function eventTypeIncludes(event: Record<string, unknown>, suffix: string): boolean {
    return typeof event.type === "string" && event.type.endsWith(suffix);
}

function stringField(
    record: Record<string, unknown>,
    names: readonly string[],
    label: string,
): string {
    for (const name of names) {
        const value = record[name];
        if (typeof value === "string") {
            return value;
        }
    }
    throw new Error(`sui object JSON did not include ${label}`);
}

function readStringField(record: Record<string, unknown>, name: string): string {
    const value = record[name];
    if (typeof value === "string") {
        return value;
    }
    throw new Error(`sui object field ${name} must be a string`);
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
    const options = parseCliArgs(process.argv.slice(2));
    const result = await runMembershipIdentityTestnetFixture(options);
    process.stdout.write(
        `${JSON.stringify(
            {
                ok: true,
                manifest: result.manifestPath,
                env: result.envPath,
                dummy_world_id_request: result.dummyWorldIdRequestPath,
                membership_pass_id: result.manifest.objects.membership_pass_id,
                identity_registry_id: result.manifest.objects.identity_registry_id,
            },
            null,
            2,
        )}\n`,
    );
}

function parseCliArgs(argv: readonly string[]): RunMembershipIdentityTestnetFixtureOptions {
    let env = assertFixtureNetwork(process.env.SONARI_FIXTURE_SUI_ENV ?? "testnet");
    let clientConfig =
        process.env.SUI_CLIENT_CONFIG ?? ".local/sonari-dev/sui_wallets/admin/sui_config.yaml";
    let outputDir = DEFAULT_FIXTURE_OUTPUT_DIR;
    let publishIfMissing = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--sui-env") {
            env = assertFixtureNetwork(requiredArg(argv, index, "--sui-env"));
            index += 1;
            continue;
        }
        if (arg === "--sui-config") {
            clientConfig = requiredArg(argv, index, "--sui-config");
            index += 1;
            continue;
        }
        if (arg === "--output-dir") {
            outputDir = requiredArg(argv, index, "--output-dir");
            index += 1;
            continue;
        }
        if (arg === "--publish-if-missing") {
            publishIfMissing = true;
            continue;
        }
        if (arg === "--") {
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            process.stdout.write(cliUsage());
            process.exit(0);
        }
        throw new Error(`unknown arg: ${arg}`);
    }

    return {
        env,
        clientConfig,
        outputDir,
        publishIfMissing,
    };
}

function requiredArg(argv: readonly string[], index: number, flag: string): string {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function cliUsage(): string {
    return [
        "Usage:",
        "  pnpm identity:testnet-fixture [--sui-env testnet] [--sui-config <path>] [--output-dir <path>] [--publish-if-missing]",
        "",
        "Outputs:",
        `  ${path.join(DEFAULT_FIXTURE_OUTPUT_DIR, FIXTURE_MANIFEST_FILE)}`,
        `  ${path.join(DEFAULT_FIXTURE_OUTPUT_DIR, FIXTURE_ENV_FILE)}`,
        `  ${path.join(DEFAULT_FIXTURE_OUTPUT_DIR, FIXTURE_DUMMY_WORLD_ID_REQUEST_FILE)}`,
        "",
    ].join("\n");
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
