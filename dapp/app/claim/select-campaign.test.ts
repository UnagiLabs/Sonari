import { describe, expect, it } from "vitest";
import type { ClaimCampaignState } from "./claim-campaigns";
import { selectCampaignById } from "./select-campaign";

// テスト用の最小 ClaimCampaignState フィクスチャ。
// 証明・トランザクションで使うフィールド（eventRevision 等）を含む。
function makeState(campaignId: string): ClaimCampaignState {
    return {
        campaignId,
        disasterEventId: `0x${"22".repeat(32)}`,
        eventUid: `0x${"cd".repeat(32)}`,
        eventRevision: 3,
        affectedCellsRoot: `0x${"ef".repeat(32)}`,
        title: "Test Earthquake",
        region: "Test Region",
        severityBand: 2,
        affectedCellCount: "42",
        donationEndMs: "1500",
        claimEndMs: "2000",
        censusSet: true,
        floorBudgetReturned: false,
        claimWindowOpen: true,
        floorClaimAvailable: true,
        payoutFinalized: true,
        currentRound: "1",
        roundFinalizedAtMs: "1800",
        roundIntervalMs: "100",
    };
}

const STATE_A = makeState(`0x${"aa".repeat(32)}`);
const STATE_B = makeState(`0x${"bb".repeat(32)}`);
const STATE_C = makeState(`0x${"cc".repeat(32)}`);

describe("selectCampaignById", () => {
    it("一致する campaign が1件のとき、その ClaimCampaignState を返す", () => {
        const result = selectCampaignById([STATE_A], STATE_A.campaignId);
        expect(result).toBe(STATE_A);
    });

    it("eventRevision など全フィールドを含む state オブジェクトを返す", () => {
        const result = selectCampaignById([STATE_A], STATE_A.campaignId);
        expect(result?.eventRevision).toBe(3);
        expect(result?.eventUid).toBe(`0x${"cd".repeat(32)}`);
        expect(result?.affectedCellsRoot).toBe(`0x${"ef".repeat(32)}`);
    });

    it("一致しない campaignId なら null を返す", () => {
        const result = selectCampaignById([STATE_A], STATE_B.campaignId);
        expect(result).toBeNull();
    });

    it("空配列なら null を返す", () => {
        const result = selectCampaignById([], STATE_A.campaignId);
        expect(result).toBeNull();
    });

    it("複数 campaign の中から正しい1件を返す", () => {
        const campaigns = [STATE_A, STATE_B, STATE_C] as const;
        expect(selectCampaignById(campaigns, STATE_B.campaignId)).toBe(STATE_B);
        expect(selectCampaignById(campaigns, STATE_C.campaignId)).toBe(STATE_C);
    });
});
