import { describe, expect, it } from "vitest";
import {
    buildEmergencyBannerView,
    type EmergencyBannerCampaign,
    type EmergencyBannerDetail,
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

    it("propagates status and details when provided", () => {
        const details: readonly EmergencyBannerDetail[] = [
            { label: "マグニチュード", value: "7.6" },
            { label: "地域", value: "能登半島" },
        ];
        const campaignWithExtras: EmergencyBannerCampaign = {
            ...campaign,
            status: "実施中",
            details,
        };
        const view = buildEmergencyBannerView(campaignWithExtras);
        expect(view?.status).toBe("実施中");
        expect(view?.details).toStrictEqual(details);
    });

    it("omits details key when details is an empty array", () => {
        const campaignEmptyDetails: EmergencyBannerCampaign = {
            ...campaign,
            details: [],
        };
        const view = buildEmergencyBannerView(campaignEmptyDetails);
        expect(Object.keys(view ?? {})).not.toContain("details");
    });

    it("omits status key when status is not provided", () => {
        const view = buildEmergencyBannerView(campaign);
        expect(Object.keys(view ?? {})).not.toContain("status");
    });

    it("returns keys in order [campaignId, label, status, details] when both are provided", () => {
        const campaignFull: EmergencyBannerCampaign = {
            ...campaign,
            status: "実施中",
            details: [{ label: "地域", value: "能登" }],
        };
        const view = buildEmergencyBannerView(campaignFull);
        expect(Object.keys(view ?? {})).toStrictEqual([
            "campaignId",
            "label",
            "status",
            "details",
        ]);
    });
});
