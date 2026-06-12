const QUERY_EVENTS_PAGE_LIMIT = 100;

export interface ClaimCampaignEventCursor {
    readonly txDigest: string;
    readonly eventSeq: string;
}

export interface ClaimCampaignObject {
    readonly objectId: string;
    readonly json: Record<string, unknown> | null;
}

export interface ClaimCampaignReadClient {
    queryEvents(input: {
        readonly query: {
            readonly MoveEventType: string;
        };
        readonly cursor?: ClaimCampaignEventCursor | null;
        readonly limit?: number;
        readonly order?: "ascending" | "descending";
    }): Promise<{
        readonly data: readonly unknown[];
        readonly hasNextPage?: boolean;
        readonly nextCursor?: ClaimCampaignEventCursor | null;
    }>;
    getObjects(input: {
        readonly objectIds: string[];
        readonly include: { readonly json: true };
    }): Promise<{ readonly objects: ReadonlyArray<ClaimCampaignObject | Error> }>;
}

export interface CampaignCreatedEvent {
    readonly campaignId: string;
    readonly disasterEventId: string;
    readonly eventUid: string;
    readonly eventRevision: number;
}

export interface ClaimCampaignObjectData {
    readonly campaignId: string;
    readonly disasterEventId: string;
    readonly eventUid: string;
    readonly eventRevision: number;
    readonly censusSet: boolean;
    readonly floorBudgetReturned: boolean;
    readonly donationEndMs: string;
    readonly claimEndMs: string;
    readonly currentRound: string;
}

export interface ClaimDisasterEventObjectData {
    readonly disasterEventId: string;
    readonly eventUid: string;
    readonly eventRevision: number;
    readonly affectedCellsRoot: string;
    readonly affectedCellCount: string;
    readonly title: string;
    readonly region: string;
    readonly severityBand: number;
}

export interface ClaimCampaignState {
    readonly campaignId: string;
    readonly disasterEventId: string;
    readonly eventUid: string;
    readonly eventRevision: number;
    readonly affectedCellsRoot: string;
    readonly title: string;
    readonly region: string;
    readonly severityBand: number;
    readonly affectedCellCount: string;
    readonly donationEndMs: string;
    readonly claimEndMs: string;
    readonly claimWindowOpen: boolean;
    readonly floorClaimAvailable: boolean;
    readonly payoutFinalized: boolean;
    readonly currentRound: string;
}

export type ClaimCampaignReadResult =
    | {
          readonly kind: "ok";
          readonly campaigns: readonly ClaimCampaignState[];
      }
    | {
          readonly kind: "error";
          readonly message: string;
      };

export function parseCampaignCreatedEvent(value: unknown): CampaignCreatedEvent | null {
    if (!isRecord(value)) {
        return null;
    }

    const campaignId = parseObjectId(value.campaign_id);
    const disasterEventId = parseObjectId(value.disaster_event_id);
    const eventUid = parseBytes32Hex(value.event_uid);
    const eventRevision = parseU32(value.event_revision);

    if (
        campaignId === null ||
        disasterEventId === null ||
        eventUid === null ||
        eventRevision === null
    ) {
        return null;
    }

    return { campaignId, disasterEventId, eventUid, eventRevision };
}

export function parseCampaignObject(
    campaignId: string,
    json: Record<string, unknown> | null,
): ClaimCampaignObjectData | null {
    if (json === null) {
        return null;
    }

    const disasterEventId = parseObjectId(json.disaster_event_id);
    const eventUid = parseBytes32Hex(json.event_uid);
    const eventRevision = parseU32(json.event_revision);
    const censusSet = parseBoolean(json.census_set);
    const floorBudgetReturned = parseBoolean(json.floor_budget_returned);
    const donationEndMs = parseU64String(json.donation_end_ms);
    const claimEndMs = parseU64String(json.claim_end_ms);
    const currentRound = parseU64String(json.current_round);

    if (
        disasterEventId === null ||
        eventUid === null ||
        eventRevision === null ||
        censusSet === null ||
        floorBudgetReturned === null ||
        donationEndMs === null ||
        claimEndMs === null ||
        currentRound === null
    ) {
        return null;
    }

    return {
        campaignId,
        disasterEventId,
        eventUid,
        eventRevision,
        censusSet,
        floorBudgetReturned,
        donationEndMs,
        claimEndMs,
        currentRound,
    };
}

export function parseDisasterEventObject(
    disasterEventId: string,
    json: Record<string, unknown> | null,
): ClaimDisasterEventObjectData | null {
    if (json === null) {
        return null;
    }

    const eventUid = parseBytes32Hex(json.event_uid);
    const eventRevision = parseU32(json.event_revision);
    const affectedCellsRoot = parseBytes32Hex(json.affected_cells_root);
    const affectedCellCount = parseU64String(json.affected_cell_count);
    const title = parseNonEmptyString(json.title);
    const region = parseNonEmptyString(json.region);
    const severityBand = parseU8(json.severity_band);

    if (
        eventUid === null ||
        eventRevision === null ||
        affectedCellsRoot === null ||
        affectedCellCount === null ||
        title === null ||
        region === null ||
        severityBand === null
    ) {
        return null;
    }

    return {
        disasterEventId,
        eventUid,
        eventRevision,
        affectedCellsRoot,
        affectedCellCount,
        title,
        region,
        severityBand,
    };
}

export function deriveClaimCampaignState(
    campaign: ClaimCampaignObjectData,
    disaster: ClaimDisasterEventObjectData,
    nowMs: string | number,
): ClaimCampaignState | null {
    const now = parseU64String(nowMs);
    if (now === null) {
        return null;
    }
    if (campaign.disasterEventId !== disaster.disasterEventId) {
        return null;
    }
    if (
        campaign.eventUid !== disaster.eventUid ||
        campaign.eventRevision !== disaster.eventRevision
    ) {
        return null;
    }

    return {
        campaignId: campaign.campaignId,
        disasterEventId: campaign.disasterEventId,
        eventUid: campaign.eventUid,
        eventRevision: campaign.eventRevision,
        affectedCellsRoot: disaster.affectedCellsRoot,
        title: disaster.title,
        region: disaster.region,
        severityBand: disaster.severityBand,
        affectedCellCount: disaster.affectedCellCount,
        donationEndMs: campaign.donationEndMs,
        claimEndMs: campaign.claimEndMs,
        claimWindowOpen: BigInt(now) < BigInt(campaign.claimEndMs),
        floorClaimAvailable: campaign.censusSet && !campaign.floorBudgetReturned,
        payoutFinalized: BigInt(campaign.currentRound) > 0n,
        currentRound: campaign.currentRound,
    };
}

export async function readClaimCampaigns(
    client: ClaimCampaignReadClient,
    input: { readonly packageId: string; readonly nowMs: string | number },
): Promise<ClaimCampaignReadResult> {
    const packageId = input.packageId.trim();
    if (packageId.length === 0) {
        return { kind: "error", message: "Package id is required to read claim campaigns." };
    }

    try {
        const events = await readCampaignCreatedEvents(
            client,
            `${packageId}::campaign::CampaignCreated`,
        );
        const byCampaignId = dedupeCampaignEvents(events);
        const campaignObjects = await readCampaignObjects(client, [...byCampaignId.keys()]);
        const disasterObjects = await readDisasterEventObjects(
            client,
            campaignObjects.map((campaign) => campaign.disasterEventId),
        );

        const campaigns: ClaimCampaignState[] = [];
        for (const campaign of campaignObjects) {
            const disaster = disasterObjects.get(campaign.disasterEventId);
            if (disaster === undefined) {
                continue;
            }
            const state = deriveClaimCampaignState(campaign, disaster, input.nowMs);
            if (state !== null) {
                campaigns.push(state);
            }
        }

        return { kind: "ok", campaigns };
    } catch (error) {
        return {
            kind: "error",
            message: error instanceof Error ? error.message : "Failed to read claim campaigns.",
        };
    }
}

async function readCampaignCreatedEvents(
    client: ClaimCampaignReadClient,
    eventType: string,
): Promise<CampaignCreatedEvent[]> {
    const events: CampaignCreatedEvent[] = [];
    let cursor: ClaimCampaignEventCursor | null | undefined;

    for (;;) {
        const response = await client.queryEvents({
            query: { MoveEventType: eventType },
            ...(cursor !== undefined ? { cursor } : {}),
            limit: QUERY_EVENTS_PAGE_LIMIT,
            order: "descending",
        });

        for (const item of response.data) {
            const parsed = parseCampaignCreatedEvent(readParsedJson(item));
            if (parsed !== null) {
                events.push(parsed);
            }
        }

        if (response.hasNextPage !== true || response.nextCursor == null) {
            return events;
        }
        cursor = response.nextCursor;
    }
}

function dedupeCampaignEvents(
    events: readonly CampaignCreatedEvent[],
): Map<string, CampaignCreatedEvent> {
    const byCampaignId = new Map<string, CampaignCreatedEvent>();
    for (const event of events) {
        if (!byCampaignId.has(event.campaignId)) {
            byCampaignId.set(event.campaignId, event);
        }
    }
    return byCampaignId;
}

async function readCampaignObjects(
    client: ClaimCampaignReadClient,
    campaignIds: readonly string[],
): Promise<ClaimCampaignObjectData[]> {
    const response = await client.getObjects({
        objectIds: [...campaignIds],
        include: { json: true },
    });
    const campaigns: ClaimCampaignObjectData[] = [];
    for (const item of response.objects) {
        if (item instanceof Error) {
            continue;
        }
        const parsed = parseCampaignObject(item.objectId, item.json);
        if (parsed !== null) {
            campaigns.push(parsed);
        }
    }
    return campaigns;
}

async function readDisasterEventObjects(
    client: ClaimCampaignReadClient,
    disasterEventIds: readonly string[],
): Promise<Map<string, ClaimDisasterEventObjectData>> {
    const uniqueIds = [...new Set(disasterEventIds)];
    const response = await client.getObjects({
        objectIds: uniqueIds,
        include: { json: true },
    });
    const disasters = new Map<string, ClaimDisasterEventObjectData>();
    for (const item of response.objects) {
        if (item instanceof Error) {
            continue;
        }
        const parsed = parseDisasterEventObject(item.objectId, item.json);
        if (parsed !== null) {
            disasters.set(parsed.disasterEventId, parsed);
        }
    }
    return disasters;
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

function parseBytes32Hex(value: unknown): string | null {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return /^0x[0-9a-fA-F]{64}$/u.test(trimmed) ? trimmed.toLowerCase() : null;
    }
    if (!Array.isArray(value) || value.length !== 32) {
        return null;
    }
    const bytes: string[] = [];
    for (const item of value) {
        if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 255) {
            return null;
        }
        bytes.push(item.toString(16).padStart(2, "0"));
    }
    return `0x${bytes.join("")}`;
}

function parseBoolean(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
}

function parseNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseU8(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 255) {
        return null;
    }
    return parsed;
}

function parseU32(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 4_294_967_295) {
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

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
