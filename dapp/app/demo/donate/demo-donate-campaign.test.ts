import { describe, expect, it } from "vitest";
import { TOHOKU_2011_DEMO_EARTHQUAKE } from "../_data/tohoku-2011";
import {
    buildTohokuEmergencyCampaign,
    TOHOKU_DEMO_CAMPAIGN_ID,
    type TohokuEmergencyLabels,
} from "./demo-donate-campaign";

// ラベルは識別しやすい sentinel にして、値が固定データ由来であることを検証する。
const labels: TohokuEmergencyLabels = {
    status: "STATUS",
    magnitude: "MAGNITUDE",
    mmi: "MMI",
    region: "REGION",
    date: "DATE",
    affectedCells: "AFFECTED_CELLS",
    h3Resolution: "H3_RESOLUTION",
    epicenter: "EPICENTER",
};

describe("buildTohokuEmergencyCampaign", () => {
    const campaign = buildTohokuEmergencyCampaign(labels, TOHOKU_2011_DEMO_EARTHQUAKE);

    it("uses the fixed demo campaign id and the fixture title as the label", () => {
        expect(campaign.id).toBe(TOHOKU_DEMO_CAMPAIGN_ID);
        expect(campaign.label).toBe("M 9.1 - 2011 Great Tohoku Earthquake, Japan");
    });

    it("carries the localized status text", () => {
        expect(campaign.status).toBe("STATUS");
    });

    it("builds detail values from the fixture data (M9.1 etc.)", () => {
        const byLabel = new Map(campaign.details?.map((d) => [d.label, d.value]));
        expect(byLabel.get("MAGNITUDE")).toBe("M 9.1");
        expect(byLabel.get("MMI")).toBe("8.18");
        expect(byLabel.get("REGION")).toBe("2011 Great Tohoku Earthquake, Japan");
        expect(byLabel.get("DATE")).toBe("2011-03-11");
        expect(byLabel.get("AFFECTED_CELLS")).toBe("18,429");
        expect(byLabel.get("H3_RESOLUTION")).toBe("7");
        expect(byLabel.get("EPICENTER")).toBe("38.297°N, 142.373°E, 29 km");
    });

    it("exposes a non-empty details list so the banner renders the summary", () => {
        expect(campaign.details).toBeDefined();
        expect(campaign.details?.length).toBeGreaterThan(0);
    });
});
