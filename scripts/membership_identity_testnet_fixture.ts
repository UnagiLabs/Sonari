import { pathToFileURL } from "node:url";

export const DEFAULT_FIXTURE_OUTPUT_DIR = ".local/sonari-dev/membership-identity-fixture";
export const FIXTURE_MANIFEST_FILE = "manifest.json";
export const FIXTURE_ENV_FILE = "fixture.env";
export const FIXTURE_DUMMY_WORLD_ID_REQUEST_FILE = "dummy-world-id-request.json";
export const DEFAULT_TERMS_VERSION = 1;
export const DEFAULT_SIGNED_STATEMENT_HASH = `0x${"44".repeat(32)}`;
export const DEFAULT_WORLD_ID_SIGNAL_HASH = `0x${"55".repeat(32)}`;
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
    expectedSuffix: string,
    fieldName: string,
): void {
    if (!object.type.endsWith(expectedSuffix)) {
        throw new Error(`${fieldName} must be ${expectedSuffix}, got ${object.type}`);
    }
}

export function parsePublishFixtureObjects(input: unknown): SuiPublishFixtureObjects {
    const packageId = parsePublishedPackageId(input);
    const adminCapId = parseCreatedObjectId(input, EXPECTED_OBJECT_TYPES.adminCap, "AdminCap");
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
        assertSuiObjectType(object, expectedType, fieldName);
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

function parseCreatedObjectId(input: unknown, typeSuffix: string, name: string): string {
    for (const change of readObjectChanges(input)) {
        if (!isRecord(change)) {
            continue;
        }
        const objectType = change.objectType ?? change.object_type;
        const objectId = change.objectId ?? change.object_id;
        if (typeof objectType === "string" && objectType.endsWith(typeSuffix)) {
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

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
