import { describe, expect, it } from "vitest";
import { formatAmount, formatDate, formatRelativeTime } from "./format";

// 共通フォーマッタの単体テスト。ロケール（en-US / ja-JP）ごとの表示形式を固定し、
// 境界値（0・負値・大きな値）の振る舞いを保証する。文字列の細部は ICU 実装で
// 揺れるため、必須要素を toContain で検証する方針にする。

describe("formatAmount", () => {
    it("桁区切りを付けて数値を表示する", () => {
        expect(formatAmount(1000000, "en")).toContain("1,000,000");
    });

    it("小数桁オプションを反映する", () => {
        expect(formatAmount(1234.5, "en", { minimumFractionDigits: 2 })).toBe("1,234.50");
    });

    it("通貨指定で通貨記号を付ける", () => {
        const usd = formatAmount(1234.5, "en", { currency: "USD" });
        expect(usd).toContain("$");
        expect(usd).toContain("1,234.5");
    });

    it("ゼロと負値も表示できる", () => {
        expect(formatAmount(0, "en")).toBe("0");
        expect(formatAmount(-1500, "en")).toContain("1,500");
        expect(formatAmount(-1500, "en")).toContain("-");
    });
});

describe("formatDate", () => {
    it("非正値は null を返す", () => {
        expect(formatDate(0, "ja")).toBeNull();
        expect(formatDate(-1, "en")).toBeNull();
    });

    it("ロケールごとに異なる形式で日付を表示する", () => {
        const ms = Date.UTC(2024, 0, 15); // 2024-01-15
        const ja = formatDate(ms, "ja");
        const en = formatDate(ms, "en");
        expect(ja).not.toBeNull();
        expect(en).not.toBeNull();
        expect(ja).not.toBe(en);
        expect(ja).toContain("2024");
        expect(en).toContain("2024");
    });

    it("時刻オプションを渡すと時分を含められる", () => {
        const ms = Date.UTC(2024, 0, 15, 9, 30);
        const out = formatDate(ms, "en", {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "UTC",
        });
        expect(out).toContain("09:30");
    });
});

describe("formatRelativeTime", () => {
    it("過去・未来の相対時間を文字列で返す", () => {
        const past = formatRelativeTime(-2, "day", "en");
        const future = formatRelativeTime(3, "hour", "en");
        expect(past).toContain("2");
        expect(past.toLowerCase()).toContain("day");
        expect(future).toContain("3");
        expect(future.toLowerCase()).toContain("hour");
    });

    it("ロケールごとに異なる文言を返す", () => {
        const en = formatRelativeTime(-2, "day", "en");
        const ja = formatRelativeTime(-2, "day", "ja");
        expect(en).not.toBe(ja);
    });
});
