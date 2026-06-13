/**
 * Sonari Move contract republish bootstrap — pure functions.
 *
 * issue #361: #349/PR#360 で claim の ABI が破壊的に変わったため、Sui の互換アップグレードでは
 * 公開関数を削除できない。よって新 package として publish し直し、全オブジェクト ID を張替える。
 *
 * 決定的な pure function に加えて、注入された executor で `sui` を実行する orchestration を持つ。
 * executor を差し替えればテストでき、`--dry-run` 既定で誤実行を防ぐ。実際の `gh` 設定や World ID
 * portal 操作はこの外（手順書 / 別 step）で行う。
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
    assertFixtureNetwork,
    buildSuiCallCommand,
    buildSuiPublishCommand,
    type FixtureNetwork,
    parseAllowedResidenceCellRegistryId,
    parseSuiJsonCommandResult,
    type SuiClientOptions,
    type SuiCommandExecutor,
    type SuiCommandPlan,
    type SuiCommandResult,
} from "./membership_identity_testnet_fixture.js";

// ---------------------------------------------------------------------------
// Genesis kinds — contracts/sources/admin.move の定数と必ず一致させる契約値。
// admin::initialize が publish 時に emit する種別。kind 8 は欠番。
// ---------------------------------------------------------------------------
export const GENESIS_KIND = {
    ADMIN_CAP: 1,
    PAUSE_STATE: 2,
    MAIN_POOL: 3,
    OPERATIONS_POOL: 4,
    DONOR_REGISTRY: 5,
    MEMBERSHIP_REGISTRY: 6,
    VERIFIER_REGISTRY: 7,
    IDENTITY_REGISTRY: 9,
    CATEGORY_REGISTRY: 10,
    EARTHQUAKE_POOL: 11,
} as const;

// ---------------------------------------------------------------------------
// GitHub 設定の張替え先スコープ。
// ---------------------------------------------------------------------------
export const GH_SCOPE = {
    /** repository-level Variables（共有 env の単一情報源）。 */
    REPO: "repo",
    /** environment `aws-sonari-verifier-runner-dev`。deploy job が environment 指定で参照する実効スコープ。 */
    ENV_AWS_DEV: "env:aws-sonari-verifier-runner-dev",
} as const;

export type GhScope = (typeof GH_SCOPE)[keyof typeof GH_SCOPE];

/** 新しい object ID を 1 つの GitHub 設定へ張替える指示。 */
export interface GhSettingAssignment {
    /** GitHub Variables / Secrets の名前。 */
    readonly name: string;
    /** 設定する値。 */
    readonly value: string;
    /** 設定するスコープ。両スコープに存在する変数は両方へ設定して整合を保つ。 */
    readonly scopes: readonly GhScope[];
    /** Secrets なら true、Variables なら false。 */
    readonly secret: boolean;
    /** 値の由来。レビューと手順書のための来歴情報。 */
    readonly source: string;
}

/** 本 issue では張替えないが、新 publish に存在することを確認する genesis object。 */
export interface GenesisCrossCheck {
    readonly objectKind: number;
    readonly label: string;
    readonly objectId: string;
    readonly note: string;
}

/** buildSettingsAssignments の出力。張替え対象と cross-check を分離して返す。 */
export interface SettingsPlan {
    readonly assignments: readonly GhSettingAssignment[];
    readonly crossChecks: readonly GenesisCrossCheck[];
}

/** buildSettingsAssignments の入力。 */
export interface RewireInput {
    /** 新 publish の package id。 */
    readonly packageId: string;
    /** parseGenesisObjectIds の結果。 */
    readonly genesisObjectIds: ReadonlyMap<number, string>;
    /** 後付けで作成した DisasterRegistry の object id。 */
    readonly disasterRegistryId: string;
    /** 後付けで作成した AllowedResidenceCellRegistry の object id（実 root で作成）。 */
    readonly allowedResidenceCellRegistryId: string;
}

// ---------------------------------------------------------------------------
// 1. publish 結果から genesis object id を取り出す。
// ---------------------------------------------------------------------------
export function parseGenesisObjectIds(input: unknown): Map<number, string> {
    const ids = new Map<number, string>();
    const events = isRecord(input) && Array.isArray(input.events) ? input.events : [];
    for (const event of events) {
        if (!isRecord(event)) {
            continue;
        }
        if (
            typeof event.type !== "string" ||
            !event.type.endsWith("::admin::GenesisObjectCreated")
        ) {
            continue;
        }
        if (!isRecord(event.parsedJson)) {
            throw new Error("GenesisObjectCreated event is missing parsedJson");
        }
        const objectKind = event.parsedJson.object_kind ?? event.parsedJson.objectKind;
        const objectId = event.parsedJson.object_id ?? event.parsedJson.objectId;
        if (typeof objectKind !== "number" || typeof objectId !== "string") {
            throw new Error("GenesisObjectCreated event is missing object_kind or object_id");
        }
        assertHexObjectId(objectId, "GenesisObjectCreated.object_id");
        ids.set(objectKind, objectId);
    }
    return ids;
}

// ---------------------------------------------------------------------------
// 2. 新しい object id を GitHub 設定へ張替える計画を作る。
// ---------------------------------------------------------------------------
export function buildSettingsAssignments(input: RewireInput): SettingsPlan {
    assertHexObjectId(input.packageId, "packageId");
    assertHexObjectId(input.disasterRegistryId, "disasterRegistryId");
    assertHexObjectId(input.allowedResidenceCellRegistryId, "allowedResidenceCellRegistryId");

    // publish が emit するはずの genesis をすべて取得（欠けていれば fail-closed）。
    const id = (kind: number, label: string): string =>
        requireGenesisId(input.genesisObjectIds, kind, label);
    const adminCap = id(GENESIS_KIND.ADMIN_CAP, "AdminCap(kind=1)");
    const pauseState = id(GENESIS_KIND.PAUSE_STATE, "PauseState(kind=2)");
    const mainPool = id(GENESIS_KIND.MAIN_POOL, "MainPool(kind=3)");
    const operationsPool = id(GENESIS_KIND.OPERATIONS_POOL, "OperationsPool(kind=4)");
    const donorRegistry = id(GENESIS_KIND.DONOR_REGISTRY, "DonorRegistry(kind=5)");
    const membershipRegistry = id(GENESIS_KIND.MEMBERSHIP_REGISTRY, "MembershipRegistry(kind=6)");
    const verifierRegistry = id(GENESIS_KIND.VERIFIER_REGISTRY, "VerifierRegistry(kind=7)");
    const identityRegistry = id(GENESIS_KIND.IDENTITY_REGISTRY, "IdentityRegistry(kind=9)");
    const categoryRegistry = id(GENESIS_KIND.CATEGORY_REGISTRY, "CategoryRegistry(kind=10)");
    const earthquakePool = id(GENESIS_KIND.EARTHQUAKE_POOL, "EarthquakePool(kind=11)");

    const repo: readonly GhScope[] = [GH_SCOPE.REPO];
    const repoAndEnv: readonly GhScope[] = [GH_SCOPE.REPO, GH_SCOPE.ENV_AWS_DEV];

    const assignments: GhSettingAssignment[] = [
        // genesis（init が emit）
        {
            name: "SONARI_ADMIN_CAP_ID",
            value: adminCap,
            scopes: repo,
            secret: false,
            source: "genesis:AdminCap(kind=1)",
        },
        {
            name: "SONARI_IDENTITY_PAUSE_STATE_ID",
            value: pauseState,
            scopes: repo,
            secret: false,
            source: "genesis:PauseState(kind=2)",
        },
        {
            name: "SONARI_FLOOR_CENSUS_PAUSE_STATE",
            value: pauseState,
            scopes: repo,
            secret: false,
            source: "genesis:PauseState(kind=2)",
        },
        {
            name: "SONARI_FLOOR_CENSUS_MAIN_POOL",
            value: mainPool,
            scopes: repo,
            secret: false,
            source: "genesis:MainPool(kind=3)",
        },
        {
            name: "SONARI_MEMBERSHIP_REGISTRY_ID",
            value: membershipRegistry,
            scopes: repo,
            secret: false,
            source: "genesis:MembershipRegistry(kind=6)",
        },
        {
            name: "SONARI_VERIFIER_REGISTRY_ID",
            value: verifierRegistry,
            scopes: repo,
            secret: false,
            source: "genesis:VerifierRegistry(kind=7)",
        },
        {
            name: "AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_VERIFIER_REGISTRY",
            value: verifierRegistry,
            scopes: repoAndEnv,
            secret: false,
            source: "genesis:VerifierRegistry(kind=7)",
        },
        {
            name: "SONARI_IDENTITY_REGISTRY_ID",
            value: identityRegistry,
            scopes: repo,
            secret: false,
            source: "genesis:IdentityRegistry(kind=9)",
        },
        {
            name: "SONARI_CATEGORY_REGISTRY_ID",
            value: categoryRegistry,
            scopes: repo,
            secret: false,
            source: "genesis:CategoryRegistry(kind=10)",
        },
        {
            name: "SONARI_EARTHQUAKE_CATEGORY_POOL_ID",
            value: earthquakePool,
            scopes: repo,
            secret: false,
            source: "genesis:EarthquakePool(kind=11)",
        },
        {
            name: "SONARI_FLOOR_CENSUS_CATEGORY_POOL",
            value: earthquakePool,
            scopes: repo,
            secret: false,
            source: "genesis:EarthquakePool(kind=11)",
        },
        // 後付けオブジェクト
        {
            name: "AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_REGISTRY",
            value: input.disasterRegistryId,
            scopes: repoAndEnv,
            secret: false,
            source: "afterTheFact:DisasterRegistry",
        },
        {
            name: "SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID",
            value: input.allowedResidenceCellRegistryId,
            scopes: repo,
            secret: false,
            source: "afterTheFact:AllowedResidenceCellRegistry",
        },
        // package id から導出
        {
            name: "SONARI_FLOOR_CENSUS_TARGET",
            value: `${input.packageId}::accessor::set_floor_census`,
            scopes: repo,
            secret: false,
            source: "derived:package",
        },
    ];

    const crossChecks: GenesisCrossCheck[] = [
        {
            objectKind: GENESIS_KIND.OPERATIONS_POOL,
            label: "OperationsPool",
            objectId: operationsPool,
            note: "#350 / dapp スコープ。本 issue では張替えない（存在確認のみ）。",
        },
        {
            objectKind: GENESIS_KIND.DONOR_REGISTRY,
            label: "DonorRegistry",
            objectId: donorRegistry,
            note: "#350 / dapp スコープ。本 issue では張替えない（存在確認のみ）。",
        },
    ];

    return { assignments, crossChecks };
}

// ---------------------------------------------------------------------------
// 3. World ID action の形式検証（dapp-deploy と同一仕様）。
// ---------------------------------------------------------------------------
const WORLD_ID_ACTION_PATTERN = /^sonari_membership_register_v[0-9]+$/;

export function assertWorldIdActionFormat(action: string): void {
    if (!WORLD_ID_ACTION_PATTERN.test(action)) {
        throw new Error(
            `World ID action must match ${WORLD_ID_ACTION_PATTERN.source}: got "${action}"`,
        );
    }
}

// ---------------------------------------------------------------------------
// 4. Published.toml の published-at / original-id を新 package id へ書換える。
//    再 publish（アップグレードではない）なので original-id も新 id と一致させる。
//    対象 env のセクション内だけを書換え、他 env を巻き込まない。
// ---------------------------------------------------------------------------
export function rewritePublishedTomlPackageId(
    toml: string,
    env: string,
    newPackageId: string,
): string {
    assertHexObjectId(newPackageId, "newPackageId");

    const sectionHeader = `[published.${env}]`;
    const headerIndex = toml.indexOf(sectionHeader);
    if (headerIndex === -1) {
        throw new Error(`Published.toml does not contain section ${sectionHeader}`);
    }
    const bodyStart = headerIndex + sectionHeader.length;
    // 次のセクション見出し（行頭の "[..."）までを対象 env の本文とする。
    const nextSection = toml.slice(bodyStart).search(/\n\[/);
    const bodyEnd = nextSection === -1 ? toml.length : bodyStart + nextSection;

    const head = toml.slice(0, bodyStart);
    let body = toml.slice(bodyStart, bodyEnd);
    const tail = toml.slice(bodyEnd);

    body = replaceTomlField(body, "published-at", newPackageId, sectionHeader);
    body = replaceTomlField(body, "original-id", newPackageId, sectionHeader);

    return head + body + tail;
}

function replaceTomlField(
    body: string,
    field: string,
    value: string,
    sectionHeader: string,
): string {
    const pattern = new RegExp(`^(\\s*${field}\\s*=\\s*)"[^"]*"`, "m");
    if (!pattern.test(body)) {
        throw new Error(`Published.toml section ${sectionHeader} does not contain field ${field}`);
    }
    return body.replace(pattern, `$1"${value}"`);
}

// ---------------------------------------------------------------------------
// 5. publish 結果のパース（package id / DisasterRegistry id）。
// ---------------------------------------------------------------------------
export function parsePublishedPackageId(input: unknown): string {
    const changes =
        isRecord(input) && Array.isArray(input.objectChanges) ? input.objectChanges : [];
    for (const change of changes) {
        if (!isRecord(change) || change.type !== "published") {
            continue;
        }
        const packageId = change.packageId ?? change.package_id;
        if (typeof packageId !== "string") {
            throw new Error("publish result published change did not include packageId");
        }
        assertHexObjectId(packageId, "packageId");
        return packageId;
    }
    throw new Error("publish result did not include a published package");
}

export function parseDisasterRegistryId(input: unknown): string {
    const events = isRecord(input) && Array.isArray(input.events) ? input.events : [];
    for (const event of events) {
        if (!isRecord(event)) {
            continue;
        }
        if (
            typeof event.type !== "string" ||
            !event.type.endsWith("::disaster_event::DisasterRegistryCreated")
        ) {
            continue;
        }
        if (!isRecord(event.parsedJson)) {
            throw new Error("DisasterRegistryCreated event is missing parsedJson");
        }
        const registryId = event.parsedJson.registry_id ?? event.parsedJson.registryId;
        if (typeof registryId !== "string") {
            throw new Error("DisasterRegistryCreated event is missing registry_id");
        }
        assertHexObjectId(registryId, "DisasterRegistryCreated.registry_id");
        return registryId;
    }
    throw new Error("transaction result did not include DisasterRegistryCreated event");
}

// ---------------------------------------------------------------------------
// 6. secret の漏洩防止。command 引数への混入は fail-closed、出力は伏字化。
// ---------------------------------------------------------------------------
const REDACTION = "***REDACTED***";

export function guardSecrets(
    plans: readonly SuiCommandPlan[],
    secrets: readonly string[] | undefined,
): void {
    const active = (secrets ?? []).filter((s) => s.trim().length > 0);
    if (active.length === 0) {
        return;
    }
    for (const plan of plans) {
        for (const arg of plan.args) {
            for (const secret of active) {
                if (arg.includes(secret)) {
                    throw new Error(
                        "refusing to run: a secret value would appear in a sui command argument",
                    );
                }
            }
        }
    }
}

export function redactSecrets(text: string, secrets: readonly string[] | undefined): string {
    let out = text;
    for (const secret of (secrets ?? []).filter((s) => s.trim().length > 0)) {
        out = out.split(secret).join(REDACTION);
    }
    return out;
}

// ---------------------------------------------------------------------------
// 7. orchestration: 注入 executor で publish と後付けオブジェクト作成を実行する。
//    dryRun=true（既定）では executor を呼ばず、最初に実行する publish 計画だけ返す。
// ---------------------------------------------------------------------------
export interface RepublishBootstrapOptions {
    /** `.local/sonari-dev/sui_wallets/admin` 配下の sui client config パス。 */
    readonly clientConfig: string;
    readonly env: FixtureNetwork;
    /** 現在の Published.toml の中身。 */
    readonly publishedToml: string;
    /** 実 residence root（hex32）。golden root を使うと register_member が abort 0 する。 */
    readonly residenceRoot: string;
    readonly residenceGeoResolution: string;
    readonly residenceAllowlistVersion: string;
    readonly residenceSourceHash: string;
    readonly gasBudget?: string;
    /** true（既定）なら実行せず計画のみ返す。 */
    readonly dryRun: boolean;
    /** command 引数や出力に絶対現れてはいけない値（保険のガード）。 */
    readonly secrets?: readonly string[];
}

export interface RepublishBootstrapResult {
    readonly dryRun: boolean;
    readonly plannedCommands: readonly SuiCommandPlan[];
    readonly packageId?: string;
    readonly genesisObjectIds?: Record<number, string>;
    readonly disasterRegistryId?: string;
    readonly allowedResidenceCellRegistryId?: string;
    readonly settings?: SettingsPlan;
    readonly rewrittenPublishedToml?: string;
}

export async function runRepublishBootstrap(
    options: RepublishBootstrapOptions,
    executor: SuiCommandExecutor,
): Promise<RepublishBootstrapResult> {
    assertHex32(options.residenceRoot, "residenceRoot");
    assertHex32(options.residenceSourceHash, "residenceSourceHash");

    const clientOptions: SuiClientOptions = {
        clientConfig: options.clientConfig,
        env: options.env,
        ...(options.gasBudget ? { gasBudget: options.gasBudget } : {}),
    };

    const publishCommand = buildSuiPublishCommand(clientOptions);
    guardSecrets([publishCommand], options.secrets);

    if (options.dryRun) {
        return { dryRun: true, plannedCommands: [publishCommand] };
    }

    // 1. 新 package を publish
    const publishJson = parseSuiJsonCommandResult(
        await executor(publishCommand),
        "sui client publish",
    );
    const packageId = parsePublishedPackageId(publishJson);
    const genesisObjectIds = parseGenesisObjectIds(publishJson);
    const adminCapId = requireGenesisId(
        genesisObjectIds,
        GENESIS_KIND.ADMIN_CAP,
        "AdminCap(kind=1)",
    );

    // 2. DisasterRegistry を後付け作成
    const disasterCommand = buildSuiCallCommand({
        options: clientOptions,
        packageId,
        module: "admin",
        functionName: "create_disaster_registry",
        args: [adminCapId],
    });
    guardSecrets([disasterCommand], options.secrets);
    const disasterJson = parseSuiJsonCommandResult(
        await executor(disasterCommand),
        "admin::create_disaster_registry",
    );
    const disasterRegistryId = parseDisasterRegistryId(disasterJson);

    // 3. AllowedResidenceCellRegistry を実 root で後付け作成
    const residenceCommand = buildSuiCallCommand({
        options: clientOptions,
        packageId,
        module: "admin",
        functionName: "create_allowed_residence_cell_registry",
        args: [
            adminCapId,
            options.residenceRoot,
            options.residenceGeoResolution,
            options.residenceAllowlistVersion,
            options.residenceSourceHash,
        ],
    });
    guardSecrets([residenceCommand], options.secrets);
    const residenceJson = parseSuiJsonCommandResult(
        await executor(residenceCommand),
        "admin::create_allowed_residence_cell_registry",
    );
    const allowedResidenceCellRegistryId = parseAllowedResidenceCellRegistryId(residenceJson);

    // 4. GitHub 設定計画と新 Published.toml を組み立てる
    const settings = buildSettingsAssignments({
        packageId,
        genesisObjectIds,
        disasterRegistryId,
        allowedResidenceCellRegistryId,
    });
    const rewrittenPublishedToml = rewritePublishedTomlPackageId(
        options.publishedToml,
        options.env,
        packageId,
    );

    return {
        dryRun: false,
        plannedCommands: [publishCommand, disasterCommand, residenceCommand],
        packageId,
        genesisObjectIds: Object.fromEntries(genesisObjectIds),
        disasterRegistryId,
        allowedResidenceCellRegistryId,
        settings,
        rewrittenPublishedToml,
    };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function requireGenesisId(ids: ReadonlyMap<number, string>, kind: number, label: string): string {
    const value = ids.get(kind);
    if (typeof value !== "string") {
        throw new Error(`publish result did not include genesis object ${label}`);
    }
    return value;
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

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
const DEFAULT_CLIENT_CONFIG = ".local/sonari-dev/sui_wallets/admin/client.yaml";
const DEFAULT_PUBLISHED_TOML = "contracts/Published.toml";

function readFlag(argv: readonly string[], name: string): string | undefined {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
}

function requireValue(value: string | undefined, label: string): string {
    if (value === undefined || value.trim().length === 0) {
        throw new Error(`missing required ${label}`);
    }
    return value;
}

async function spawnSuiCommand(plan: SuiCommandPlan): Promise<SuiCommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(plan.command, [...plan.args], { stdio: ["ignore", "pipe", "pipe"] });
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

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const dryRun = !argv.includes("--live");
    const publishedTomlPath = readFlag(argv, "published-toml") ?? DEFAULT_PUBLISHED_TOML;
    const secrets = [process.env.SONARI_DEV_ADMIN_PRIVATE_KEY].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
    );
    const gasBudget = readFlag(argv, "gas-budget");

    const options: RepublishBootstrapOptions = {
        clientConfig:
            readFlag(argv, "client-config") ??
            process.env.SONARI_ADMIN_SUI_CLIENT_CONFIG ??
            DEFAULT_CLIENT_CONFIG,
        env: assertFixtureNetwork(readFlag(argv, "env") ?? "testnet"),
        publishedToml: readFileSync(publishedTomlPath, "utf8"),
        residenceRoot: requireValue(
            readFlag(argv, "residence-root") ?? process.env.SONARI_RESIDENCE_ROOT,
            "--residence-root",
        ),
        residenceGeoResolution: readFlag(argv, "geo-resolution") ?? "9",
        residenceAllowlistVersion: readFlag(argv, "allowlist-version") ?? "1",
        residenceSourceHash: requireValue(
            readFlag(argv, "source-hash") ?? process.env.SONARI_RESIDENCE_SOURCE_HASH,
            "--source-hash",
        ),
        ...(gasBudget ? { gasBudget } : {}),
        dryRun,
        secrets,
    };

    const result = await runRepublishBootstrap(options, spawnSuiCommand);

    if (!dryRun && result.rewrittenPublishedToml) {
        writeFileSync(publishedTomlPath, result.rewrittenPublishedToml);
    }

    const summary = redactSecrets(
        JSON.stringify({ ...result, rewrittenPublishedToml: undefined }, null, 2),
        secrets,
    );
    process.stdout.write(`${summary}\n`);
    if (dryRun) {
        process.stdout.write("dry-run: no sui command was executed. pass --live to publish.\n");
    }
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
