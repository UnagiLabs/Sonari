import { describe, expect, it, vi } from "vitest";
import {
    type DonateEventCursor,
    type DonateDestinationReadClient,
    parseCampaignCreatedEvent,
    parseCategoryPoolCreatedEvent,
    readDonateDestinations,
} from "./donate-destinations";

const PACKAGE_ID = `0x${"ab".repeat(32)}`;
const CAMPAIGN_TYPE = `${PACKAGE_ID}::campaign::CampaignCreated`;
const CATEGORY_POOL_TYPE = `${PACKAGE_ID}::category_pool::CategoryPoolCreated`;
const CAMPAIGN_ID = `0x${"11".repeat(32)}`;
const CATEGORY_POOL_ID = `0x${"22".repeat(32)}`;

function campaignParsedJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        campaign_id: CAMPAIGN_ID,
        category_pool_id: CATEGORY_POOL_ID,
        category: 7,
        donation_end_ms: "1700000000",
        ...overrides,
    };
}

function categoryPoolParsedJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        pool_id: CATEGORY_POOL_ID,
        category: 7,
        ...overrides,
    };
}

function stubClient(entries: {
    readonly [eventType: string]: readonly unknown[];
}): DonateDestinationReadClient {
    return {
        queryEvents: vi.fn(async (input: { query: { MoveEventType: string } }) => ({
            data: entries[input.query.MoveEventType] ?? [],
            hasNextPage: false,
        })),
    };
}

describe("parseCampaignCreatedEvent", () => {
    it("returns deterministic campaign option for valid parsedJson", () => {
        const result = parseCampaignCreatedEvent(campaignParsedJson());

        expect(result).toEqual({
            kind: "campaign",
            id: CAMPAIGN_ID,
            label: "Campaign 0x1111...1111",
            campaignId: CAMPAIGN_ID,
            categoryPoolId: CATEGORY_POOL_ID,
            category: 7,
            donationEndMs: "1700000000",
        });
    });

    it("keeps large donation_end_ms as a string", () => {
        const result = parseCampaignCreatedEvent(
            campaignParsedJson({ donation_end_ms: "18446744073709551615" }),
        );

        expect(result?.donationEndMs).toBe("18446744073709551615");
    });

    it("returns null for malformed parsedJson", () => {
        expect(parseCampaignCreatedEvent({ campaign_id: "not-a-id" })).toBeNull();
    });
});

describe("parseCategoryPoolCreatedEvent", () => {
    it("returns deterministic category option for valid parsedJson", () => {
        const result = parseCategoryPoolCreatedEvent(categoryPoolParsedJson());

        expect(result).toEqual({
            kind: "category",
            id: CATEGORY_POOL_ID,
            label: "Category 7",
            categoryPoolId: CATEGORY_POOL_ID,
            category: 7,
        });
    });

    it("returns null for malformed parsedJson", () => {
        expect(parseCategoryPoolCreatedEvent({ category: 9999 })).toBeNull();
    });
});

describe("readDonateDestinations", () => {
    it("queries campaign/category event filters and returns combined options", async () => {
        const client = stubClient({
            [CAMPAIGN_TYPE]: [{ parsedJson: campaignParsedJson({ category: 9 }) }],
            [CATEGORY_POOL_TYPE]: [{ parsedJson: categoryPoolParsedJson({ category: 9 }) }],
        });

        const result = await readDonateDestinations(client, { packageId: PACKAGE_ID });

        expect(result).toEqual({
            kind: "ok",
            campaigns: [
                {
                    kind: "campaign",
                    id: CAMPAIGN_ID,
                    label: "Campaign 0x1111...1111",
                    campaignId: CAMPAIGN_ID,
                    categoryPoolId: CATEGORY_POOL_ID,
                    category: 9,
                    donationEndMs: "1700000000",
                },
            ],
            categories: [
                {
                    kind: "category",
                    id: CATEGORY_POOL_ID,
                    label: "Category 9",
                    categoryPoolId: CATEGORY_POOL_ID,
                    category: 9,
                },
            ],
        });

        const calls = (client.queryEvents as ReturnType<typeof vi.fn>).mock.calls;
        const queryTypes = calls.map(([input]) => input.query.MoveEventType);
        expect(queryTypes).toEqual([CAMPAIGN_TYPE, CATEGORY_POOL_TYPE]);
    });

    it("follows paged queryEvents responses", async () => {
        const nextCursor: DonateEventCursor = {
            txDigest: "digest",
            eventSeq: "1",
        };
        const queryEvents = vi.fn(async (input: {
            query: { MoveEventType: string };
            cursor?: DonateEventCursor | null;
        }) => {
            if (input.query.MoveEventType === CATEGORY_POOL_TYPE) {
                return { data: [], hasNextPage: false };
            }
            if (input.cursor === nextCursor) {
                return {
                    data: [{ parsedJson: campaignParsedJson({ category: 2 }) }],
                    hasNextPage: false,
                };
            }
            return {
                data: [{ parsedJson: campaignParsedJson({ category: 1 }) }],
                hasNextPage: true,
                nextCursor,
            };
        });
        const client: DonateDestinationReadClient = { queryEvents };

        const result = await readDonateDestinations(client, { packageId: PACKAGE_ID });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(result.campaigns.map((campaign) => campaign.category)).toEqual([1, 2]);
        expect(
            queryEvents.mock.calls.some((call) => call[0].cursor === nextCursor),
        ).toBe(true);
    });

    it("returns error when RPC query fails", async () => {
        const client: DonateDestinationReadClient = {
            queryEvents: vi.fn(async () => {
                throw new Error("rpc unavailable");
            }),
        };

        const result = await readDonateDestinations(client, { packageId: PACKAGE_ID });

        expect(result).toEqual({ kind: "error", message: "rpc unavailable" });
    });
});
