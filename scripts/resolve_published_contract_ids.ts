import { appendFile, readFile } from "node:fs/promises";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const QUERY_EVENTS_PAGE_LIMIT = 50;

export const GENESIS_OBJECT_KIND = {
    adminCap: 1,
    pauseState: 2,
    mainPool: 3,
    membershipRegistry: 6,
    verifierRegistry: 7,
    identityRegistry: 9,
    categoryRegistry: 10,
    earthquakePool: 11,
    allowedResidenceCellRegistry: 13,
    cellCountIndex: 14,
} as const;

const GENESIS_OUTPUTS = [
    ["SONARI_ADMIN_CAP_ID", GENESIS_OBJECT_KIND.adminCap],
    ["SONARI_IDENTITY_PAUSE_STATE_ID", GENESIS_OBJECT_KIND.pauseState],
    ["SONARI_FLOOR_CENSUS_PAUSE_STATE", GENESIS_OBJECT_KIND.pauseState],
    ["SONARI_FLOOR_CENSUS_MAIN_POOL", GENESIS_OBJECT_KIND.mainPool],
    ["SONARI_MEMBERSHIP_REGISTRY_ID", GENESIS_OBJECT_KIND.membershipRegistry],
    ["SONARI_VERIFIER_REGISTRY_ID", GENESIS_OBJECT_KIND.verifierRegistry],
    ["SONARI_IDENTITY_REGISTRY_ID", GENESIS_OBJECT_KIND.identityRegistry],
    ["SONARI_CATEGORY_REGISTRY_ID", GENESIS_OBJECT_KIND.categoryRegistry],
    ["SONARI_EARTHQUAKE_CATEGORY_POOL_ID", GENESIS_OBJECT_KIND.earthquakePool],
    ["SONARI_FLOOR_CENSUS_CATEGORY_POOL", GENESIS_OBJECT_KIND.earthquakePool],
    [
        "SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID",
        GENESIS_OBJECT_KIND.allowedResidenceCellRegistry,
    ],
    ["SONARI_CELL_COUNT_INDEX_ID", GENESIS_OBJECT_KIND.cellCountIndex],
] as const;

export interface EventCursor {
    readonly txDigest: string;
    readonly eventSeq: string;
}

export interface QueryEventsClient {
    queryEvents(input: {
        readonly query: { readonly MoveEventType: string };
        readonly cursor?: EventCursor | null;
        readonly limit?: number;
        readonly order?: "ascending" | "descending";
    }): Promise<{
        readonly data: readonly unknown[];
        readonly hasNextPage?: boolean;
        readonly nextCursor?: EventCursor | null;
    }>;
}

export interface ResolvePublishedContractIdsInput {
    readonly publishedToml: string;
    readonly network: string;
    readonly client: QueryEventsClient;
}

export interface ResolvedPublishedContractIds {
    readonly packageId: string;
    readonly env: Readonly<Record<string, string>>;
}

interface GenesisObjectCreatedRecord {
    readonly objectId: string;
    readonly objectKind: number;
}

interface RegistryCreatedRecord {
    readonly registryId: string;
}

export function readPublishedPackageId(input: string, network: string): string {
    const normalizedNetwork = normalizeNetwork(network);
    const section = new RegExp(
        `\\[published\\.${escapeRegExp(normalizedNetwork)}\\]([\\s\\S]*?)(?:\\n\\[|$)`,
    ).exec(input)?.[1];
    const publishedAt =
        section === undefined ? undefined : /^\s*published-at\s*=\s*"([^"]+)"/m.exec(section)?.[1];
    if (publishedAt === undefined || parseObjectId(publishedAt) === null) {
        throw new Error(
            `contracts/Published.toml is missing a valid published-at for [published.${normalizedNetwork}]`,
        );
    }
    return publishedAt;
}

export async function resolvePublishedContractIds(
    input: ResolvePublishedContractIdsInput,
): Promise<ResolvedPublishedContractIds> {
    const packageId = readPublishedPackageId(input.publishedToml, input.network);
    const genesisObjects = await readGenesisObjects(input.client, packageId);
    const env: Record<string, string> = {
        SONARI_IDENTITY_PACKAGE_ID: packageId,
        RELAYER_TARGET: `${packageId}::accessor::create_disaster_event_and_campaign_from_signed_payload`,
        FLOOR_CENSUS_TARGET: `${packageId}::accessor::set_floor_census`,
    };

    for (const [name, objectKind] of GENESIS_OUTPUTS) {
        const objectId = genesisObjects.get(objectKind);
        if (objectId === undefined) {
            throw new Error(`GenesisObjectCreated event is missing object kind ${objectKind}`);
        }
        env[name] = objectId;
    }
    env.RELAYER_VERIFIER_REGISTRY = requireEnvValue(env, "SONARI_VERIFIER_REGISTRY_ID");
    env.RELAYER_CATEGORY_REGISTRY = requireEnvValue(env, "SONARI_CATEGORY_REGISTRY_ID");
    env.RELAYER_CATEGORY_POOL = requireEnvValue(env, "SONARI_EARTHQUAKE_CATEGORY_POOL_ID");
    env.FLOOR_CENSUS_PAUSE_STATE = requireEnvValue(env, "SONARI_FLOOR_CENSUS_PAUSE_STATE");
    env.FLOOR_CENSUS_MAIN_POOL = requireEnvValue(env, "SONARI_FLOOR_CENSUS_MAIN_POOL");
    env.FLOOR_CENSUS_CATEGORY_POOL = requireEnvValue(env, "SONARI_FLOOR_CENSUS_CATEGORY_POOL");

    env.RELAYER_REGISTRY = await readSingleRegistryCreatedEvent(
        input.client,
        `${packageId}::disaster_event::DisasterRegistryCreated`,
        "DisasterRegistryCreated",
    );

    return { packageId, env };
}

export function parseGenesisObjectCreatedEvent(raw: unknown): GenesisObjectCreatedRecord {
    const parsedJson = readParsedJson(raw);
    const objectId = parseObjectId(parsedJson.object_id);
    const objectKind = parseU8(parsedJson.object_kind);
    if (objectId === null || objectKind === null) {
        throw new Error("GenesisObjectCreated event is malformed");
    }
    return { objectId, objectKind };
}

export function parseRegistryCreatedEvent(raw: unknown, eventName: string): RegistryCreatedRecord {
    const parsedJson = readParsedJson(raw);
    const registryId = parseObjectId(parsedJson.registry_id);
    if (registryId === null) {
        throw new Error(`${eventName} event is malformed`);
    }
    return { registryId };
}

async function readGenesisObjects(
    client: QueryEventsClient,
    packageId: string,
): Promise<ReadonlyMap<number, string>> {
    const records = await readMoveEvents(client, `${packageId}::admin::GenesisObjectCreated`);
    const objects = new Map<number, string>();
    for (const record of records.map(parseGenesisObjectCreatedEvent)) {
        if (objects.has(record.objectKind)) {
            throw new Error(`GenesisObjectCreated has duplicate object kind ${record.objectKind}`);
        }
        objects.set(record.objectKind, record.objectId);
    }
    return objects;
}

async function readSingleRegistryCreatedEvent(
    client: QueryEventsClient,
    eventType: string,
    eventName: string,
): Promise<string> {
    const records = await readMoveEvents(client, eventType);
    const registryIds = records.map(
        (record) => parseRegistryCreatedEvent(record, eventName).registryId,
    );
    if (registryIds.length !== 1) {
        throw new Error(`${eventName} must resolve to exactly one registry id`);
    }
    const registryId = registryIds[0];
    if (registryId === undefined) {
        throw new Error(`${eventName} must resolve to exactly one registry id`);
    }
    return registryId;
}

async function readMoveEvents(
    client: QueryEventsClient,
    eventType: string,
): Promise<readonly unknown[]> {
    const records: unknown[] = [];
    let cursor: EventCursor | null | undefined;
    for (;;) {
        const response = await client.queryEvents({
            query: { MoveEventType: eventType },
            ...(cursor !== undefined ? { cursor } : {}),
            limit: QUERY_EVENTS_PAGE_LIMIT,
            order: "descending",
        });
        records.push(...response.data);
        if (response.hasNextPage !== true || response.nextCursor == null) {
            return records;
        }
        cursor = response.nextCursor;
    }
}

function readParsedJson(raw: unknown): Record<string, unknown> {
    if (!isRecord(raw) || !isRecord(raw.parsedJson)) {
        throw new Error("Sui event did not include parsedJson");
    }
    return raw.parsedJson;
}

function normalizeNetwork(raw: string): string {
    return raw.trim() || "testnet";
}

function parseObjectId(raw: unknown): string | null {
    if (typeof raw !== "string") {
        return null;
    }
    const trimmed = raw.trim();
    return /^0x[0-9a-fA-F]{64}$/u.test(trimmed) ? trimmed : null;
}

function parseU8(raw: unknown): number | null {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 255) {
        return null;
    }
    return raw;
}

function requireEnvValue(env: Readonly<Record<string, string>>, name: string): string {
    const value = env[name];
    if (value === undefined) {
        throw new Error(`${name} was not resolved`);
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function defaultRpcUrl(network: string): string {
    switch (normalizeNetwork(network)) {
        case "mainnet":
            return "https://fullnode.mainnet.sui.io:443";
        case "localnet":
            return "http://127.0.0.1:9000";
        default:
            return "https://fullnode.testnet.sui.io:443";
    }
}

function parseArgs(argv: readonly string[]): {
    readonly network: string;
    readonly publishedTomlPath: string;
    readonly rpcUrl: string;
} {
    let network = process.env.SONARI_SUI_NETWORK ?? "testnet";
    let publishedTomlPath = "contracts/Published.toml";
    let rpcUrl = process.env.SUI_RPC_URL ?? "";
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--network" && next !== undefined) {
            network = next;
            i += 1;
            continue;
        }
        if (arg === "--published-toml" && next !== undefined) {
            publishedTomlPath = next;
            i += 1;
            continue;
        }
        if (arg === "--rpc-url" && next !== undefined) {
            rpcUrl = next;
            i += 1;
            continue;
        }
        throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
    return {
        network: normalizeNetwork(network),
        publishedTomlPath,
        rpcUrl: rpcUrl.trim() || defaultRpcUrl(network),
    };
}

async function runCli(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const publishedToml = await readFile(args.publishedTomlPath, "utf8");
    const result = await resolvePublishedContractIds({
        publishedToml,
        network: args.network,
        client: new SuiJsonRpcClient({ network: args.network, url: args.rpcUrl }),
    });
    const lines = Object.entries(result.env)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${value}`);
    const output = `${lines.join("\n")}\n`;
    if (process.env.GITHUB_ENV !== undefined && process.env.GITHUB_ENV !== "") {
        await appendFile(process.env.GITHUB_ENV, output, "utf8");
    }
    process.stdout.write(output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runCli().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}
