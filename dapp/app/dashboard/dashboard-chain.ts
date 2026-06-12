const QUERY_EVENTS_PAGE_LIMIT = 50;
const EARTHQUAKE_CATEGORY = 1;

export interface DashboardPoolReadObject {
    readonly objectId: string;
    readonly type?: string;
    readonly json: Record<string, unknown> | null;
}

export interface DashboardPoolReadClient {
    getObjects(input: {
        objectIds: string[];
        include: { json: true };
    }): Promise<{ objects: ReadonlyArray<DashboardPoolReadObject | Error> }>;
}

export interface DashboardEventCursor {
    readonly txDigest: string;
    readonly eventSeq: string;
}

export interface DashboardCategoryPoolIdReadClient {
    queryEvents(input: {
        readonly query: {
            readonly MoveEventType: string;
        };
        readonly cursor?: DashboardEventCursor | null;
        readonly limit?: number;
        readonly order?: "ascending" | "descending";
    }): Promise<{
        readonly data: readonly unknown[];
        readonly hasNextPage?: boolean;
        readonly nextCursor?: DashboardEventCursor | null;
    }>;
}

export interface DashboardPoolEnvIds {
    readonly mainPoolId: string;
    readonly operationsPoolId: string;
}

export interface DashboardPoolIds {
    readonly mainPoolId: string;
    readonly operationsPoolId: string;
    readonly categoryPoolId: string;
}

export interface DashboardMainPool {
    readonly key: "main";
    readonly objectId: string;
    readonly balanceUsdc: bigint;
    readonly totalReceivedUsdc: bigint;
    readonly totalFloorFundedUsdc: bigint;
    readonly reserveFloorUsdc: bigint;
}

export interface DashboardOperationsPool {
    readonly key: "operations";
    readonly objectId: string;
    readonly balanceUsdc: bigint;
    readonly totalReceivedUsdc: bigint;
    readonly totalSpentUsdc: bigint;
}

export interface DashboardCategoryPool {
    readonly key: "category";
    readonly objectId: string;
    readonly category: number;
    readonly balanceUsdc: bigint;
    readonly totalReceivedUsdc: bigint;
    readonly totalFloorFundedUsdc: bigint;
}

export interface DashboardPools {
    readonly main: DashboardMainPool;
    readonly operations: DashboardOperationsPool;
    readonly category: DashboardCategoryPool;
}

export type DashboardPoolReadResult =
    | { readonly kind: "ok"; readonly pools: DashboardPools }
    | { readonly kind: "error"; readonly message: string };

export function parseDashboardPoolIds(
    env: Record<string, string | undefined>,
):
    | { readonly kind: "ok"; readonly ids: DashboardPoolEnvIds }
    | { readonly kind: "error"; readonly message: string } {
    const mainPoolId = parseObjectId(env.NEXT_PUBLIC_SONARI_MAIN_POOL_ID);
    if (mainPoolId === null) {
        return {
            kind: "error",
            message: "NEXT_PUBLIC_SONARI_MAIN_POOL_ID must be a 32-byte Sui object id.",
        };
    }

    const operationsPoolId = parseObjectId(env.NEXT_PUBLIC_SONARI_OPERATIONS_POOL_ID);
    if (operationsPoolId === null) {
        return {
            kind: "error",
            message: "NEXT_PUBLIC_SONARI_OPERATIONS_POOL_ID must be a 32-byte Sui object id.",
        };
    }

    return { kind: "ok", ids: { mainPoolId, operationsPoolId } };
}

export async function readEarthquakeCategoryPoolId(
    client: DashboardCategoryPoolIdReadClient,
    input: { readonly packageId: string },
): Promise<
    | { readonly kind: "ok"; readonly categoryPoolId: string }
    | { readonly kind: "error"; readonly message: string }
> {
    const packageId = parseObjectId(input.packageId);
    if (packageId === null) {
        return {
            kind: "error",
            message: "NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID must be a 32-byte Sui package id.",
        };
    }

    try {
        let cursor: DashboardEventCursor | null | undefined;
        for (;;) {
            const response = await client.queryEvents({
                query: { MoveEventType: `${packageId}::category_pool::CategoryPoolCreated` },
                ...(cursor !== undefined ? { cursor } : {}),
                limit: QUERY_EVENTS_PAGE_LIMIT,
                order: "descending",
            });

            for (const item of response.data) {
                const parsed = parseCategoryPoolCreatedEvent(readParsedJson(item));
                if (parsed !== null && parsed.category === EARTHQUAKE_CATEGORY) {
                    return { kind: "ok", categoryPoolId: parsed.poolId };
                }
            }

            if (response.hasNextPage !== true || response.nextCursor == null) {
                return {
                    kind: "error",
                    message: "Earthquake category pool was not found on chain.",
                };
            }
            cursor = response.nextCursor;
        }
    } catch (error) {
        return {
            kind: "error",
            message:
                error instanceof Error
                    ? error.message
                    : "Failed to read earthquake category pool id.",
        };
    }
}

export async function readDashboardPools(
    client: DashboardPoolReadClient,
    ids: DashboardPoolIds,
): Promise<DashboardPoolReadResult> {
    try {
        const response = await client.getObjects({
            objectIds: [ids.mainPoolId, ids.operationsPoolId, ids.categoryPoolId],
            include: { json: true },
        });

        const main = parseMainPoolObject(response.objects[0]);
        const operations = parseOperationsPoolObject(response.objects[1]);
        const category = parseCategoryPoolObject(response.objects[2]);

        if (main === null || operations === null || category === null) {
            return { kind: "error", message: "Dashboard pool response is invalid." };
        }

        return { kind: "ok", pools: { main, operations, category } };
    } catch (error) {
        return {
            kind: "error",
            message: error instanceof Error ? error.message : "Failed to read dashboard pools.",
        };
    }
}

export function parseCategoryPoolCreatedEvent(
    raw: unknown,
): { readonly poolId: string; readonly category: number } | null {
    if (!isRecord(raw)) {
        return null;
    }
    const poolId = parseObjectId(raw.pool_id);
    const category = parseU8(raw.category);
    return poolId === null || category === null ? null : { poolId, category };
}

export function parseMainPoolObject(raw: unknown): DashboardMainPool | null {
    const object = parsePoolObject(raw, "::pools::MainPool");
    if (object === null) {
        return null;
    }

    const balanceUsdc = parseBalanceValue(object.json.balance);
    const totalReceivedUsdc = parseU64(object.json.total_received_usdc);
    const totalFloorFundedUsdc = parseU64(object.json.total_floor_funded_usdc);
    const reserveFloorUsdc = parseU64(object.json.reserve_floor_usdc);

    if (
        balanceUsdc === null ||
        totalReceivedUsdc === null ||
        totalFloorFundedUsdc === null ||
        reserveFloorUsdc === null
    ) {
        return null;
    }

    return {
        key: "main",
        objectId: object.objectId,
        balanceUsdc,
        totalReceivedUsdc,
        totalFloorFundedUsdc,
        reserveFloorUsdc,
    };
}

export function parseOperationsPoolObject(raw: unknown): DashboardOperationsPool | null {
    const object = parsePoolObject(raw, "::pools::OperationsPool");
    if (object === null) {
        return null;
    }

    const balanceUsdc = parseBalanceValue(object.json.balance);
    const totalReceivedUsdc = parseU64(object.json.total_received_usdc);
    const totalSpentUsdc = parseU64(object.json.total_spent_usdc);

    if (balanceUsdc === null || totalReceivedUsdc === null || totalSpentUsdc === null) {
        return null;
    }

    return {
        key: "operations",
        objectId: object.objectId,
        balanceUsdc,
        totalReceivedUsdc,
        totalSpentUsdc,
    };
}

export function parseCategoryPoolObject(raw: unknown): DashboardCategoryPool | null {
    const object = parsePoolObject(raw, "::category_pool::CategoryPool");
    if (object === null) {
        return null;
    }

    const category = parseU8(object.json.category);
    const balanceUsdc = parseBalanceValue(object.json.balance);
    const totalReceivedUsdc = parseU64(object.json.total_received_usdc);
    const totalFloorFundedUsdc = parseU64(object.json.total_floor_funded_usdc);

    if (
        category === null ||
        balanceUsdc === null ||
        totalReceivedUsdc === null ||
        totalFloorFundedUsdc === null
    ) {
        return null;
    }

    return {
        key: "category",
        objectId: object.objectId,
        category,
        balanceUsdc,
        totalReceivedUsdc,
        totalFloorFundedUsdc,
    };
}

function parsePoolObject(
    raw: unknown,
    expectedTypeSuffix: string,
): { readonly objectId: string; readonly json: Record<string, unknown> } | null {
    if (raw instanceof Error || !isRecord(raw)) {
        return null;
    }

    const objectId = parseObjectId(raw.objectId);
    if (objectId === null || raw.json === null || !isRecord(raw.json)) {
        return null;
    }

    if (typeof raw.type !== "string" || !raw.type.endsWith(expectedTypeSuffix)) {
        return null;
    }

    return { objectId, json: raw.json };
}

function readParsedJson(value: unknown): unknown {
    if (!isRecord(value)) {
        return undefined;
    }
    return value.parsedJson;
}

function parseBalanceValue(raw: unknown): bigint | null {
    if (!isRecord(raw)) {
        return null;
    }
    return parseU64(raw.value);
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
