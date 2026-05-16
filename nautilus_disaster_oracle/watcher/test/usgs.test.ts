import { describe, expect, it } from "vitest";
import { parseUsgsRecentFeed, USGS_RECENT_FEED_URL } from "../src/usgs.js";

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
                        },
                    },
                ],
            }),
        ).toEqual([
            {
                source_event_id: "us7000sonari",
                occurred_at_ms: 1_700_000_000_000,
                source_updated_at_ms: 1_700_000_010_000,
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
