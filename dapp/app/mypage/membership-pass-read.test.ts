import { describe, expect, it, vi } from "vitest";
import type { OwnedObjectSummary } from "../register/identity/membership-lookup";
import {
    type MembershipPassReadClient,
    type MembershipPassReadObject,
    readMembershipPass,
} from "./membership-pass-read";

const PACKAGE_ID = `0x${"ab".repeat(32)}`;
const OWNER = `0x${"33".repeat(32)}`;
const PASS_ID = `0x${"77".repeat(32)}`;
const EXPECTED_TYPE = `${PACKAGE_ID}::membership::MembershipPass`;

// A realistic H3 res7 decimal value: exceeds Number.MAX_SAFE_INTEGER (9007199254740991).
const BIG_HOME_CELL = "614265551683510271";

function passSummary(objectId = PASS_ID, type = EXPECTED_TYPE): OwnedObjectSummary {
    return { objectId, type };
}

function passJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        status: "1",
        issued_at_ms: "1700000000000",
        home_cell: BIG_HOME_CELL,
        home_cell_registered_at_ms: "1700000001000",
        identity_verified: true,
        identity_provider_mask: "2",
        identity_verified_at_ms: "1700000002000",
        identity_expires_at_ms: "1800000000000",
        ...overrides,
    };
}

function stubClient(options: {
    owned?: readonly OwnedObjectSummary[];
    objects?: ReadonlyArray<MembershipPassReadObject | Error>;
    ownedError?: Error;
    getError?: Error;
}): MembershipPassReadClient {
    return {
        listOwnedObjects: vi.fn(() => {
            if (options.ownedError) {
                return Promise.reject(options.ownedError);
            }
            return Promise.resolve({ objects: options.owned ?? [] });
        }),
        getObjects: vi.fn(() => {
            if (options.getError) {
                return Promise.reject(options.getError);
            }
            return Promise.resolve({ objects: options.objects ?? [] });
        }),
    };
}

describe("readMembershipPass", () => {
    it("returns ok with parsed fields when the wallet owns one pass", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [{ objectId: PASS_ID, json: passJson() }],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID);

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(result.pass).toEqual({
            objectId: PASS_ID,
            status: 1,
            issuedAtMs: 1700000000000,
            homeCell: BIG_HOME_CELL,
            homeCellRegisteredAtMs: 1700000001000,
            identityVerified: true,
            identityProviderMask: 2,
            identityVerifiedAtMs: 1700000002000,
            identityExpiresAtMs: 1800000000000,
        });
    });

    it("keeps home_cell as a string without precision loss", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [{ objectId: PASS_ID, json: passJson() }],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID);

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        // The value must round-trip exactly; BigInt confirms no digit was lost,
        // and we assert it is beyond the safe-number range a number would corrupt.
        expect(result.pass.homeCell).toBe(BIG_HOME_CELL);
        expect(BigInt(result.pass.homeCell)).toBe(BigInt(BIG_HOME_CELL));
        expect(BigInt(result.pass.homeCell) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    });

    it("accepts numeric json values too (number/string tolerant)", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [
                {
                    objectId: PASS_ID,
                    json: passJson({
                        status: 3,
                        identity_provider_mask: 1,
                        identity_verified: false,
                        home_cell: 0,
                    }),
                },
            ],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID);

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(result.pass.status).toBe(3);
        expect(result.pass.identityProviderMask).toBe(1);
        expect(result.pass.identityVerified).toBe(false);
        expect(result.pass.homeCell).toBe("0");
    });

    it("rejects an unsafe numeric home_cell to avoid silent precision loss", async () => {
        const client = stubClient({
            owned: [passSummary()],
            // A value this large delivered as a JS number is already lossy → must error.
            objects: [{ objectId: PASS_ID, json: passJson({ home_cell: 614265551683510271 }) }],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID);

        expect(result.kind).toBe("error");
    });

    it("returns none when the wallet owns no pass", async () => {
        const client = stubClient({ owned: [] });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID);

        expect(result.kind).toBe("none");
    });

    it("returns error when the wallet owns multiple passes (anomaly)", async () => {
        const client = stubClient({
            owned: [passSummary(`0x${"01".repeat(32)}`), passSummary(`0x${"02".repeat(32)}`)],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID);

        expect(result.kind).toBe("error");
    });

    it("returns error when listOwnedObjects throws", async () => {
        const client = stubClient({ ownedError: new Error("grpc down") });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID);

        expect(result).toEqual({ kind: "error", message: "grpc down" });
    });

    it("returns error when getObjects throws", async () => {
        const client = stubClient({
            owned: [passSummary()],
            getError: new Error("fetch failed"),
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID);

        expect(result).toEqual({ kind: "error", message: "fetch failed" });
    });

    it("returns error when the fetched object carries an Error", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [new Error("object not found")],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID);

        expect(result.kind).toBe("error");
    });

    it("returns error when the json payload is missing", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [{ objectId: PASS_ID, json: null }],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID);

        expect(result.kind).toBe("error");
    });

    it("returns error when a required field is malformed", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [{ objectId: PASS_ID, json: passJson({ status: "not-a-number" }) }],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID);

        expect(result.kind).toBe("error");
    });
});
