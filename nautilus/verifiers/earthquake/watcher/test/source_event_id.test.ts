import { describe, expect, it } from "vitest";
import { isValidUsgsSourceEventId } from "../src/source_event_id.js";

describe("USGS source event ID validation", () => {
    it("accepts canonical, alias, and existing fixture IDs while rejecting unsafe IDs", () => {
        expect(isValidUsgsSourceEventId("official20110311054624120_30")).toBe(true);
        expect(isValidUsgsSourceEventId("usc0001xgp")).toBe(true);
        expect(isValidUsgsSourceEventId("us7000pending-source")).toBe(true);
        expect(isValidUsgsSourceEventId("us7000pending-mmi")).toBe(true);
        expect(isValidUsgsSourceEventId("us7000no-affected")).toBe(true);

        expect(isValidUsgsSourceEventId("__sonari_runner_workflow_lock__")).toBe(false);
        expect(isValidUsgsSourceEventId("_official20110311054624120_30")).toBe(false);
        expect(isValidUsgsSourceEventId("us7000/bad")).toBe(false);
        expect(isValidUsgsSourceEventId("us7000$(touch bad)")).toBe(false);
        expect(isValidUsgsSourceEventId("us7000 bad")).toBe(false);
    });
});
