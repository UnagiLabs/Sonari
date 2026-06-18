import { describe, expect, it } from "vitest";
import type { ClaimCampaignState } from "../claim/claim-campaigns";
import {
    type DisasterPoolView,
    buildDisasterPoolViews,
} from "./disaster-pool-view-model";

// ---------------------------------------------------------------------------
// テスト用定数
// ---------------------------------------------------------------------------

const CAMPAIGN_ID_A = `0x${"11".repeat(32)}`;
const CAMPAIGN_ID_B = `0x${"22".repeat(32)}`;
const DISASTER_EVENT_ID_A = `0x${"aa".repeat(32)}`;
const DISASTER_EVENT_ID_B = `0x${"bb".repeat(32)}`;
const EVENT_UID = `0x${"cd".repeat(32)}`;
const AFFECTED_CELLS_ROOT = `0x${"ef".repeat(32)}`;

const NOW_MS = 2_000_000;
const DONATION_END_FUTURE = String(NOW_MS + 1_000_000);
const DONATION_END_PAST = String(NOW_MS - 1_000);

// ---------------------------------------------------------------------------
// フィクスチャヘルパー
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<ClaimCampaignState> = {}): ClaimCampaignState {
    return {
        campaignId: CAMPAIGN_ID_A,
        disasterEventId: DISASTER_EVENT_ID_A,
        eventUid: EVENT_UID,
        eventRevision: 1,
        affectedCellsRoot: AFFECTED_CELLS_ROOT,
        title: "Test Earthquake",
        region: "Test Region",
        severityBand: 2,
        affectedCellCount: "42",
        donationEndMs: DONATION_END_FUTURE,
        claimEndMs: String(NOW_MS + 5_000_000),
        censusSet: false,
        floorBudgetReturned: false,
        claimWindowOpen: true,
        floorClaimAvailable: false,
        payoutFinalized: false,
        currentRound: "0",
        roundFinalizedAtMs: "0",
        roundIntervalMs: "86400000",
        balanceUsdc: null,
        totalDonatedUsdc: null,
        totalPaidUsdc: null,
        closed: null,
        paused: null,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe("buildDisasterPoolViews", () => {
    it("returns empty array for empty input", () => {
        expect(buildDisasterPoolViews([], NOW_MS)).toEqual([]);
    });

    it("maps essential fields correctly", () => {
        const state = makeState({ balanceUsdc: 5_000_000 });
        const views = buildDisasterPoolViews([state], NOW_MS);
        expect(views).toHaveLength(1);
        const v = views[0] as DisasterPoolView;
        expect(v.disasterEventId).toBe(DISASTER_EVENT_ID_A);
        expect(v.campaignId).toBe(CAMPAIGN_ID_A);
        expect(v.title).toBe("Test Earthquake");
        expect(v.region).toBe("Test Region");
        expect(v.affectedCellCount).toBe(42);
        expect(v.donationEndMs).toBe(Number(DONATION_END_FUTURE));
        expect(v.claimEndMs).toBe(NOW_MS + 5_000_000);
        expect(v.href).toBe(`/donate/${DISASTER_EVENT_ID_A}`);
    });

    it("href is always /donate/<disasterEventId>", () => {
        const state = makeState({ disasterEventId: DISASTER_EVENT_ID_B });
        const views = buildDisasterPoolViews([state], NOW_MS);
        expect((views[0] as DisasterPoolView).href).toBe(`/donate/${DISASTER_EVENT_ID_B}`);
    });

    // -----------------------------------------------------------------------
    // status 判定
    // -----------------------------------------------------------------------

    it("status: active when not closed, not paused, donation end in future", () => {
        const v = buildDisasterPoolViews([makeState({ closed: false, paused: false })], NOW_MS)[0] as DisasterPoolView;
        expect(v.status).toBe("active");
    });

    it("status: active when closed/paused are null and donation end in future", () => {
        const v = buildDisasterPoolViews([makeState({ closed: null, paused: null })], NOW_MS)[0] as DisasterPoolView;
        expect(v.status).toBe("active");
    });

    it("status: ended when donation end is past (not closed, not paused)", () => {
        const v = buildDisasterPoolViews(
            [makeState({ closed: false, paused: false, donationEndMs: DONATION_END_PAST })],
            NOW_MS,
        )[0] as DisasterPoolView;
        expect(v.status).toBe("ended");
    });

    it("status: ended when donationEndMs equals nowMs", () => {
        const v = buildDisasterPoolViews(
            [makeState({ closed: false, paused: false, donationEndMs: String(NOW_MS) })],
            NOW_MS,
        )[0] as DisasterPoolView;
        expect(v.status).toBe("ended");
    });

    it("status: paused when paused=true and not closed", () => {
        const v = buildDisasterPoolViews(
            [makeState({ closed: false, paused: true, donationEndMs: DONATION_END_FUTURE })],
            NOW_MS,
        )[0] as DisasterPoolView;
        expect(v.status).toBe("paused");
    });

    it("status: closed when closed=true (takes priority over paused)", () => {
        const v = buildDisasterPoolViews(
            [makeState({ closed: true, paused: true, donationEndMs: DONATION_END_FUTURE })],
            NOW_MS,
        )[0] as DisasterPoolView;
        expect(v.status).toBe("closed");
    });

    it("status: closed takes priority over ended (past donation end)", () => {
        const v = buildDisasterPoolViews(
            [makeState({ closed: true, paused: false, donationEndMs: DONATION_END_PAST })],
            NOW_MS,
        )[0] as DisasterPoolView;
        expect(v.status).toBe("closed");
    });

    // -----------------------------------------------------------------------
    // 金額整形
    // -----------------------------------------------------------------------

    it("formats balanceUsdc 1_000_000 micro as '$1.00'", () => {
        const v = buildDisasterPoolViews([makeState({ balanceUsdc: 1_000_000 })], NOW_MS)[0] as DisasterPoolView;
        expect(v.balanceUsdc).toBe(1_000_000);
        expect(v.balanceLabel).toBe("$1.00");
    });

    it("formats balanceUsdc 1_500_000 micro as '$1.50'", () => {
        const v = buildDisasterPoolViews([makeState({ balanceUsdc: 1_500_000 })], NOW_MS)[0] as DisasterPoolView;
        expect(v.balanceLabel).toBe("$1.50");
    });

    it("formats totalDonatedUsdc and totalPaidUsdc", () => {
        const v = buildDisasterPoolViews(
            [makeState({ totalDonatedUsdc: 8_000_000, totalPaidUsdc: 3_000_000 })],
            NOW_MS,
        )[0] as DisasterPoolView;
        expect(v.totalDonatedUsdc).toBe(8_000_000);
        expect(v.totalDonatedLabel).toBe("$8.00");
        expect(v.totalPaidUsdc).toBe(3_000_000);
        expect(v.totalPaidLabel).toBe("$3.00");
    });

    it("uses safe placeholder '-' when balanceUsdc is null", () => {
        const v = buildDisasterPoolViews([makeState({ balanceUsdc: null })], NOW_MS)[0] as DisasterPoolView;
        expect(v.balanceUsdc).toBeNull();
        expect(v.balanceLabel).toBe("-");
    });

    it("uses safe placeholder '-' when totalDonatedUsdc/totalPaidUsdc are null", () => {
        const v = buildDisasterPoolViews(
            [makeState({ totalDonatedUsdc: null, totalPaidUsdc: null })],
            NOW_MS,
        )[0] as DisasterPoolView;
        expect(v.totalDonatedLabel).toBe("-");
        expect(v.totalPaidLabel).toBe("-");
    });

    // -----------------------------------------------------------------------
    // ソート: donationEndMs 降順 → campaignId 昇順（安定）
    // -----------------------------------------------------------------------

    it("sorts by donationEndMs descending", () => {
        const older = makeState({
            campaignId: CAMPAIGN_ID_A,
            disasterEventId: DISASTER_EVENT_ID_A,
            donationEndMs: String(NOW_MS + 100_000),
        });
        const newer = makeState({
            campaignId: CAMPAIGN_ID_B,
            disasterEventId: DISASTER_EVENT_ID_B,
            donationEndMs: String(NOW_MS + 900_000),
        });
        const views = buildDisasterPoolViews([older, newer], NOW_MS);
        expect(views[0]?.campaignId).toBe(CAMPAIGN_ID_B);
        expect(views[1]?.campaignId).toBe(CAMPAIGN_ID_A);
    });

    it("does not mutate the input array", () => {
        const states: ClaimCampaignState[] = [
            makeState({ campaignId: CAMPAIGN_ID_A, donationEndMs: String(NOW_MS + 100_000) }),
            makeState({ campaignId: CAMPAIGN_ID_B, donationEndMs: String(NOW_MS + 900_000) }),
        ];
        const original = [...states];
        buildDisasterPoolViews(states, NOW_MS);
        expect(states[0]?.campaignId).toBe(original[0]?.campaignId);
        expect(states[1]?.campaignId).toBe(original[1]?.campaignId);
    });

    it("stable sort: same donationEndMs sorted by campaignId ascending", () => {
        const a = makeState({
            campaignId: CAMPAIGN_ID_A,
            disasterEventId: DISASTER_EVENT_ID_A,
            donationEndMs: String(NOW_MS + 500_000),
        });
        const b = makeState({
            campaignId: CAMPAIGN_ID_B,
            disasterEventId: DISASTER_EVENT_ID_B,
            donationEndMs: String(NOW_MS + 500_000),
        });
        const views = buildDisasterPoolViews([b, a], NOW_MS);
        // CAMPAIGN_ID_A ("0x11...") < CAMPAIGN_ID_B ("0x22...")
        expect(views[0]?.campaignId).toBe(CAMPAIGN_ID_A);
        expect(views[1]?.campaignId).toBe(CAMPAIGN_ID_B);
    });
});
