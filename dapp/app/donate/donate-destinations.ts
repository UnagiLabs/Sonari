const QUERY_EVENTS_PAGE_LIMIT = 100;

export interface DonateEventCursor {
    readonly txDigest: string;
    readonly eventSeq: string;
}

export interface DonateDestinationReadClient {
    queryEvents(input: {
        readonly query: {
            readonly MoveEventType: string;
        };
        readonly cursor?: DonateEventCursor | null;
        readonly limit?: number;
        readonly order?: "ascending" | "descending";
    }): Promise<{
        readonly data: readonly unknown[];
        readonly hasNextPage?: boolean;
        readonly nextCursor?: DonateEventCursor | null;
    }>;
}

export interface CampaignDestination {
    readonly kind: "campaign";
    readonly id: string;
    readonly label: string;
    readonly campaignId: string;
    readonly categoryPoolId: string;
    readonly category: number;
    readonly donationEndMs: string;
}

export interface CategoryDestination {
    readonly kind: "category";
    readonly id: string;
    readonly label: string;
    readonly categoryPoolId: string;
    readonly category: number;
}

export type DonateDestinationResult =
    | {
          readonly kind: "ok";
          readonly campaigns: readonly CampaignDestination[];
          readonly categories: readonly CategoryDestination[];
      }
    | {
          readonly kind: "error";
          readonly message: string;
      };

export function parseCampaignCreatedEvent(value: unknown): CampaignDestination | null {
    if (!isRecord(value)) {
        return null;
    }

    const campaignId = parseObjectId(value.campaign_id);
    const categoryPoolId = parseObjectId(value.category_pool_id);
    const category = parseCategory(value.category);
    const donationEndMs = parseU64String(value.donation_end_ms);

    if (
        campaignId === null ||
        categoryPoolId === null ||
        category === null ||
        donationEndMs === null
    ) {
        return null;
    }

    return {
        kind: "campaign",
        id: campaignId,
        label: `Campaign ${shortId(campaignId)}`,
        campaignId,
        categoryPoolId,
        category,
        donationEndMs,
    };
}

export function parseCategoryPoolCreatedEvent(value: unknown): CategoryDestination | null {
    if (!isRecord(value)) {
        return null;
    }

    const categoryPoolId = parseObjectId(value.pool_id);
    const category = parseCategory(value.category);

    if (categoryPoolId === null || category === null) {
        return null;
    }

    return {
        kind: "category",
        id: categoryPoolId,
        label: `Category ${category}`,
        categoryPoolId,
        category,
    };
}

export async function readDonateDestinations(
    client: DonateDestinationReadClient,
    input: { readonly packageId: string },
): Promise<DonateDestinationResult> {
    const packageId = input.packageId.trim();
    if (packageId.length === 0) {
        return { kind: "error", message: "Package id is required to read donation destinations." };
    }

    try {
        const [campaigns, categories] = await Promise.all([
            readDestinationEvents(
                client,
                `${packageId}::campaign::CampaignCreated`,
                parseCampaignCreatedEvent,
            ),
            readDestinationEvents(
                client,
                `${packageId}::category_pool::CategoryPoolCreated`,
                parseCategoryPoolCreatedEvent,
            ),
        ]);

        return { kind: "ok", campaigns, categories };
    } catch (error) {
        return {
            kind: "error",
            message: error instanceof Error ? error.message : "Failed to read donation destinations.",
        };
    }
}

async function readDestinationEvents<T>(
    client: DonateDestinationReadClient,
    eventType: string,
    parse: (value: unknown) => T | null,
): Promise<T[]> {
    const options: T[] = [];
    let cursor: DonateEventCursor | null | undefined;

    for (;;) {
        const response = await client.queryEvents({
            query: { MoveEventType: eventType },
            ...(cursor !== undefined ? { cursor } : {}),
            limit: QUERY_EVENTS_PAGE_LIMIT,
            order: "descending",
        });

        for (const item of response.data) {
            const option = parse(readParsedJson(item));
            if (option !== null) {
                options.push(option);
            }
        }

        if (response.hasNextPage !== true || response.nextCursor == null) {
            return options;
        }
        cursor = response.nextCursor;
    }
}

function readParsedJson(value: unknown): unknown {
    if (!isRecord(value)) {
        return undefined;
    }
    return value.parsedJson;
}

function parseObjectId(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return /^0x[0-9a-fA-F]{64}$/u.test(trimmed) ? trimmed : null;
}

function parseCategory(value: unknown): number | null {
    const parsed = parseU8(value);
    return parsed === null ? null : parsed;
}

function parseU8(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 255) {
        return null;
    }
    return parsed;
}

function parseU64String(value: unknown): string | null {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        return String(value);
    }
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return /^(0|[1-9]\d*)$/u.test(trimmed) ? trimmed : null;
}

function shortId(value: string): string {
    return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
