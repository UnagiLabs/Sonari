import { describe, expect, it } from "vitest";
import {
    screenUsgsCandidate,
    WATCHER_ALERT_LEVELS,
    WATCHER_MIN_MAGNITUDE,
    WATCHER_MIN_SUMMARY_MMI,
} from "../src/screening.js";
import type { UsgsEarthquakeCandidate } from "../src/usgs.js";

function candidate(patch: Partial<UsgsEarthquakeCandidate> = {}): UsgsEarthquakeCandidate {
    return {
        source_event_id: "us7000sonari",
        occurred_at_ms: 1_800_000_000_000,
        source_updated_at_ms: 1_800_000_010_000,
        magnitude: null,
        summary_mmi: null,
        alert: null,
        tsunami: false,
        ...patch,
    };
}

describe("USGS watcher auto-screening", () => {
    it("exports the auto-screening thresholds", () => {
        expect(WATCHER_MIN_MAGNITUDE).toBe(5.5);
        expect(WATCHER_MIN_SUMMARY_MMI).toBe(6.0);
        expect(WATCHER_ALERT_LEVELS).toEqual(["yellow", "orange", "red"]);
    });

    it.each([
        ["magnitude at the threshold", { magnitude: 5.5 }],
        ["summary MMI at the threshold", { summary_mmi: 6.0 }],
        ["yellow alert", { alert: "yellow" as const }],
        ["orange alert", { alert: "orange" as const }],
        ["red alert", { alert: "red" as const }],
        ["tsunami flag", { tsunami: true }],
    ])("marks %s as runner eligible", (_name, patch) => {
        expect(screenUsgsCandidate(candidate(patch))).toEqual({
            runnerEligible: true,
            status: "new",
            error_code: null,
        });
    });

    it.each([
        ["magnitude below the threshold", { magnitude: 5.499 }],
        ["summary MMI below the threshold", { summary_mmi: 5.999 }],
        ["green alert", { alert: "green" as const }],
        ["null summary fields", {}],
    ])("ignores %s", (_name, patch) => {
        expect(screenUsgsCandidate(candidate(patch))).toEqual({
            runnerEligible: false,
            status: "ignored_small",
            error_code: "WATCHER_BELOW_AUTO_THRESHOLD",
        });
    });
});
