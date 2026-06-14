import { describe, expect, it } from "vitest";
import {
    buildEmergencyBannerView,
    type EmergencyBannerCampaign,
} from "./emergency-banner-state";

const campaign: EmergencyBannerCampaign = {
    id: "0x0000000000000000000000000000000000000000000000000000000000000abc",
    label: "Earthquake Relief Pool",
};

describe("buildEmergencyBannerView", () => {
    it("returns null when campaign is null (no banner to show)", () => {
        expect(buildEmergencyBannerView(null)).toBeNull();
    });

    it("returns a view model with campaignId equal to campaign.id", () => {
        const view = buildEmergencyBannerView(campaign);
        expect(view).not.toBeNull();
        expect(view?.campaignId).toBe(campaign.id);
    });

    it("returns a view model with the campaign label", () => {
        const view = buildEmergencyBannerView(campaign);
        expect(view?.label).toBe("Earthquake Relief Pool");
    });

    it("returns a stable shape: { campaignId, label }", () => {
        const view = buildEmergencyBannerView(campaign);
        expect(Object.keys(view ?? {})).toStrictEqual(["campaignId", "label"]);
    });
});
