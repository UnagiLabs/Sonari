import { describe, expect, it } from "vitest";
import {
    parseUsgsRecentFeed,
    resolveUsgsSourceEventId,
    USGS_RECENT_FEED_URL,
    usgsDetailUrl,
} from "../src/usgs.js";

describe("USGS recent feed parser", () => {
    it("extracts earthquake candidates with id, occurred time, and source update time", () => {
        expect(
            parseUsgsRecentFeed({
                features: [
                    {
                        id: "us7000sonari",
                        properties: {
                            time: 1_700_000_000_000,
                            updated: 1_700_000_010_000,
                            type: "earthquake",
                            detail: "http://169.254.169.254/latest/meta-data",
                            mag: 5.6,
                            mmi: 6.2,
                            alert: "orange",
                            tsunami: 1,
                        },
                    },
                ],
            }),
        ).toEqual([
            {
                source_event_id: "us7000sonari",
                occurred_at_ms: 1_700_000_000_000,
                source_updated_at_ms: 1_700_000_010_000,
                magnitude: 5.6,
                summary_mmi: 6.2,
                alert: "orange",
                tsunami: true,
            },
        ]);
    });

    it("normalizes optional summary fields without trusting invalid values", () => {
        expect(
            parseUsgsRecentFeed({
                features: [
                    {
                        id: "us7000small",
                        properties: {
                            time: 1_700_000_000_000,
                            updated: 1_700_000_010_000,
                            type: "earthquake",
                            mag: "5.6",
                            mmi: Number.POSITIVE_INFINITY,
                            alert: "blue",
                            tsunami: 2,
                        },
                    },
                    {
                        id: "us7000green",
                        properties: {
                            time: 1_700_000_000_000,
                            updated: 1_700_000_010_000,
                            type: "earthquake",
                            mag: Number.NaN,
                            mmi: null,
                            alert: "green",
                            tsunami: 0,
                        },
                    },
                ],
            }),
        ).toEqual([
            {
                source_event_id: "us7000small",
                occurred_at_ms: 1_700_000_000_000,
                source_updated_at_ms: 1_700_000_010_000,
                magnitude: null,
                summary_mmi: null,
                alert: null,
                tsunami: false,
            },
            {
                source_event_id: "us7000green",
                occurred_at_ms: 1_700_000_000_000,
                source_updated_at_ms: 1_700_000_010_000,
                magnitude: null,
                summary_mmi: null,
                alert: "green",
                tsunami: false,
            },
        ]);
    });

    it("ignores incomplete features", () => {
        expect(
            parseUsgsRecentFeed({
                features: [
                    { properties: { time: 1, updated: 2, type: "earthquake" } },
                    { id: "missing-time", properties: { updated: 2, type: "earthquake" } },
                    { id: "missing-updated", properties: { time: 1, type: "earthquake" } },
                ],
            }),
        ).toEqual([]);
    });

    it("ignores non-earthquake features and pins the all-hour feed", () => {
        expect(
            parseUsgsRecentFeed({
                features: [
                    {
                        id: "quarry-blast",
                        properties: { time: 1, updated: 2, type: "quarry blast" },
                    },
                ],
            }),
        ).toEqual([]);
        expect(USGS_RECENT_FEED_URL).toBe(
            "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
        );
    });
});

describe("USGS source event ID resolver", () => {
    it("fetches the deterministic USGS detail URL derived from the source event ID", async () => {
        const requestedUrls: string[] = [];
        const fetcher = async (url: Parameters<typeof fetch>[0]) => {
            requestedUrls.push(String(url));
            return responseJson({
                id: "usc0001xgp",
                properties: {
                    ids: ",usc0001xgp,",
                },
            });
        };

        await expect(
            resolveUsgsSourceEventId({ sourceEventId: "usc0001xgp" }, fetcher),
        ).resolves.toEqual({ source_event_id: "usc0001xgp" });
        expect(requestedUrls).toEqual([usgsDetailUrl("usc0001xgp")]);
    });

    it("resolves alias detail responses to canonical IDs only when properties.ids contains an exact match", async () => {
        const fetcher = async () =>
            responseJson({
                id: "official20110311054624120_30",
                properties: {
                    ids: ",usc0001xgp,official20110311054624120_30,",
                },
            });

        await expect(
            resolveUsgsSourceEventId({ sourceEventId: "usc0001xgp" }, fetcher),
        ).resolves.toEqual({
            source_event_id: "official20110311054624120_30",
            requested_source_event_id: "usc0001xgp",
        });
    });

    it("rejects USGS detail IDs that only substring-match the requested alias", async () => {
        const fetcher = async () =>
            responseJson({
                id: "official20110311054624120_30",
                properties: {
                    ids: ",usc0001xgp-extra,official20110311054624120_30,",
                },
            });

        await expect(
            resolveUsgsSourceEventId({ sourceEventId: "usc0001xgp" }, fetcher),
        ).resolves.toBeNull();
    });

    it("falls back to the requested ID when detail is temporarily unavailable", async () => {
        const fetcher = async () => responseJson({ message: "unavailable" }, false);

        await expect(
            resolveUsgsSourceEventId({ sourceEventId: "usc0001xgp" }, fetcher),
        ).resolves.toEqual({ source_event_id: "usc0001xgp" });
    });
});

function responseJson(body: unknown, ok = true): Response {
    return {
        ok,
        async json(): Promise<unknown> {
            return body;
        },
    } as Response;
}
