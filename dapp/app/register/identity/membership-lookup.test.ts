import { describe, expect, it, vi } from "vitest";
import {
    lookupMembershipPass,
    membershipPassType,
    type OwnedObjectSummary,
    type OwnedObjectsClient,
} from "./membership-lookup";

const PACKAGE_ID = `0x${"ab".repeat(32)}`;
const OWNER = `0x${"33".repeat(32)}`;
const EXPECTED_TYPE = `${PACKAGE_ID}::membership::MembershipPass`;

function stubClient(
    objects: readonly OwnedObjectSummary[],
): { client: OwnedObjectsClient; calls: Array<{ owner: string; type?: string; limit?: number }> } {
    const calls: Array<{ owner: string; type?: string; limit?: number }> = [];
    const client: OwnedObjectsClient = {
        listOwnedObjects: (options) => {
            calls.push(options);
            return Promise.resolve({ objects });
        },
    };
    return { client, calls };
}

function pass(objectId: string, type = EXPECTED_TYPE): OwnedObjectSummary {
    return { objectId, type };
}

describe("membershipPassType", () => {
    it("builds the fully-qualified MembershipPass type", () => {
        expect(membershipPassType(PACKAGE_ID)).toBe(EXPECTED_TYPE);
    });

    it("throws when package id is empty", () => {
        expect(() => membershipPassType("")).toThrow("Membership package id is not configured.");
    });

    it("throws when package id is whitespace", () => {
        expect(() => membershipPassType("   ")).toThrow(
            "Membership package id is not configured.",
        );
    });
});

describe("lookupMembershipPass", () => {
    it("returns ok with the membership id when exactly one pass is owned", async () => {
        const { client, calls } = stubClient([pass("0xpass1")]);
        const result = await lookupMembershipPass(client, OWNER, PACKAGE_ID);
        expect(result).toEqual({ kind: "ok", membershipId: "0xpass1" });
        expect(calls[0]?.owner).toBe(OWNER);
        expect(calls[0]?.type).toBe(EXPECTED_TYPE);
    });

    it("returns none when the wallet owns no MembershipPass", async () => {
        const { client } = stubClient([]);
        expect(await lookupMembershipPass(client, OWNER, PACKAGE_ID)).toEqual({ kind: "none" });
    });

    it("ignores objects whose type is not a MembershipPass", async () => {
        const { client } = stubClient([pass("0xother", `${PACKAGE_ID}::membership::OtherThing`)]);
        expect(await lookupMembershipPass(client, OWNER, PACKAGE_ID)).toEqual({ kind: "none" });
    });

    it("returns multiple (with count) when more than one pass is owned", async () => {
        const { client } = stubClient([pass("0xpass1"), pass("0xpass2")]);
        expect(await lookupMembershipPass(client, OWNER, PACKAGE_ID)).toEqual({
            kind: "multiple",
            count: 2,
        });
    });

    it("matches passes regardless of address zero-padding normalization", async () => {
        const shortPackage = "0x2";
        const fullType = `0x${"0".repeat(63)}2::membership::MembershipPass`;
        const { client } = stubClient([pass("0xpass1", fullType)]);
        const result = await lookupMembershipPass(client, OWNER, shortPackage);
        expect(result).toEqual({ kind: "ok", membershipId: "0xpass1" });
    });

    it("returns error when the client throws", async () => {
        const client: OwnedObjectsClient = {
            listOwnedObjects: vi.fn().mockRejectedValue(new Error("grpc down")),
        };
        expect(await lookupMembershipPass(client, OWNER, PACKAGE_ID)).toEqual({
            kind: "error",
            message: "grpc down",
        });
    });

    it("returns error when the package id is not configured", async () => {
        const { client, calls } = stubClient([pass("0xpass1")]);
        const result = await lookupMembershipPass(client, OWNER, "");
        expect(result.kind).toBe("error");
        expect(calls.length).toBe(0);
    });

    it("returns error when the owner is empty", async () => {
        const { client, calls } = stubClient([pass("0xpass1")]);
        const result = await lookupMembershipPass(client, "  ", PACKAGE_ID);
        expect(result.kind).toBe("error");
        expect(calls.length).toBe(0);
    });
});
