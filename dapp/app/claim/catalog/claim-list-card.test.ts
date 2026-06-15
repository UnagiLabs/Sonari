import { describe, expect, it } from "vitest";
import type { ClaimableProgram } from "./claimable-program";
import { buildClaimListCard } from "./claim-list-card";

// ---------------------------------------------------------------------------
// テスト用フィクスチャ
// ---------------------------------------------------------------------------

/** range AmountSummary を持つ学生支援基金プログラム（最小構築）。 */
const RANGE_PROGRAM: ClaimableProgram = {
    id: "test-range-001",
    category: "student-fund",
    title: "テスト range プログラム",
    scope: "全国の大学生",
    amountSummary: { kind: "range", minUsdc: 100, maxUsdc: 300 },
    deadlineMs: "1767139199000",
    detailHref: "/demo/claim/test-range-001",
};

/** fixed AmountSummary を持つ医療支援プログラム（最小構築）。 */
const FIXED_PROGRAM: ClaimableProgram = {
    id: "test-fixed-002",
    category: "medical",
    title: "テスト fixed プログラム",
    scope: "指定難病患者",
    amountSummary: { kind: "fixed", usdc: 500 },
    deadlineMs: "1759294799000",
    detailHref: "/demo/claim/test-fixed-002",
};

// ---------------------------------------------------------------------------
// amountText: range 金額整形
// ---------------------------------------------------------------------------

describe("buildClaimListCard: amountText（range）", () => {
    it("range min<max → '<min>–<max>'（U+2013 EN DASH を含む）", () => {
        const card = buildClaimListCard(RANGE_PROGRAM);
        // U+2013 EN DASH で区切られることを確認
        expect(card.amountText).toBe("100–300");
    });

    it("range の区切り文字が EN DASH（U+2013）であり、ハイフン（U+002D）でない", () => {
        const card = buildClaimListCard(RANGE_PROGRAM);
        // ハイフン（-）を含まないことを確認
        expect(card.amountText).not.toContain("-");
        // EN DASH（–）を含むことを確認
        expect(card.amountText).toContain("–");
    });

    it("range min===max でも両方出力する", () => {
        const program: ClaimableProgram = {
            ...RANGE_PROGRAM,
            amountSummary: { kind: "range", minUsdc: 200, maxUsdc: 200 },
        };
        const card = buildClaimListCard(program);
        expect(card.amountText).toBe("200–200");
    });

    it("range 小数値も String(n) として出力される", () => {
        const program: ClaimableProgram = {
            ...RANGE_PROGRAM,
            amountSummary: { kind: "range", minUsdc: 100.5, maxUsdc: 300.75 },
        };
        const card = buildClaimListCard(program);
        expect(card.amountText).toBe("100.5–300.75");
    });
});

// ---------------------------------------------------------------------------
// amountText: fixed 金額整形
// ---------------------------------------------------------------------------

describe("buildClaimListCard: amountText（fixed）", () => {
    it("fixed → '<usdc>'（数値のみ）", () => {
        const card = buildClaimListCard(FIXED_PROGRAM);
        expect(card.amountText).toBe("500");
    });

    it("fixed 0 → '0'", () => {
        const program: ClaimableProgram = {
            ...FIXED_PROGRAM,
            amountSummary: { kind: "fixed", usdc: 0 },
        };
        const card = buildClaimListCard(program);
        expect(card.amountText).toBe("0");
    });
});

// ---------------------------------------------------------------------------
// deadlineText: 有効な 10 進 ms 文字列 → YYYY-MM-DD
// ---------------------------------------------------------------------------

describe("buildClaimListCard: deadlineText（有効な deadlineMs）", () => {
    it("'1767139199000' → new Date(1767139199000).toISOString().slice(0,10) と一致", () => {
        const expected = new Date(1767139199000).toISOString().slice(0, 10);
        const card = buildClaimListCard(RANGE_PROGRAM);
        expect(card.deadlineText).toBe(expected);
    });

    it("'1759294799000' → new Date(1759294799000).toISOString().slice(0,10) と一致", () => {
        const expected = new Date(1759294799000).toISOString().slice(0, 10);
        const card = buildClaimListCard(FIXED_PROGRAM);
        expect(card.deadlineText).toBe(expected);
    });

    it("'0'（epoch）→ '1970-01-01'", () => {
        const program: ClaimableProgram = { ...RANGE_PROGRAM, deadlineMs: "0" };
        const card = buildClaimListCard(program);
        expect(card.deadlineText).toBe("1970-01-01");
    });
});

// ---------------------------------------------------------------------------
// deadlineText: 不正な deadlineMs → 元文字列をそのまま返す
// ---------------------------------------------------------------------------

describe("buildClaimListCard: deadlineText（不正な deadlineMs）", () => {
    it("'not-a-number' → 'not-a-number' をそのまま返す", () => {
        const program: ClaimableProgram = { ...RANGE_PROGRAM, deadlineMs: "not-a-number" };
        const card = buildClaimListCard(program);
        expect(card.deadlineText).toBe("not-a-number");
    });

    it("空文字 '' → Number('') === 0（safe integer）なので '1970-01-01' に整形される", () => {
        // '' は Number 変換で 0 になる。0 は Number.isSafeInteger かつ >= 0 のため
        // epoch（1970-01-01）として整形される。claim-view.tsx の formatClaimWindow と同じ挙動。
        const program = { ...RANGE_PROGRAM, deadlineMs: "" } as ClaimableProgram;
        const card = buildClaimListCard(program);
        expect(card.deadlineText).toBe("1970-01-01");
    });

    it("'-1'（負数）→ '-1' をそのまま返す", () => {
        const program = { ...RANGE_PROGRAM, deadlineMs: "-1" } as ClaimableProgram;
        const card = buildClaimListCard(program);
        expect(card.deadlineText).toBe("-1");
    });
});

// ---------------------------------------------------------------------------
// 透過フィールド: id / title / scope / detailHref
// ---------------------------------------------------------------------------

describe("buildClaimListCard: 透過フィールド", () => {
    it("id が program から透過される", () => {
        expect(buildClaimListCard(RANGE_PROGRAM).id).toBe("test-range-001");
        expect(buildClaimListCard(FIXED_PROGRAM).id).toBe("test-fixed-002");
    });

    it("title が program から透過される", () => {
        expect(buildClaimListCard(RANGE_PROGRAM).title).toBe("テスト range プログラム");
        expect(buildClaimListCard(FIXED_PROGRAM).title).toBe("テスト fixed プログラム");
    });

    it("scope が program から透過される", () => {
        expect(buildClaimListCard(RANGE_PROGRAM).scope).toBe("全国の大学生");
        expect(buildClaimListCard(FIXED_PROGRAM).scope).toBe("指定難病患者");
    });

    it("detailHref が program から透過される", () => {
        expect(buildClaimListCard(RANGE_PROGRAM).detailHref).toBe("/demo/claim/test-range-001");
        expect(buildClaimListCard(FIXED_PROGRAM).detailHref).toBe("/demo/claim/test-fixed-002");
    });
});

// ---------------------------------------------------------------------------
// 純粋性: 同じ入力で同じ出力
// ---------------------------------------------------------------------------

describe("buildClaimListCard: 純粋性", () => {
    it("同じ program を 2 回渡すと同じ結果を返す", () => {
        const card1 = buildClaimListCard(RANGE_PROGRAM);
        const card2 = buildClaimListCard(RANGE_PROGRAM);
        expect(card1).toEqual(card2);
    });
});
