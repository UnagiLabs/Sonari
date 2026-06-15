import { describe, expect, it } from "vitest";
import {
    DEMO_CLAIMABLE_PROGRAMS,
} from "../catalog/demo-catalog";
import {
    type ClaimableProgram,
    type DisasterClaimableProgram,
    isDisasterProgram,
} from "../catalog/claimable-program";
import {
    pickPreviewCellSource,
    resolvePreviewCellSource,
} from "./preview-cell-source";

// ---------------------------------------------------------------------------
// テスト用フィクスチャ
//
// 実際の DisasterClaimableProgram 型に合う最小構成のオブジェクトを組み立てる。
// ---------------------------------------------------------------------------

/** 最小限の DisasterClaimableProgram（static-asset 源付き） */
const STATIC_ASSET_DISASTER: DisasterClaimableProgram = {
    id: "test-disaster-static",
    category: "disaster",
    title: "テスト災害 static-asset",
    scope: "テスト地域",
    amountSummary: { kind: "range", minUsdc: 100, maxUsdc: 300 },
    deadlineMs: "1893456000000",
    detailHref: "/claim/test-disaster-static",
    eventUid: "0x" + "a".repeat(64),
    severityBand: 2,
    affectedCellCount: 100,
    cellSource: { kind: "static-asset", path: "/demo/test-affected-cells.json" },
};

/** 最小限の DisasterClaimableProgram（deferred 源） */
const DEFERRED_DISASTER: DisasterClaimableProgram = {
    id: "test-disaster-deferred",
    category: "disaster",
    title: "テスト災害 deferred",
    scope: "テスト地域",
    amountSummary: { kind: "range", minUsdc: 100, maxUsdc: 300 },
    deadlineMs: "1893456000000",
    detailHref: "/claim/test-disaster-deferred",
    eventUid: "0x" + "b".repeat(64),
    severityBand: 1,
    affectedCellCount: 50,
    cellSource: { kind: "deferred" },
};

/** 最小限の非災害プログラム（student-fund） */
const STUDENT_FUND: ClaimableProgram = {
    id: "test-student-fund",
    category: "student-fund",
    title: "テスト学生支援",
    scope: "全国大学生",
    amountSummary: { kind: "fixed", usdc: 500 },
    deadlineMs: "1893456000000",
    detailHref: "/claim/test-student-fund",
};

// ---------------------------------------------------------------------------
// pickPreviewCellSource
// ---------------------------------------------------------------------------

describe("pickPreviewCellSource", () => {
    it("災害＋static-asset を含むカタログ → その cellSource（kind: static-asset, path 一致）を返す", () => {
        const catalog: readonly ClaimableProgram[] = [STATIC_ASSET_DISASTER, STUDENT_FUND];
        const result = pickPreviewCellSource(catalog);
        expect(result).toStrictEqual({
            kind: "static-asset",
            path: "/demo/test-affected-cells.json",
        });
    });

    it("複数の static-asset 災害プログラムがある場合、最初のものを返す", () => {
        const second: DisasterClaimableProgram = {
            ...STATIC_ASSET_DISASTER,
            id: "test-disaster-static-2",
            cellSource: { kind: "static-asset", path: "/demo/second-affected-cells.json" },
        };
        const catalog: readonly ClaimableProgram[] = [STATIC_ASSET_DISASTER, second];
        const result = pickPreviewCellSource(catalog);
        expect(result).toStrictEqual({
            kind: "static-asset",
            path: "/demo/test-affected-cells.json",
        });
    });

    it("災害が deferred のみ → { kind: 'deferred' } を返す（fail-closed）", () => {
        const catalog: readonly ClaimableProgram[] = [DEFERRED_DISASTER, STUDENT_FUND];
        const result = pickPreviewCellSource(catalog);
        expect(result).toStrictEqual({ kind: "deferred" });
    });

    it("非災害のみ（student-fund）→ { kind: 'deferred' } を返す（fail-closed）", () => {
        const catalog: readonly ClaimableProgram[] = [STUDENT_FUND];
        const result = pickPreviewCellSource(catalog);
        expect(result).toStrictEqual({ kind: "deferred" });
    });

    it("空配列 → { kind: 'deferred' } を返す（fail-closed）", () => {
        const result = pickPreviewCellSource([]);
        expect(result).toStrictEqual({ kind: "deferred" });
    });

    it("入力配列を破壊しない（参照が変わらない）", () => {
        const catalog: readonly ClaimableProgram[] = [STATIC_ASSET_DISASTER];
        const before = [...catalog];
        pickPreviewCellSource(catalog);
        expect(catalog).toStrictEqual(before);
    });

    it("deferred 災害と static-asset 災害が混在する場合、static-asset の方を返す", () => {
        const catalog: readonly ClaimableProgram[] = [DEFERRED_DISASTER, STATIC_ASSET_DISASTER];
        const result = pickPreviewCellSource(catalog);
        expect(result).toStrictEqual({
            kind: "static-asset",
            path: "/demo/test-affected-cells.json",
        });
    });
});

// ---------------------------------------------------------------------------
// resolvePreviewCellSource
// ---------------------------------------------------------------------------

describe("resolvePreviewCellSource", () => {
    it("実カタログ DEMO_CLAIMABLE_PROGRAMS 由来の static-asset 源を返す", () => {
        // DEMO_CLAIMABLE_PROGRAMS の中の最初の static-asset 災害を取得して期待値を導出
        let expectedPath: string | undefined;
        for (const p of DEMO_CLAIMABLE_PROGRAMS) {
            if (isDisasterProgram(p) && p.cellSource.kind === "static-asset") {
                expectedPath = p.cellSource.path;
                break;
            }
        }
        expect(expectedPath).toBeDefined();

        const result = resolvePreviewCellSource(STATIC_ASSET_DISASTER);
        expect(result.kind).toBe("static-asset");
        if (result.kind === "static-asset") {
            expect(result.path).toBe(expectedPath);
        }
    });

    it("東日本大震災 2011 の path /demo/tohoku-2011-affected-cells.json を返す", () => {
        // デモ源のパスは demo-catalog の TOHOKU_2011_PROGRAM に定義されている
        // ここではそれを DEMO_CLAIMABLE_PROGRAMS から導出し、リテラル一致も確認する
        const result = resolvePreviewCellSource(STATIC_ASSET_DISASTER);
        expect(result.kind).toBe("static-asset");
        if (result.kind === "static-asset") {
            expect(result.path).toBe("/demo/tohoku-2011-affected-cells.json");
        }
    });

    it("任意の DisasterClaimableProgram を渡しても同じ結果（決定的）", () => {
        const result1 = resolvePreviewCellSource(STATIC_ASSET_DISASTER);
        const result2 = resolvePreviewCellSource(DEFERRED_DISASTER);
        expect(result1).toStrictEqual(result2);
    });

    it("複数回呼んでも同じ結果（決定的・副作用なし）", () => {
        const result1 = resolvePreviewCellSource(STATIC_ASSET_DISASTER);
        const result2 = resolvePreviewCellSource(STATIC_ASSET_DISASTER);
        expect(result1).toStrictEqual(result2);
    });
});
