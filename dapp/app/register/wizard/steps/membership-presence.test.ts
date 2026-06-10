import { describe, expect, it } from "vitest";
import {
    deriveMembershipPresenceView,
    shortAddress,
    type MembershipPresenceView,
} from "./membership-presence";
import type { MembershipLookupResult } from "../../identity/membership-lookup";

// ---------------------------------------------------------------------------
// shortAddress
// ---------------------------------------------------------------------------

describe("shortAddress", () => {
    it("returns the value as-is when 14 characters or fewer", () => {
        const value = "0x1234567890ab"; // 14 chars
        expect(shortAddress(value)).toBe(value);
    });

    it("returns the value as-is when exactly 14 characters", () => {
        const value = "12345678901234"; // 14 chars
        expect(shortAddress(value)).toBe(value);
    });

    it("truncates values longer than 14 characters", () => {
        const value = "0x1234567890abcdef"; // 18 chars
        expect(shortAddress(value)).toBe("0x12345678…cdef");
    });

    it("truncates a full 66-character Sui address", () => {
        const addr = `0x${"ab".repeat(32)}`; // 66 chars
        // slice(0,10)="0xabababab", slice(-4)="abab"
        expect(shortAddress(addr)).toBe("0xabababab…abab");
    });

    it("boundary: 15 characters triggers truncation", () => {
        const value = "123456789012345"; // 15 chars
        expect(shortAddress(value)).toBe("1234567890…2345");
    });

    it("handles an empty string without throwing", () => {
        expect(shortAddress("")).toBe("");
    });
});

// ---------------------------------------------------------------------------
// deriveMembershipPresenceView
// ---------------------------------------------------------------------------

const OWNER = `0x${"aa".repeat(32)}`; // 66-char address
const MEMBERSHIP_ID = `0x${"bb".repeat(32)}`;

describe("deriveMembershipPresenceView", () => {
    it("returns disconnected when wallet is not connected", () => {
        const result = deriveMembershipPresenceView({
            connected: false,
            owner: "",
            lookupResult: null,
        });
        expect(result).toEqual<MembershipPresenceView>({ kind: "disconnected" });
    });

    it("returns disconnected when connected=false even if owner is set", () => {
        const result = deriveMembershipPresenceView({
            connected: false,
            owner: OWNER,
            lookupResult: null,
        });
        expect(result).toEqual<MembershipPresenceView>({ kind: "disconnected" });
    });

    it("returns unconfigured when lookup is disabled (package id missing)", () => {
        // パッケージ ID 未設定環境では照会しないため、checking を出し続けない。
        const result = deriveMembershipPresenceView({
            connected: true,
            owner: OWNER,
            lookupResult: null,
            lookupEnabled: false,
        });
        expect(result).toEqual<MembershipPresenceView>({ kind: "unconfigured" });
    });

    it("returns disconnected when lookup is disabled and wallet is not connected", () => {
        const result = deriveMembershipPresenceView({
            connected: false,
            owner: "",
            lookupResult: null,
            lookupEnabled: false,
        });
        expect(result).toEqual<MembershipPresenceView>({ kind: "disconnected" });
    });

    it("returns checking when connected but lookupResult is null", () => {
        const result = deriveMembershipPresenceView({
            connected: true,
            owner: OWNER,
            lookupResult: null,
        });
        expect(result).toEqual<MembershipPresenceView>({ kind: "checking" });
    });

    it("returns registered with short owner and membershipId when result is ok", () => {
        const lookupResult: MembershipLookupResult = { kind: "ok", membershipId: MEMBERSHIP_ID };
        const result = deriveMembershipPresenceView({
            connected: true,
            owner: OWNER,
            lookupResult,
        });
        expect(result).toEqual<MembershipPresenceView>({
            kind: "registered",
            ownerShort: shortAddress(OWNER),
            membershipId: MEMBERSHIP_ID,
        });
    });

    it("returns not_registered when result is none", () => {
        const lookupResult: MembershipLookupResult = { kind: "none" };
        const result = deriveMembershipPresenceView({
            connected: true,
            owner: OWNER,
            lookupResult,
        });
        expect(result).toEqual<MembershipPresenceView>({ kind: "not_registered" });
    });

    it("returns registered (multiple) when result is multiple", () => {
        // multiple は保有していることに変わりないので registered 扱い。
        // ただし membershipId は確定できないため null とする。
        const lookupResult: MembershipLookupResult = { kind: "multiple", count: 2 };
        const result = deriveMembershipPresenceView({
            connected: true,
            owner: OWNER,
            lookupResult,
        });
        expect(result).toEqual<MembershipPresenceView>({
            kind: "registered",
            ownerShort: shortAddress(OWNER),
            membershipId: null,
            count: 2,
        });
    });

    it("returns error when result is error", () => {
        const lookupResult: MembershipLookupResult = {
            kind: "error",
            message: "Network failure",
        };
        const result = deriveMembershipPresenceView({
            connected: true,
            owner: OWNER,
            lookupResult,
        });
        expect(result).toEqual<MembershipPresenceView>({
            kind: "error",
            message: "Network failure",
        });
    });

    it("returns not_registered for short owner address without truncation", () => {
        const shortOwner = "0xdeadbeef"; // 10 chars, under 14
        const lookupResult: MembershipLookupResult = { kind: "none" };
        const result = deriveMembershipPresenceView({
            connected: true,
            owner: shortOwner,
            lookupResult,
        });
        expect(result).toEqual<MembershipPresenceView>({ kind: "not_registered" });
    });

    it("ownerShort is correctly truncated in registered state", () => {
        const lookupResult: MembershipLookupResult = { kind: "ok", membershipId: MEMBERSHIP_ID };
        const result = deriveMembershipPresenceView({
            connected: true,
            owner: OWNER,
            lookupResult,
        });
        expect(result.kind).toBe("registered");
        if (result.kind === "registered") {
            expect(result.ownerShort).toBe(shortAddress(OWNER));
            expect(result.ownerShort).toContain("…");
        }
    });
});
