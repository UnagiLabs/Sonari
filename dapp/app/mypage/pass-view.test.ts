import { describe, expect, it } from "vitest";
import type { MembershipPassData, MembershipPassReadResult } from "./membership-pass-read";
import {
    deriveMypageView,
    formatTimestamp,
    providerLabelKeys,
    statusLabelKey,
} from "./pass-view";

function pass(overrides: Partial<MembershipPassData> = {}): MembershipPassData {
    return {
        objectId: `0x${"77".repeat(32)}`,
        status: 1,
        issuedAtMs: 1700000000000,
        homeCell: "614265551683510271",
        homeCellRegisteredAtMs: 1700000001000,
        identityVerified: true,
        identityProviderMask: 2,
        identityVerifiedAtMs: 1700000002000,
        identityExpiresAtMs: 1800000000000,
        ...overrides,
    };
}

describe("statusLabelKey", () => {
    it("maps each known status code to its key", () => {
        expect(statusLabelKey(1)).toBe("active");
        expect(statusLabelKey(2)).toBe("suspended");
        expect(statusLabelKey(3)).toBe("revoked");
        expect(statusLabelKey(4)).toBe("migrated");
    });

    it("maps unknown codes to unknown", () => {
        expect(statusLabelKey(0)).toBe("unknown");
        expect(statusLabelKey(5)).toBe("unknown");
        expect(statusLabelKey(255)).toBe("unknown");
    });
});

describe("providerLabelKeys", () => {
    it("returns kyc for bit 1", () => {
        expect(providerLabelKeys(1)).toEqual(["kyc"]);
    });

    it("returns worldId for bit 2", () => {
        expect(providerLabelKeys(2)).toEqual(["worldId"]);
    });

    it("returns both keys for combined mask 3", () => {
        expect(providerLabelKeys(3)).toEqual(["kyc", "worldId"]);
    });

    it("returns empty list for mask 0", () => {
        expect(providerLabelKeys(0)).toEqual([]);
    });

    it("ignores unknown bits while keeping known ones", () => {
        // 0b101 = 5 → bit1 (kyc) set, bit3 unknown ignored
        expect(providerLabelKeys(5)).toEqual(["kyc"]);
        // 0b100 = 4 → only unknown bit
        expect(providerLabelKeys(4)).toEqual([]);
    });
});

describe("formatTimestamp", () => {
    it("returns null for non-positive timestamps", () => {
        expect(formatTimestamp(0, "ja")).toBeNull();
        expect(formatTimestamp(-1, "en")).toBeNull();
    });

    it("formats a positive timestamp differently per locale", () => {
        const ms = Date.UTC(2024, 0, 15); // 2024-01-15
        const ja = formatTimestamp(ms, "ja");
        const en = formatTimestamp(ms, "en");
        expect(ja).not.toBeNull();
        expect(en).not.toBeNull();
        expect(ja).not.toBe(en);
        // ja format contains the year digits
        expect(ja).toContain("2024");
        expect(en).toContain("2024");
    });
});

describe("deriveMypageView", () => {
    it("returns disconnected when not connected", () => {
        expect(deriveMypageView({ connected: false, owner: "", result: null }).kind).toBe(
            "disconnected",
        );
    });

    it("returns unconfigured when lookup is disabled", () => {
        const view = deriveMypageView({
            connected: true,
            owner: `0x${"33".repeat(32)}`,
            result: null,
            lookupEnabled: false,
        });
        expect(view.kind).toBe("unconfigured");
    });

    it("returns loading while connected and result is null", () => {
        const view = deriveMypageView({
            connected: true,
            owner: `0x${"33".repeat(32)}`,
            result: null,
        });
        expect(view.kind).toBe("loading");
    });

    it("returns not_registered when result is none", () => {
        const result: MembershipPassReadResult = { kind: "none" };
        expect(deriveMypageView({ connected: true, owner: "0xabc", result }).kind).toBe(
            "not_registered",
        );
    });

    it("returns error with message when result is error", () => {
        const result: MembershipPassReadResult = { kind: "error", message: "boom" };
        const view = deriveMypageView({ connected: true, owner: "0xabc", result });
        expect(view.kind).toBe("error");
        if (view.kind === "error") {
            expect(view.message).toBe("boom");
        }
    });

    it("returns ready with the pass when result is ok", () => {
        const data = pass();
        const result: MembershipPassReadResult = { kind: "ok", pass: data };
        const view = deriveMypageView({ connected: true, owner: "0xabc", result });
        expect(view.kind).toBe("ready");
        if (view.kind === "ready") {
            expect(view.pass).toBe(data);
        }
    });
});
