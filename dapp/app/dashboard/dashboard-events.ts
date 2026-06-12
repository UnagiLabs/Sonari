const QUERY_EVENTS_PAGE_LIMIT = 50;

export interface DashboardEventCursor {
    readonly txDigest: string;
    readonly eventSeq: string;
}

export interface DashboardEventReadClient {
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

export type DonationEventSource = "split" | "general" | "operations";
export type PayoutEventSource = "floor" | "payout" | "round";
export type StatusKey = "active" | "paused" | "confirmed" | "pending" | "finalized";

export interface DashboardDonationEvent {
    readonly kind: "donation";
    readonly id: string;
    readonly source: DonationEventSource;
    readonly label: string;
    readonly amountUsdc: bigint;
    readonly actor: string;
    readonly poolId: string;
    readonly occurredAtMs: number;
    readonly status: "confirmed";
}

export interface DashboardClaimEvent {
    readonly kind: "claim";
    readonly id: string;
    readonly source: PayoutEventSource;
    readonly label: string;
    readonly amountUsdc: bigint;
    readonly campaignId: string;
    readonly recipient: string;
    readonly occurredAtMs: number;
    readonly status: "finalized";
}

export interface DashboardDisasterEvent {
    readonly id: string;
    readonly sourceEventId: string;
    readonly title: string;
    readonly region: string;
    readonly hazardLabel: string;
    readonly affectedCellCount: bigint;
    readonly occurredAtMs: number;
    readonly status: "finalized";
}

export type DashboardEventReadResult =
    | {
          readonly kind: "ok";
          readonly donations: readonly DashboardDonationEvent[];
          readonly claims: readonly DashboardClaimEvent[];
          readonly latestEvent: DashboardDisasterEvent | null;
      }
    | { readonly kind: "error"; readonly message: string };

export async function readDashboardEvents(
    client: DashboardEventReadClient,
    input: { readonly packageId: string; readonly limit?: number },
): Promise<DashboardEventReadResult> {
    const packageId = input.packageId.trim();
    if (packageId.length === 0) {
        return { kind: "error", message: "Package id is required to read dashboard events." };
    }

    try {
        const [
            splitDonations,
            generalDonations,
            operationsDonations,
            floorClaims,
            payoutClaims,
            roundClaims,
            disasterEvents,
        ] = await Promise.all([
            readTypedEvents(client, `${packageId}::donation::DonationSplit`, (event) =>
                parseDashboardDonationEvent(event, "split"),
            ),
            readTypedEvents(client, `${packageId}::donation::GeneralDonationReceived`, (event) =>
                parseDashboardDonationEvent(event, "general"),
            ),
            readTypedEvents(client, `${packageId}::donation::OperationsDonationReceived`, (event) =>
                parseDashboardDonationEvent(event, "operations"),
            ),
            readTypedEvents(client, `${packageId}::campaign::FloorPaid`, (event) =>
                parseDashboardPayoutEvent(event, "floor"),
            ),
            readTypedEvents(client, `${packageId}::campaign::PayoutClaimed`, (event) =>
                parseDashboardPayoutEvent(event, "payout"),
            ),
            readTypedEvents(client, `${packageId}::campaign::RoundFinalized`, (event) =>
                parseDashboardPayoutEvent(event, "round"),
            ),
            readTypedEvents(
                client,
                `${packageId}::disaster_event::DisasterEventCreated`,
                parseDashboardDisasterEvent,
            ),
        ]);

        const limit = input.limit ?? 10;
        const donations = uniqueById([...splitDonations, ...generalDonations, ...operationsDonations])
            .sort(compareNewestFirst)
            .slice(0, limit);
        const claims = uniqueById([...floorClaims, ...payoutClaims, ...roundClaims])
            .sort(compareNewestFirst)
            .slice(0, limit);
        const latestEvent = uniqueDisasters(disasterEvents).sort(compareNewestFirst)[0] ?? null;

        return { kind: "ok", donations, claims, latestEvent };
    } catch (error) {
        return {
            kind: "error",
            message: error instanceof Error ? error.message : "Failed to read dashboard events.",
        };
    }
}

export function parseDashboardDonationEvent(
    raw: unknown,
    source: DonationEventSource,
): DashboardDonationEvent | null {
    const event = parseEventEnvelope(raw);
    if (event === null) {
        return null;
    }

    const amountUsdc =
        source === "split" ? parseU64(event.parsedJson.total_amount) : parseU64(event.parsedJson.amount);
    const actor =
        source === "split" ? parseObjectId(event.parsedJson.donor) : parseObjectId(event.parsedJson.actor);
    const poolId =
        source === "split"
            ? parseObjectId(event.parsedJson.main_pool_id)
            : parseObjectId(event.parsedJson.pool_id);

    if (amountUsdc === null || actor === null || poolId === null) {
        return null;
    }

    return {
        kind: "donation",
        id: event.id,
        source,
        label: `Donor ${shortId(actor)}`,
        amountUsdc,
        actor,
        poolId,
        occurredAtMs: event.timestampMs,
        status: "confirmed",
    };
}

export function parseDashboardPayoutEvent(
    raw: unknown,
    source: PayoutEventSource,
): DashboardClaimEvent | null {
    const event = parseEventEnvelope(raw);
    if (event === null) {
        return null;
    }

    const campaignId = parseObjectId(event.parsedJson.campaign_id);
    const amountUsdc =
        source === "round" ? parseRoundFinalizedAmount(event.parsedJson) : parseU64(event.parsedJson.amount_usdc);
    const recipient =
        source === "round"
            ? parseObjectId(event.parsedJson.campaign_id)
            : parseObjectId(event.parsedJson.recipient);
    const occurredAtMs =
        source === "floor"
            ? (parseU64Number(event.parsedJson.paid_at_ms) ?? event.timestampMs)
            : source === "round"
                ? (parseU64Number(event.parsedJson.finalized_at_ms) ?? event.timestampMs)
                : event.timestampMs;

    if (campaignId === null || amountUsdc === null || recipient === null) {
        return null;
    }

    return {
        kind: "claim",
        id: event.id,
        source,
        label: source === "round" ? `round · ${shortId(campaignId)}` : `recipient · ${shortId(recipient)}`,
        amountUsdc,
        campaignId,
        recipient,
        occurredAtMs,
        status: "finalized",
    };
}

export function parseDashboardDisasterEvent(raw: unknown): DashboardDisasterEvent | null {
    const event = parseEventEnvelope(raw);
    if (event === null) {
        return null;
    }

    const id = parseObjectId(event.parsedJson.disaster_event_id);
    const sourceEventId = parseNonEmptyString(event.parsedJson.source_event_id);
    const title = parseNonEmptyString(event.parsedJson.title);
    const region = parseNonEmptyString(event.parsedJson.region);
    const hazardLabel = parseNonEmptyString(event.parsedJson.hazard_label);
    const affectedCellCount = parseU64(event.parsedJson.affected_cell_count);
    const occurredAtMs = parseU64Number(event.parsedJson.created_at_ms) ?? event.timestampMs;

    if (
        id === null ||
        sourceEventId === null ||
        title === null ||
        region === null ||
        hazardLabel === null ||
        affectedCellCount === null
    ) {
        return null;
    }

    return {
        id,
        sourceEventId,
        title,
        region,
        hazardLabel,
        affectedCellCount,
        occurredAtMs,
        status: "finalized",
    };
}

async function readTypedEvents<T>(
    client: DashboardEventReadClient,
    eventType: string,
    parse: (value: unknown) => T | null,
): Promise<T[]> {
    const result: T[] = [];
    let cursor: DashboardEventCursor | null | undefined;

    for (;;) {
        const response = await client.queryEvents({
            query: { MoveEventType: eventType },
            ...(cursor !== undefined ? { cursor } : {}),
            limit: QUERY_EVENTS_PAGE_LIMIT,
            order: "descending",
        });

        for (const item of response.data) {
            const parsed = parse(item);
            if (parsed !== null) {
                result.push(parsed);
            }
        }

        if (response.hasNextPage !== true || response.nextCursor == null) {
            return result;
        }
        cursor = response.nextCursor;
    }
}

function parseEventEnvelope(
    raw: unknown,
): { readonly id: string; readonly timestampMs: number; readonly parsedJson: Record<string, unknown> } | null {
    if (!isRecord(raw) || !isRecord(raw.parsedJson)) {
        return null;
    }

    const id = parseEventId(raw.id);
    const timestampMs = parseU64Number(raw.timestampMs);
    if (id === null || timestampMs === null) {
        return null;
    }
    return { id, timestampMs, parsedJson: raw.parsedJson };
}

function parseEventId(raw: unknown): string | null {
    if (!isRecord(raw)) {
        return null;
    }
    const txDigest = parseNonEmptyString(raw.txDigest);
    const eventSeq = parseNonEmptyString(raw.eventSeq);
    return txDigest === null || eventSeq === null ? null : `${txDigest}:${eventSeq}`;
}

function parseRoundFinalizedAmount(raw: Record<string, unknown>): bigint | null {
    const liability = parseU64(raw.liability);
    if (liability !== null) {
        return liability;
    }
    if (!Array.isArray(raw.band_payout)) {
        return null;
    }
    return raw.band_payout.reduce<bigint | null>((sum, item) => {
        const value = parseU64(item);
        if (sum === null || value === null) {
            return null;
        }
        return sum + value;
    }, 0n);
}

function uniqueById<T extends { readonly id: string }>(items: readonly T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const item of items) {
        if (!seen.has(item.id)) {
            seen.add(item.id);
            result.push(item);
        }
    }
    return result;
}

function uniqueDisasters(items: readonly DashboardDisasterEvent[]): DashboardDisasterEvent[] {
    const seen = new Set<string>();
    const result: DashboardDisasterEvent[] = [];
    for (const item of items) {
        if (!seen.has(item.id)) {
            seen.add(item.id);
            result.push(item);
        }
    }
    return result;
}

function compareNewestFirst(a: { readonly occurredAtMs: number }, b: { readonly occurredAtMs: number }): number {
    return b.occurredAtMs - a.occurredAtMs;
}

function parseObjectId(raw: unknown): string | null {
    if (typeof raw !== "string") {
        return null;
    }
    const trimmed = raw.trim();
    return /^0x[0-9a-fA-F]{64}$/u.test(trimmed) ? trimmed : null;
}

function parseNonEmptyString(raw: unknown): string | null {
    if (typeof raw !== "string") {
        return null;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parseU64Number(raw: unknown): number | null {
    const parsed = parseU64(raw);
    if (parsed === null || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
        return null;
    }
    return Number(parsed);
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

function shortId(value: string): string {
    return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
