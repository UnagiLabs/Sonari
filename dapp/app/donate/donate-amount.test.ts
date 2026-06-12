import { describe, expect, it } from "vitest";
import { parseDonationAmountToMicroUsdc, validateDonationAmount } from "./donate-amount";

describe("validateDonationAmount", () => {
    it("returns empty for empty input", () => {
        expect(validateDonationAmount("")).toEqual({ ok: false, errorCode: "empty" });
    });

    it("returns invalid_format for non-number input", () => {
        expect(validateDonationAmount("abc")).toEqual({ ok: false, errorCode: "invalid_format" });
    });

    it("returns negative for negative amount", () => {
        expect(validateDonationAmount("-1")).toEqual({ ok: false, errorCode: "negative" });
    });

    it("returns zero for zero amount", () => {
        expect(validateDonationAmount("0")).toEqual({ ok: false, errorCode: "zero" });
    });

    it("returns too_many_decimals for amount with more than 6 decimals", () => {
        expect(validateDonationAmount("0.0000001")).toEqual({
            ok: false,
            errorCode: "too_many_decimals",
        });
    });

    it("returns overflow for amount over u64 max in micro-USDC", () => {
        expect(validateDonationAmount("18446744073709.551616")).toEqual({
            ok: false,
            errorCode: "overflow",
        });
    });
});

describe("parseDonationAmountToMicroUsdc", () => {
    it("returns minimum valid amount 0.000001 as 1", () => {
        expect(parseDonationAmountToMicroUsdc("0.000001")).toBe(1n);
    });

    it("returns integers as USDC multiplied by 1_000_000", () => {
        expect(parseDonationAmountToMicroUsdc("3")).toBe(3_000_000n);
    });

    it("accepts comma-separated quick amount style", () => {
        expect(parseDonationAmountToMicroUsdc("$1,000")).toBe(1_000_000_000n);
    });

    it("pads decimal part to 6 places", () => {
        expect(parseDonationAmountToMicroUsdc("1.2")).toBe(1_200_000n);
    });

    it("accepts the exact u64 max", () => {
        expect(parseDonationAmountToMicroUsdc("18446744073709.551615")).toBe(
            BigInt("18446744073709551615"),
        );
    });
});
