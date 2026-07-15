import { appendFile, readFile } from "node:fs/promises";
import { SuiGraphQLClient } from "@mysten/sui/graphql";

const QUERY_EVENTS_PAGE_LIMIT = 50;
const EVENTS_QUERY = `
    query MoveEvents($type: String!, $last: Int!, $before: String) {
        events(filter: { type: $type }, last: $last, before: $before) {
            nodes {
                contents { json }
            }
            pageInfo {
                hasPreviousPage
                startCursor
            }
        }
    }
`;

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
    ["SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID", GENESIS_OBJECT_KIND.allowedResidenceCellRegistry],
    ["SONARI_CELL_COUNT_INDEX_ID", GENESIS_OBJECT_KIND.cellCountIndex],
] as const;

export interface GraphqlQueryClient {
    query(input: {
        readonly query: string;
        readonly variables: {
            readonly type: string;
            readonly last: number;
            readonly before: string | null;
        };
    }): Promise<unknown>;
}

export interface ResolvePublishedContractIdsInput {
    readonly publishedToml: string;
    readonly network: string;
    readonly client: GraphqlQueryClient;
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
    env.FLOOR_CENSUS_CELL_COUNT_INDEX = requireEnvValue(env, "SONARI_CELL_COUNT_INDEX_ID");
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
    client: GraphqlQueryClient,
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
    client: GraphqlQueryClient,
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
    client: GraphqlQueryClient,
    eventType: string,
): Promise<readonly unknown[]> {
    const records: unknown[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (;;) {
        const response = await client.query({
            query: EVENTS_QUERY,
            variables: {
                type: eventType,
                last: QUERY_EVENTS_PAGE_LIMIT,
                before: cursor,
            },
        });
        const page = parseGraphqlEventPage(response);
        records.push(...page.data);
        if (!page.hasPreviousPage) {
            return records;
        }
        const nextCursor = page.startCursor;
        if (nextCursor === null || seenCursors.has(nextCursor)) {
            throw malformedGraphqlResponse();
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
    }
}

function parseGraphqlEventPage(value: unknown): {
    readonly data: readonly unknown[];
    readonly hasPreviousPage: boolean;
    readonly startCursor: string | null;
} {
    if (!isRecord(value)) {
        throw malformedGraphqlResponse();
    }
    if (value.errors !== undefined) {
        if (!Array.isArray(value.errors)) {
            throw malformedGraphqlResponse();
        }
        if (value.errors.length > 0) {
            const messages = value.errors.map((error) => {
                if (!isRecord(error) || typeof error.message !== "string" || !error.message) {
                    throw malformedGraphqlResponse();
                }
                return error.message;
            });
            throw new Error(`GraphQL event query failed: ${messages.join("; ")}`);
        }
    }
    const events = isRecord(value.data) ? value.data.events : undefined;
    const nodes = isRecord(events) ? events.nodes : undefined;
    const pageInfo = isRecord(events) ? events.pageInfo : undefined;
    if (!Array.isArray(nodes) || !isRecord(pageInfo)) {
        throw malformedGraphqlResponse();
    }
    const hasPreviousPage = pageInfo.hasPreviousPage;
    const startCursor = pageInfo.startCursor;
    if (
        typeof hasPreviousPage !== "boolean" ||
        (startCursor !== null && typeof startCursor !== "string") ||
        (hasPreviousPage && (typeof startCursor !== "string" || startCursor.length === 0))
    ) {
        throw malformedGraphqlResponse();
    }
    return {
        data: nodes.map(parseGraphqlEventNode).reverse(),
        hasPreviousPage,
        startCursor,
    };
}

function parseGraphqlEventNode(value: unknown): { readonly json: Record<string, unknown> } {
    if (!isRecord(value)) {
        throw malformedGraphqlResponse();
    }
    const contents = value.contents;
    if (!isRecord(contents) || !isRecord(contents.json)) {
        throw malformedGraphqlResponse();
    }
    return { json: contents.json };
}

function readParsedJson(raw: unknown): Record<string, unknown> {
    if (!isRecord(raw) || !isRecord(raw.json)) {
        throw new Error("Sui event did not include JSON contents");
    }
    return raw.json;
}

function malformedGraphqlResponse(): Error {
    return new Error("Malformed GraphQL event response");
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

export function defaultGraphqlUrl(network: string): string {
    switch (normalizeNetwork(network)) {
        case "mainnet":
            return "https://graphql.mainnet.sui.io/graphql";
        case "localnet":
            return "http://127.0.0.1:9125/graphql";
        default:
            return "https://graphql.testnet.sui.io/graphql";
    }
}

export function parseResolverArgs(argv: readonly string[]): {
    readonly network: string;
    readonly publishedTomlPath: string;
    readonly graphqlUrl: string;
} {
    let network = process.env.SONARI_SUI_NETWORK ?? "testnet";
    let publishedTomlPath = "contracts/Published.toml";
    let graphqlUrl = process.env.SONARI_SUI_GRAPHQL_URL ?? "";
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
        if (arg === "--graphql-url" && next !== undefined) {
            graphqlUrl = next;
            i += 1;
            continue;
        }
        throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
    return {
        network: normalizeNetwork(network),
        publishedTomlPath,
        graphqlUrl: graphqlUrl.trim() || defaultGraphqlUrl(network),
    };
}

async function runCli(): Promise<void> {
    const args = parseResolverArgs(process.argv.slice(2));
    const publishedToml = await readFile(args.publishedTomlPath, "utf8");
    const graphqlClient = new SuiGraphQLClient({ network: args.network, url: args.graphqlUrl });
    const result = await resolvePublishedContractIds({
        publishedToml,
        network: args.network,
        client: {
            query: async (input) => graphqlClient.query(input),
        },
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
