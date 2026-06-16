import { describe, expect, it } from "vitest";
import { DEMO_CLAIMABLE_PROGRAMS } from "./demo-catalog";
import { selectDemoProgramById } from "./select-demo-program";
import type { ClaimableProgram } from "./claimable-program";

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const PROGRAM_DISASTER: ClaimableProgram = {
    id: "tohoku-2011",
    category: "disaster",
    title: "東日本大震災 2011",
    scope: "岩手・宮城・福島県",
    amountSummary: { kind: "range", minUsdc: 100, maxUsdc: 300 },
    deadlineMs: "1767214799000",
    detailHref: "/demo/claim/tohoku-2011",
    eventUid: "0x0000000000000000000000000000000000000000000000000000000000000001",
    eventRevision: 1,
    severityBand: 3,
    affectedCellCount: 42,
    cellSource: { kind: "static-asset", path: "/demo/tohoku-2011/affected-cells.json" },
    affectedAreaArtifact: {
        kind: "tiled-affected-cells",
        manifestPath: "/demo/tohoku-2011/affected-area-manifest.json",
    },
};

const PROGRAM_STUDENT: ClaimableProgram = {
    id: "student-fund-2025",
    category: "student-fund",
    title: "緊急学生支援基金 2025",
    scope: "国内在籍の大学・大学院・専門学校生（所得制限あり）",
    amountSummary: { kind: "fixed", usdc: 500 },
    deadlineMs: "1759294799000",
    detailHref: "/demo/claim/student-fund-2025",
};

const PROGRAM_MEDICAL: ClaimableProgram = {
    id: "medical-support-2025",
    category: "medical",
    title: "医療・難病支援プログラム 2025",
    scope: "指定難病または長期療養中の患者（診断書提出必須）",
    amountSummary: { kind: "fixed", usdc: 300 },
    deadlineMs: "1767214799000",
    detailHref: "/demo/claim/medical-support-2025",
};

const ALL_PROGRAMS = [PROGRAM_DISASTER, PROGRAM_STUDENT, PROGRAM_MEDICAL] as const;

// ---------------------------------------------------------------------------
// selectDemoProgramById
// ---------------------------------------------------------------------------

describe("selectDemoProgramById", () => {
    it("一致する id が1件のとき、その ClaimableProgram を返す", () => {
        const result = selectDemoProgramById([PROGRAM_DISASTER], "tohoku-2011");
        expect(result).toBe(PROGRAM_DISASTER);
    });

    it("disaster プログラムの id が一致するとき category も一致する", () => {
        const result = selectDemoProgramById(ALL_PROGRAMS, "tohoku-2011");
        expect(result?.id).toBe("tohoku-2011");
        expect(result?.category).toBe("disaster");
    });

    it("student-fund プログラムの id が一致するとき category も一致する", () => {
        const result = selectDemoProgramById(ALL_PROGRAMS, "student-fund-2025");
        expect(result?.id).toBe("student-fund-2025");
        expect(result?.category).toBe("student-fund");
    });

    it("medical プログラムの id が一致するとき category も一致する", () => {
        const result = selectDemoProgramById(ALL_PROGRAMS, "medical-support-2025");
        expect(result?.id).toBe("medical-support-2025");
        expect(result?.category).toBe("medical");
    });

    it("未知の id なら null を返す", () => {
        const result = selectDemoProgramById(ALL_PROGRAMS, "nope");
        expect(result).toBeNull();
    });

    it("空配列なら null を返す", () => {
        const result = selectDemoProgramById([], "tohoku-2011");
        expect(result).toBeNull();
    });

    it("複数プログラムの中から正しい1件を返す", () => {
        expect(selectDemoProgramById(ALL_PROGRAMS, "student-fund-2025")).toBe(PROGRAM_STUDENT);
        expect(selectDemoProgramById(ALL_PROGRAMS, "medical-support-2025")).toBe(PROGRAM_MEDICAL);
    });

    it("入力配列を破壊しない（immutable 検証）", () => {
        const programs: ClaimableProgram[] = [PROGRAM_DISASTER, PROGRAM_STUDENT];
        const copy = [...programs];
        selectDemoProgramById(programs, "tohoku-2011");
        expect(programs).toEqual(copy);
    });
});

// ---------------------------------------------------------------------------
// DEMO_CLAIMABLE_PROGRAMS との整合: detailHref が /demo/claim/<id> であること
//
// 一覧→詳細リンクの整合をここで静的に担保する。リンク先ミスを早期検出。
// ---------------------------------------------------------------------------

describe("DEMO_CLAIMABLE_PROGRAMS 整合検証", () => {
    it("各 program の detailHref が /demo/claim/<id> の形式であること", () => {
        for (const program of DEMO_CLAIMABLE_PROGRAMS) {
            expect(program.detailHref).toBe(`/demo/claim/${program.id}`);
        }
    });

    it("DEMO_CLAIMABLE_PROGRAMS から tohoku-2011 を selectDemoProgramById で引ける", () => {
        const result = selectDemoProgramById(DEMO_CLAIMABLE_PROGRAMS, "tohoku-2011");
        expect(result?.id).toBe("tohoku-2011");
        expect(result?.category).toBe("disaster");
    });

    it("DEMO_CLAIMABLE_PROGRAMS から student-fund-2025 を selectDemoProgramById で引ける", () => {
        const result = selectDemoProgramById(DEMO_CLAIMABLE_PROGRAMS, "student-fund-2025");
        expect(result?.id).toBe("student-fund-2025");
        expect(result?.category).toBe("student-fund");
    });

    it("DEMO_CLAIMABLE_PROGRAMS から medical-support-2025 を selectDemoProgramById で引ける", () => {
        const result = selectDemoProgramById(DEMO_CLAIMABLE_PROGRAMS, "medical-support-2025");
        expect(result?.id).toBe("medical-support-2025");
        expect(result?.category).toBe("medical");
    });
});
