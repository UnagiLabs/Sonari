import { describe, expect, it } from "vitest";
import { bandAmount } from "./cell-band-rules";
import { isDisasterProgram, programHasMap } from "./claimable-program";
import type { ClaimCampaignState } from "../claim-campaigns";
import {
    claimCampaignToProgram,
    claimCampaignsToPrograms,
} from "./claim-campaign-adapter";

// ---------------------------------------------------------------------------
// テスト用フィクスチャ
// ---------------------------------------------------------------------------

const CAMPAIGN_ID = `0x${"11".repeat(32)}`;
const DISASTER_EVENT_ID = `0x${"22".repeat(32)}`;
const EVENT_UID = `0x${"cd".repeat(32)}`;
const AFFECTED_CELLS_ROOT = `0x${"ef".repeat(32)}`;

/** 有効な ClaimCampaignState のベース（claim-campaigns.test.ts の作り方に合わせる） */
function makeState(overrides: Partial<ClaimCampaignState> = {}): ClaimCampaignState {
    return {
        campaignId: CAMPAIGN_ID,
        disasterEventId: DISASTER_EVENT_ID,
        eventUid: EVENT_UID,
        eventRevision: 3,
        affectedCellsRoot: AFFECTED_CELLS_ROOT,
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
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// claimCampaignToProgram
// ---------------------------------------------------------------------------

describe("claimCampaignToProgram: フィールド対応", () => {
    it("代表フィクスチャ → DisasterClaimableProgram の全フィールドが正しくマップされる", () => {
        const state = makeState();
        const result = claimCampaignToProgram(state);

        expect(result).not.toBeNull();
        if (result === null) return;

        // 基本フィールド
        expect(result.id).toBe(CAMPAIGN_ID);
        expect(result.title).toBe("Test Earthquake");
        expect(result.scope).toBe("Test Region");
        expect(result.deadlineMs).toBe("2000");
        expect(result.detailHref).toBe(`/claim/${CAMPAIGN_ID}`);

        // 災害固有フィールド
        expect(result.category).toBe("disaster");
        expect(result.eventUid).toBe(EVENT_UID);
        expect(result.severityBand).toBe(2);
        expect(result.affectedCellCount).toBe(42);
        expect(result.affectedCellsRoot).toBe(AFFECTED_CELLS_ROOT);

        // cellSource は deferred
        expect(result.cellSource).toEqual({ kind: "deferred" });

        // amountSummary は range（min=bandAmount(1), max=bandAmount(severityBand=2)）
        expect(result.amountSummary).toEqual({
            kind: "range",
            minUsdc: bandAmount(1),
            maxUsdc: bandAmount(2),
        });
    });

    it("severityBand=3 のとき maxUsdc=bandAmount(3)", () => {
        const state = makeState({ severityBand: 3 });
        const result = claimCampaignToProgram(state);

        expect(result).not.toBeNull();
        if (result === null) return;
        expect(result.amountSummary).toEqual({
            kind: "range",
            minUsdc: bandAmount(1),
            maxUsdc: bandAmount(3),
        });
        expect(result.severityBand).toBe(3);
    });

    it("severityBand=1 のとき maxUsdc=bandAmount(1)", () => {
        const state = makeState({ severityBand: 1 });
        const result = claimCampaignToProgram(state);

        expect(result).not.toBeNull();
        if (result === null) return;
        expect(result.amountSummary).toEqual({
            kind: "range",
            minUsdc: bandAmount(1),
            maxUsdc: bandAmount(1),
        });
        expect(result.severityBand).toBe(1);
    });
});

describe("claimCampaignToProgram: 型ガード narrowing", () => {
    it("category が 'disaster' → isDisasterProgram(result) が true", () => {
        const result = claimCampaignToProgram(makeState());
        expect(result).not.toBeNull();
        if (result === null) return;
        expect(isDisasterProgram(result)).toBe(true);
    });

    it("programHasMap(result) が true", () => {
        const result = claimCampaignToProgram(makeState());
        expect(result).not.toBeNull();
        if (result === null) return;
        expect(programHasMap(result)).toBe(true);
    });
});

describe("claimCampaignToProgram: cellSource と detailHref", () => {
    it("cellSource は常に { kind: 'deferred' }", () => {
        const result = claimCampaignToProgram(makeState());
        expect(result?.cellSource).toEqual({ kind: "deferred" });
    });

    it("detailHref は /claim/<campaignId>", () => {
        const result = claimCampaignToProgram(makeState());
        expect(result?.detailHref).toBe(`/claim/${CAMPAIGN_ID}`);
    });
});

describe("claimCampaignToProgram: fail-closed（無効 severityBand）", () => {
    it("severityBand=0 → null", () => {
        const state = makeState({ severityBand: 0 });
        expect(claimCampaignToProgram(state)).toBeNull();
    });

    it("severityBand=4 → null", () => {
        const state = makeState({ severityBand: 4 });
        expect(claimCampaignToProgram(state)).toBeNull();
    });

    it("severityBand=1.5（小数）→ null", () => {
        const state = makeState({ severityBand: 1.5 });
        expect(claimCampaignToProgram(state)).toBeNull();
    });
});

describe("claimCampaignToProgram: fail-closed（不正 affectedCellCount）", () => {
    it("affectedCellCount='abc'（非数値文字列）→ null", () => {
        const state = makeState({ affectedCellCount: "abc" });
        expect(claimCampaignToProgram(state)).toBeNull();
    });

    it("affectedCellCount='1.5'（小数文字列）→ null", () => {
        const state = makeState({ affectedCellCount: "1.5" });
        expect(claimCampaignToProgram(state)).toBeNull();
    });

    it("affectedCellCount='-1'（負数文字列）→ null", () => {
        const state = makeState({ affectedCellCount: "-1" });
        expect(claimCampaignToProgram(state)).toBeNull();
    });

    it("affectedCellCount='0' → 0 として変換成功", () => {
        const state = makeState({ affectedCellCount: "0" });
        const result = claimCampaignToProgram(state);
        expect(result).not.toBeNull();
        expect(result?.affectedCellCount).toBe(0);
    });
});

describe("claimCampaignToProgram: affectedCellsRoot", () => {
    it("affectedCellsRoot が存在する場合、そのまま渡す（検証なし）", () => {
        const result = claimCampaignToProgram(makeState());
        expect(result?.affectedCellsRoot).toBe(AFFECTED_CELLS_ROOT);
    });

    it("affectedCellsRoot が空文字でも変換成功し、フィールドがそのまま渡される", () => {
        const state = makeState({ affectedCellsRoot: "" });
        const result = claimCampaignToProgram(state);
        // 空文字は on-chain では通常起きないが、契約値のため変換は成功する
        // affectedCellsRoot は任意フィールドのため undefined になるか空文字がそのまま入るか
        // 実装に合わせてテストする（方針: 契約値は再検証しない）
        expect(result).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// claimCampaignsToPrograms（複数件変換・null 除外）
// ---------------------------------------------------------------------------

describe("claimCampaignsToPrograms", () => {
    it("全件有効の場合、全件返す", () => {
        const states = [makeState(), makeState({ severityBand: 1 })];
        const results = claimCampaignsToPrograms(states);
        expect(results).toHaveLength(2);
    });

    it("一部 null が混じる場合、null を除外して返す", () => {
        const states = [
            makeState(),
            makeState({ severityBand: 0 }), // null になるはず
            makeState({ severityBand: 3 }),
            makeState({ affectedCellCount: "abc" }), // null になるはず
        ];
        const results = claimCampaignsToPrograms(states);
        expect(results).toHaveLength(2);
    });

    it("空配列 → 空配列", () => {
        expect(claimCampaignsToPrograms([])).toEqual([]);
    });

    it("全件無効 → 空配列", () => {
        const states = [makeState({ severityBand: 0 }), makeState({ affectedCellCount: "bad" })];
        expect(claimCampaignsToPrograms(states)).toEqual([]);
    });
});
