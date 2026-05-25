import { describe, expect, it } from "vitest";
import { isValidUsgsSourceEventId } from "../src/source_event_id.js";

describe("USGS source event ID validation", () => {
    it("accepts existing hyphenated fixture IDs and rejects unsafe IDs", () => {
        expect(isValidUsgsSourceEventId("us7000pending-source")).toBe(true);
        expect(isValidUsgsSourceEventId("us7000pending-mmi")).toBe(true);
        expect(isValidUsgsSourceEventId("us7000no-affected")).toBe(true);

        expect(isValidUsgsSourceEventId("__sonari_runner_workflow_lock__")).toBe(false);
        expect(isValidUsgsSourceEventId("us7000/bad")).toBe(false);
        expect(isValidUsgsSourceEventId("us7000$(touch bad)")).toBe(false);
    });
});
