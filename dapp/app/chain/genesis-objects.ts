// packageID から genesis 共有オブジェクトの ObjectID を導出する。
//
// 単一の真実は contracts/sources/admin.move。publish 時の init が、生成した
// 共有オブジェクト（pause_state / main_pool / operations_pool / 各 registry /
// earthquake_pool など）を `GenesisObjectCreated` イベントとしてまとめて emit する。
// dapp はこのイベントを 1 回照会するだけで、ObjectID を packageID から導出できる。
// これにより、publish のたびに ObjectID を環境変数へ手登録する運用を不要にする。

const QUERY_EVENTS_PAGE_LIMIT = 50;

// object_kind は admin.move の GENESIS_KIND_* 定数と一致させる cross-language contract。
// 値を変えるときは admin.move 側と同時に更新する。
export const GENESIS_OBJECT_KIND = {
    adminCap: 1,
    pauseState: 2,
    mainPool: 3,
    operationsPool: 4,
    donorRegistry: 5,
    membershipRegistry: 6,
    verifierRegistry: 7,
    identityRegistry: 9,
    categoryRegistry: 10,
    earthquakePool: 11,
    allowedResidenceCellRegistry: 13,
    cellCountIndex: 14,
} as const;

export interface GenesisEventCursor {
    readonly txDigest: string;
    readonly eventSeq: string;
}

export interface GenesisObjectQueryClient {
    queryEvents(input: {
        readonly query: {
            readonly MoveEventType: string;
        };
        readonly cursor?: GenesisEventCursor | null;
        readonly limit?: number;
        readonly order?: "ascending" | "descending";
    }): Promise<{
        readonly data: readonly unknown[];
        readonly hasNextPage?: boolean;
        readonly nextCursor?: GenesisEventCursor | null;
    }>;
}

export interface GenesisObjectRecord {
    readonly objectId: string;
    readonly objectKind: number;
    readonly createdAtMs: bigint;
}

export type GenesisObjectIdsResult =
    | { readonly kind: "ok"; readonly ids: ReadonlyMap<number, string> }
    | { readonly kind: "error"; readonly message: string };

export interface MembershipDappGenesisObjects {
    readonly pauseState: string;
    readonly membershipRegistry: string;
    readonly identityRegistry: string;
    readonly allowedResidenceCellRegistry: string;
    readonly cellCountIndex: string;
}

export type MembershipDappGenesisObjectsResult =
    | { readonly kind: "ok"; readonly objects: MembershipDappGenesisObjects }
    | { readonly kind: "error"; readonly message: string };

const MEMBERSHIP_DAPP_REQUIRED_OBJECTS = [
    { key: "pauseState", objectKind: GENESIS_OBJECT_KIND.pauseState },
    { key: "membershipRegistry", objectKind: GENESIS_OBJECT_KIND.membershipRegistry },
    { key: "identityRegistry", objectKind: GENESIS_OBJECT_KIND.identityRegistry },
    {
        key: "allowedResidenceCellRegistry",
        objectKind: GENESIS_OBJECT_KIND.allowedResidenceCellRegistry,
    },
    { key: "cellCountIndex", objectKind: GENESIS_OBJECT_KIND.cellCountIndex },
] as const;

export function parseGenesisObjectCreatedEvent(raw: unknown): GenesisObjectRecord | null {
    if (!isRecord(raw)) {
        return null;
    }
    const objectId = parseObjectId(raw.object_id);
    const objectKind = parseU8(raw.object_kind);
    const createdAtMs = parseU64(raw.created_at_ms);
    if (objectId === null || objectKind === null || createdAtMs === null) {
        return null;
    }
    return { objectId, objectKind, createdAtMs };
}

export async function readGenesisObjectIds(
    client: GenesisObjectQueryClient,
    input: { readonly packageId: string },
): Promise<GenesisObjectIdsResult> {
    const packageId = parseObjectId(input.packageId);
    if (packageId === null) {
        return { kind: "error", message: "Funding package id is not a valid Sui package id." };
    }

    // 同じ object_kind が複数現れても、created_at_ms が最大のものを採用する。
    // 通常は publish が 1 回なので各 kind は 1 件だが、念のため最新を選ぶ。
    const latest = new Map<number, GenesisObjectRecord>();
    try {
        let cursor: GenesisEventCursor | null | undefined;
        for (;;) {
            const response = await client.queryEvents({
                query: { MoveEventType: `${packageId}::admin::GenesisObjectCreated` },
                ...(cursor !== undefined ? { cursor } : {}),
                limit: QUERY_EVENTS_PAGE_LIMIT,
                order: "descending",
            });

            for (const item of response.data) {
                const record = parseGenesisObjectCreatedEvent(readParsedJson(item));
                if (record === null) {
                    continue;
                }
                const current = latest.get(record.objectKind);
                if (current === undefined || record.createdAtMs > current.createdAtMs) {
                    latest.set(record.objectKind, record);
                }
            }

            if (response.hasNextPage !== true || response.nextCursor == null) {
                break;
            }
            cursor = response.nextCursor;
        }
    } catch (error) {
        return {
            kind: "error",
            message: error instanceof Error ? error.message : "Failed to read genesis objects.",
        };
    }

    const ids = new Map<number, string>();
    for (const [kind, record] of latest) {
        ids.set(kind, record.objectId);
    }
    return { kind: "ok", ids };
}

export function selectGenesisObjectId(
    ids: ReadonlyMap<number, string>,
    objectKind: number,
): string | null {
    return ids.get(objectKind) ?? null;
}

export async function resolveMembershipDappGenesisObjects(
    client: unknown,
    input: { readonly packageId: string },
): Promise<MembershipDappGenesisObjectsResult> {
    if (!hasQueryEvents(client)) {
        return {
            kind: "error",
            message: "A queryEvents-capable Sui client is required to resolve genesis objects.",
        };
    }

    const result = await readGenesisObjectIds(client, input);
    if (result.kind === "error") {
        return result;
    }

    const objects: Partial<Record<keyof MembershipDappGenesisObjects, string>> = {};
    for (const required of MEMBERSHIP_DAPP_REQUIRED_OBJECTS) {
        const objectId = selectGenesisObjectId(result.ids, required.objectKind);
        if (objectId === null) {
            return {
                kind: "error",
                message: `Missing required genesis object ${required.key} (kind ${required.objectKind}).`,
            };
        }
        objects[required.key] = objectId;
    }

    return {
        kind: "ok",
        objects: objects as MembershipDappGenesisObjects,
    };
}

function hasQueryEvents(client: unknown): client is GenesisObjectQueryClient {
    return isRecord(client) && typeof client.queryEvents === "function";
}

function readParsedJson(value: unknown): unknown {
    if (!isRecord(value)) {
        return undefined;
    }
    return value.parsedJson;
}

function parseObjectId(raw: unknown): string | null {
    if (typeof raw !== "string") {
        return null;
    }
    const trimmed = raw.trim();
    return /^0x[0-9a-fA-F]{64}$/u.test(trimmed) ? trimmed : null;
}

function parseU8(raw: unknown): number | null {
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 255) {
        return null;
    }
    return parsed;
}

function parseU64(raw: unknown): bigint | null {
    if (typeof raw === "number") {
        if (!Number.isSafeInteger(raw) || raw < 0) {
            return null;
        }
        return BigInt(raw);
    }
    if (typeof raw !== "string") {
        return null;
    }
    const trimmed = raw.trim();
    if (!/^(0|[1-9]\d*)$/u.test(trimmed)) {
        return null;
    }
    const parsed = BigInt(trimmed);
    return parsed <= 18_446_744_073_709_551_615n ? parsed : null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
