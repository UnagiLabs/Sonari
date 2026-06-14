import { describe, expect, it, vi } from "vitest";
import type { OwnedObjectSummary } from "../register/identity/membership-lookup";
import {
    type MembershipPassReadClient,
    type MembershipPassReadObject,
    readMembershipPass,
} from "./membership-pass-read";

const PACKAGE_ID = `0x${"ab".repeat(32)}`;
const REGISTRY_ID = `0x${"ee".repeat(32)}`;
const OWNER = `0x${"33".repeat(32)}`;
const PASS_ID = `0x${"77".repeat(32)}`;
const PASS_LINEAGE_ID = `0x${"88".repeat(32)}`;
const EXPECTED_TYPE = `${PACKAGE_ID}::membership::MembershipPass`;

// A realistic H3 res7 decimal value: exceeds Number.MAX_SAFE_INTEGER (9007199254740991).
const BIG_HOME_CELL = "614265551683510271";

// nowMs value used in tests that check identity verification state.
const NOW_MS = 1800000000000;

function passSummary(objectId = PASS_ID, type = EXPECTED_TYPE): OwnedObjectSummary {
    return { objectId, type };
}

function passJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        pass_lineage_id: PASS_LINEAGE_ID,
        status: "1",
        issued_at_ms: "1700000000000",
        home_cell: BIG_HOME_CELL,
        home_cell_registered_at_ms: "1700000001000",
        ...overrides,
    };
}

function registryFieldJson(overrides: Record<string, unknown> = {}): MembershipPassReadObject {
    return {
        objectId: `0x${"ff".repeat(32)}`,
        json: {
            name: PASS_ID,
            value: {
                provider_mask: "2",
                verified_at_ms: "1700000002000",
                expires_at_ms: "1900000000000",
                owner: OWNER,
                terms_version: "1",
                signed_statement_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                ...overrides,
            },
        },
    };
}

function stubClient(options: {
    owned?: readonly OwnedObjectSummary[];
    objects?: ReadonlyArray<MembershipPassReadObject | Error>;
    registryObjects?: ReadonlyArray<MembershipPassReadObject | Error>;
    ownedError?: Error;
    getError?: Error;
}): MembershipPassReadClient {
    let callCount = 0;
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
            callCount += 1;
            if (callCount === 1) {
                return Promise.resolve({ objects: options.objects ?? [] });
            }
            return Promise.resolve({ objects: options.registryObjects ?? [] });
        }),
    };
}

describe("readMembershipPass", () => {
    it("returns ok with identity fields from registry when record exists and is not expired", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [{ objectId: PASS_ID, json: passJson() }],
            registryObjects: [registryFieldJson()],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(result.pass).toEqual({
            objectId: PASS_ID,
            passLineageId: PASS_LINEAGE_ID,
            status: 1,
            issuedAtMs: 1700000000000,
            homeCell: BIG_HOME_CELL,
            homeCellRegisteredAtMs: 1700000001000,
            identityVerified: true,
            identityProviderMask: 2,
            identityVerifiedAtMs: 1700000002000,
            identityExpiresAtMs: 1900000000000,
        });
    });

    it("returns identity fields as defaults when no registry record exists", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [{ objectId: PASS_ID, json: passJson() }],
            registryObjects: [],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(result.pass.identityVerified).toBe(false);
        expect(result.pass.identityProviderMask).toBe(0);
        expect(result.pass.identityVerifiedAtMs).toBe(0);
        expect(result.pass.identityExpiresAtMs).toBe(0);
    });

    it("returns identityVerified=false when registry record is expired", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [{ objectId: PASS_ID, json: passJson() }],
            registryObjects: [registryFieldJson({ expires_at_ms: "1000000000000" })],
        });

        const result = await readMembershipPass(
            client,
            OWNER,
            PACKAGE_ID,
            REGISTRY_ID,
            2000000000000,
        );

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(result.pass.identityVerified).toBe(false);
        expect(result.pass.identityExpiresAtMs).toBe(1000000000000);
    });

    it("keeps home_cell as a string without precision loss", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [{ objectId: PASS_ID, json: passJson() }],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

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
                        home_cell: 0,
                    }),
                },
            ],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(result.pass.status).toBe(3);
        expect(result.pass.homeCell).toBe("0");
    });

    it("rejects an unsafe numeric home_cell to avoid silent precision loss", async () => {
        const client = stubClient({
            owned: [passSummary()],
            // A value this large delivered as a JS number is already lossy → must error.
            objects: [{ objectId: PASS_ID, json: passJson({ home_cell: 614265551683510271 }) }],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

        expect(result.kind).toBe("error");
    });

    it("returns none when the wallet owns no pass", async () => {
        const client = stubClient({ owned: [] });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

        expect(result.kind).toBe("none");
    });

    it("returns error when the wallet owns multiple passes (anomaly)", async () => {
        const client = stubClient({
            owned: [passSummary(`0x${"01".repeat(32)}`), passSummary(`0x${"02".repeat(32)}`)],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

        expect(result.kind).toBe("error");
        if (result.kind === "error") {
            expect(result.code).toBe("multiple");
        }
    });

    it("returns error when listOwnedObjects throws", async () => {
        const client = stubClient({ ownedError: new Error("grpc down") });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

        expect(result).toEqual({ kind: "error", code: "read", message: "grpc down" });
    });

    it("returns error when getObjects throws on pass fetch", async () => {
        const client = stubClient({
            owned: [passSummary()],
            getError: new Error("fetch failed"),
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

        expect(result).toEqual({ kind: "error", code: "read", message: "fetch failed" });
    });

    it("returns error when the fetched object carries an Error", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [new Error("object not found")],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

        expect(result.kind).toBe("error");
    });

    it("returns error when the json payload is missing", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [{ objectId: PASS_ID, json: null }],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

        expect(result.kind).toBe("error");
    });

    it("returns error when a required pass field is malformed", async () => {
        const client = stubClient({
            owned: [passSummary()],
            objects: [{ objectId: PASS_ID, json: passJson({ status: "not-a-number" }) }],
        });

        const result = await readMembershipPass(client, OWNER, PACKAGE_ID, REGISTRY_ID, NOW_MS);

        expect(result.kind).toBe("error");
    });
});
