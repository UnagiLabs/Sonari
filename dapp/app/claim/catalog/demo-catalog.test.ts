import { describe, expect, it } from "vitest";
import { bandAmount } from "./cell-band-rules";
import {
    DEMO_AFFECTED_HOME_CELL_BAND1,
    DEMO_AFFECTED_HOME_CELL_BAND3,
    DEMO_CLAIMABLE_PROGRAMS,
} from "./demo-catalog";
import {
    isDisasterProgram,
    parseClaimableProgram,
    programHasMap,
} from "./claimable-program";

// ---------------------------------------------------------------------------
// 3カテゴリが揃うこと
// ---------------------------------------------------------------------------

describe("DEMO_CLAIMABLE_PROGRAMS", () => {
    it("contains at least one disaster program", () => {
        const found = DEMO_CLAIMABLE_PROGRAMS.some((p) => p.category === "disaster");
        expect(found).toBe(true);
    });

    it("contains at least one student-fund program", () => {
        const found = DEMO_CLAIMABLE_PROGRAMS.some((p) => p.category === "student-fund");
        expect(found).toBe(true);
    });

    it("contains at least one medical program", () => {
        const found = DEMO_CLAIMABLE_PROGRAMS.some((p) => p.category === "medical");
        expect(found).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 災害エントリ（東日本大震災 2011）のメタ検証
// ---------------------------------------------------------------------------

describe("disaster entry (tohoku-2011)", () => {
    // narrowing: find then guard so disaster-only fields are type-safe
    const raw = DEMO_CLAIMABLE_PROGRAMS.find(
        (p) => p.category === "disaster" && p.id === "tohoku-2011",
    );
    const entry = raw !== undefined && isDisasterProgram(raw) ? raw : undefined;

    it("entry exists", () => {
        expect(entry).toBeDefined();
    });

    it("eventUid matches fixture value from unsigned_payload.json", () => {
        expect(entry?.eventUid).toBe(
            "0x552d0b5280b31910b6ff306632e05e9f2c0b4e9176d8ddba77d20a5e22d7a622",
        );
    });

    it("affectedCellsRoot matches fixture value from unsigned_payload.json", () => {
        expect(entry?.affectedCellsRoot).toBe(
            "0x51cd4a4ddc99acbad52b6e5b0003827f9a5b27501f3fc902c8e025a1a92a59ee",
        );
    });

    it("cellSource is static-asset with correct path (STEP 5 static asset)", () => {
        expect(entry?.cellSource).toStrictEqual({
            kind: "static-asset",
            path: "/demo/tohoku-2011-affected-cells.json",
        });
    });

    it("severityBand is 3", () => {
        expect(entry?.severityBand).toBe(3);
    });

    it("affectedCellCount is 39221", () => {
        expect(entry?.affectedCellCount).toBe(39221);
    });

    it("amountSummary is range with min=bandAmount(1) and max=bandAmount(3)", () => {
        expect(entry?.amountSummary).toStrictEqual({
            kind: "range",
            minUsdc: bandAmount(1),
            maxUsdc: bandAmount(3),
        });
    });

    it("detailHref points to /demo/claim/tohoku-2011", () => {
        expect(entry?.detailHref).toBe("/demo/claim/tohoku-2011");
    });
});

// ---------------------------------------------------------------------------
// 学生支援基金・医療プログラム: 地図なし・fixed 金額
// ---------------------------------------------------------------------------

describe("student-fund program", () => {
    const entry = DEMO_CLAIMABLE_PROGRAMS.find((p) => p.category === "student-fund");

    it("entry exists", () => {
        expect(entry).toBeDefined();
    });

    it("programHasMap returns false", () => {
        if (entry === undefined) throw new Error("entry not found");
        expect(programHasMap(entry)).toBe(false);
    });

    it("amountSummary is fixed", () => {
        expect(entry?.amountSummary.kind).toBe("fixed");
    });
});

describe("medical program", () => {
    const entry = DEMO_CLAIMABLE_PROGRAMS.find((p) => p.category === "medical");

    it("entry exists", () => {
        expect(entry).toBeDefined();
    });

    it("programHasMap returns false", () => {
        if (entry === undefined) throw new Error("entry not found");
        expect(programHasMap(entry)).toBe(false);
    });

    it("amountSummary is fixed", () => {
        expect(entry?.amountSummary.kind).toBe("fixed");
    });
});

// ---------------------------------------------------------------------------
// 代表居住セル定数
// ---------------------------------------------------------------------------

describe("DEMO_AFFECTED_HOME_CELL_BAND3", () => {
    it("is the expected band3 cell (decimal H3, res7)", () => {
        expect(DEMO_AFFECTED_HOME_CELL_BAND3).toBe("608795190286614527");
    });
});

describe("DEMO_AFFECTED_HOME_CELL_BAND1", () => {
    it("is the expected band1 cell (decimal H3, res7)", () => {
        expect(DEMO_AFFECTED_HOME_CELL_BAND1).toBe("608795262395088895");
    });
});

// ---------------------------------------------------------------------------
// （任意）各エントリが parseClaimableProgram を通る
// ---------------------------------------------------------------------------

describe("each program passes parseClaimableProgram", () => {
    for (const program of DEMO_CLAIMABLE_PROGRAMS) {
        it(`parses successfully: ${program.id}`, () => {
            const result = parseClaimableProgram(program);
            expect(result).not.toBeNull();
        });
    }
});
