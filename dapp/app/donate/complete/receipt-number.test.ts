import { describe, expect, it } from "vitest";
import { receiptNumber } from "./receipt-number";

const DIGEST = "8xQJ4pR7mWv2KdYz3Nc6Ftb9SgaUe5hLA1qPkXrM2nBpV";
// 2026-06-18 12:00:00 UTC 相当の固定タイムスタンプ（年だけ使う）。
const RECEIVED_AT_2026 = Date.UTC(2026, 5, 18, 12, 0, 0);

describe("receiptNumber", () => {
    it("SNR-<年>- prefix を受領日の年から作る", () => {
        expect(receiptNumber(DIGEST, RECEIVED_AT_2026)).toMatch(/^SNR-2026-[0-9A-Z]{6}$/u);
    });

    it("同じ digest からは決定的に同じ番号を返す", () => {
        const first = receiptNumber(DIGEST, RECEIVED_AT_2026);
        const second = receiptNumber(DIGEST, RECEIVED_AT_2026);
        expect(first).toBe(second);
    });

    it("digest が異なれば suffix も変わる", () => {
        const a = receiptNumber(DIGEST, RECEIVED_AT_2026);
        const b = receiptNumber(`${DIGEST}z`, RECEIVED_AT_2026);
        expect(a).not.toBe(b);
    });

    it("受領日が null / 非正値でも 6 桁 suffix を返す（年は現在年）", () => {
        const currentYear = new Date().getFullYear();
        expect(receiptNumber(DIGEST, null)).toMatch(
            new RegExp(`^SNR-${currentYear}-[0-9A-Z]{6}$`, "u"),
        );
        expect(receiptNumber(DIGEST, 0)).toMatch(
            new RegExp(`^SNR-${currentYear}-[0-9A-Z]{6}$`, "u"),
        );
    });
});
