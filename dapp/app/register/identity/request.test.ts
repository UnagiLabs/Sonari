import { describe, expect, it } from "vitest";
import { WORLD_ID_ACTION } from "./world-id-action";
import {
    buildIdentitySubmitRequest,
    canSubmitIdentity,
    parseIdkitResponse,
} from "./request";

const REGISTRY_ID = `0x${"11".repeat(32)}`;
const MEMBERSHIP_ID = `0x${"22".repeat(32)}`;
const OWNER = `0x${"33".repeat(32)}`;
const SIGNED_STATEMENT_HASH = `0x${"44".repeat(32)}`;

/**
 * Valid idkit_response fixture in the real IDKit v4 shape (ResponseItemV4):
 * `identifier: "proof_of_human"` (Orb credential), `issuer_schema_id: 1`,
 * `proof` as a string array. Only this Orb-verified credential is accepted.
 */
const VALID_IDKIT_RESPONSE = {
    protocol_version: "4.0",
    nonce: "nonce-123",
    action: WORLD_ID_ACTION,
    environment: "staging",
    user_presence_completed: false,
    responses: [
        {
            identifier: "proof_of_human",
            signal_hash: "0x004c584cd5e136507a762e7bc3bdd3f2e2535f5d32a7c6f343e17377886cca47",
            proof: ["0x01", "0x02", "0x03", "0x04", "0x05"],
            nullifier: "0x1234567890abcdef",
            issuer_schema_id: 1,
            expires_at_min: 1_780_000_000,
        },
    ],
};

describe("dapp register identity request builder (v4)", () => {
    describe("buildIdentitySubmitRequest – world_id provider", () => {
        it("forwards idkit_response as-is inside world_id wrapper", () => {
            const request = buildIdentitySubmitRequest(
                worldIdForm(),
                REGISTRY_ID,
                VALID_IDKIT_RESPONSE,
            );

            expect(request).toEqual({
                registry_id: REGISTRY_ID,
                membership_id: MEMBERSHIP_ID,
                owner: OWNER,
                provider: "world_id",
                terms_version: 1,
                signed_statement_hash: SIGNED_STATEMENT_HASH,
                world_id: {
                    idkit_response: VALID_IDKIT_RESPONSE,
                },
            });
        });

        it("world_id has only idkit_response key – no top-level signal_hash or v2 fields", () => {
            const request = buildIdentitySubmitRequest(
                worldIdForm(),
                REGISTRY_ID,
                VALID_IDKIT_RESPONSE,
            );

            expect(Object.keys(request.world_id ?? {})).toEqual(["idkit_response"]);
            // top-level request also must not contain signal_hash
            expect("signal_hash" in request).toBe(false);
        });

        it("idkit_response is forwarded deep-equal (extra fields preserved)", () => {
            const responseWithExtra = { ...VALID_IDKIT_RESPONSE, custom_extra: "keep-me" };
            const request = buildIdentitySubmitRequest(
                worldIdForm(),
                REGISTRY_ID,
                responseWithExtra,
            );

            expect(request.world_id?.idkit_response).toEqual(responseWithExtra);
        });

        it("PII in form fields does not leak into the request JSON", () => {
            const request = buildIdentitySubmitRequest(
                formData({
                    identityProvider: "world_id",
                    membershipId: MEMBERSHIP_ID,
                    owner: OWNER,
                    termsVersion: "1",
                    signedStatementHash: SIGNED_STATEMENT_HASH,
                    rawKycImage: "data:image/png;base64,raw-pii",
                }),
                REGISTRY_ID,
                VALID_IDKIT_RESPONSE,
            );

            expect(JSON.stringify(request)).not.toContain("rawKycImage");
        });

        it("throws when worldIdResult is undefined", () => {
            expect(() =>
                buildIdentitySubmitRequest(worldIdForm(), REGISTRY_ID, undefined),
            ).toThrow();
        });

        it("throws when worldIdResult is not an object", () => {
            expect(() =>
                buildIdentitySubmitRequest(worldIdForm(), REGISTRY_ID, "bad"),
            ).toThrow("World ID response must be an object");
        });
    });

    describe("buildIdentitySubmitRequest – kyc provider", () => {
        it("omits world_id for KYC requests", () => {
            const request = buildIdentitySubmitRequest(
                formData({
                    identityProvider: "kyc",
                    membershipId: MEMBERSHIP_ID,
                    owner: OWNER,
                    termsVersion: "2",
                    signedStatementHash: SIGNED_STATEMENT_HASH,
                }),
                REGISTRY_ID,
            );

            expect(request).toEqual({
                registry_id: REGISTRY_ID,
                membership_id: MEMBERSHIP_ID,
                owner: OWNER,
                provider: "kyc",
                terms_version: 2,
                signed_statement_hash: SIGNED_STATEMENT_HASH,
            });
            expect("world_id" in request).toBe(false);
        });

        it("ignores worldIdResult when provider is kyc", () => {
            const request = buildIdentitySubmitRequest(
                formData({
                    identityProvider: "kyc",
                    membershipId: MEMBERSHIP_ID,
                    owner: OWNER,
                    termsVersion: "1",
                    signedStatementHash: SIGNED_STATEMENT_HASH,
                }),
                REGISTRY_ID,
                VALID_IDKIT_RESPONSE,
            );

            expect("world_id" in request).toBe(false);
        });
    });

    describe("buildIdentitySubmitRequest – base form validation", () => {
        it("rejects empty membershipId", () => {
            expect(() =>
                buildIdentitySubmitRequest(
                    formData({
                        identityProvider: "world_id",
                        membershipId: "",
                        owner: OWNER,
                        termsVersion: "1",
                        signedStatementHash: SIGNED_STATEMENT_HASH,
                    }),
                    REGISTRY_ID,
                    VALID_IDKIT_RESPONSE,
                ),
            ).toThrow("membershipId is required");
        });

        it("rejects non-integer termsVersion", () => {
            expect(() =>
                buildIdentitySubmitRequest(
                    formData({
                        identityProvider: "kyc",
                        membershipId: MEMBERSHIP_ID,
                        owner: OWNER,
                        termsVersion: "1.5",
                        signedStatementHash: SIGNED_STATEMENT_HASH,
                    }),
                    REGISTRY_ID,
                ),
            ).toThrow("termsVersion must be a safe unsigned integer");
        });
    });

    describe("buildIdentitySubmitRequest – is synchronous", () => {
        it("returns IdentitySubmitRequest directly (not a Promise)", () => {
            const result = buildIdentitySubmitRequest(
                formData({
                    identityProvider: "kyc",
                    membershipId: MEMBERSHIP_ID,
                    owner: OWNER,
                    termsVersion: "1",
                    signedStatementHash: SIGNED_STATEMENT_HASH,
                }),
                REGISTRY_ID,
            );

            // A Promise is a thenable; a plain object is not.
            expect(typeof (result as unknown as Promise<unknown>).then).toBe("undefined");
        });
    });
});

describe("parseIdkitResponse", () => {
    it("accepts a valid idkit_response and returns it as-is", () => {
        const result = parseIdkitResponse(VALID_IDKIT_RESPONSE);
        expect(result).toEqual(VALID_IDKIT_RESPONSE);
    });

    it("rejects non-object (string)", () => {
        expect(() => parseIdkitResponse("bad")).toThrow(
            "World ID response must be an object",
        );
    });

    it("rejects null", () => {
        expect(() => parseIdkitResponse(null)).toThrow(
            "World ID response must be an object",
        );
    });

    it("rejects array", () => {
        expect(() => parseIdkitResponse([])).toThrow(
            "World ID response must be an object",
        );
    });

    it("rejects when session_id is present", () => {
        expect(() =>
            parseIdkitResponse({ ...VALID_IDKIT_RESPONSE, session_id: "s123" }),
        ).toThrow("World ID session proofs are not supported");
    });

    it("rejects wrong protocol_version", () => {
        expect(() =>
            parseIdkitResponse({ ...VALID_IDKIT_RESPONSE, protocol_version: "3.0" }),
        ).toThrow("protocol_version must be 4.0");
    });

    it("rejects missing protocol_version", () => {
        const { protocol_version: _pv, ...rest } = VALID_IDKIT_RESPONSE;
        expect(() => parseIdkitResponse(rest)).toThrow("protocol_version must be 4.0");
    });

    it("rejects mismatched action", () => {
        expect(() =>
            parseIdkitResponse({ ...VALID_IDKIT_RESPONSE, action: "other_action" }),
        ).toThrow("action does not match the expected Sonari action");
    });

    it("rejects missing action", () => {
        const { action: _a, ...rest } = VALID_IDKIT_RESPONSE;
        expect(() => parseIdkitResponse(rest)).toThrow("action does not match the expected Sonari action");
    });

    it("rejects missing environment", () => {
        const { environment: _e, ...rest } = VALID_IDKIT_RESPONSE;
        expect(() => parseIdkitResponse(rest)).toThrow("environment must be a non-empty string");
    });

    it("rejects empty environment", () => {
        expect(() =>
            parseIdkitResponse({ ...VALID_IDKIT_RESPONSE, environment: "" }),
        ).toThrow("environment must be a non-empty string");
    });

    it("rejects responses that is not an array", () => {
        expect(() =>
            parseIdkitResponse({ ...VALID_IDKIT_RESPONSE, responses: "bad" }),
        ).toThrow("responses must be an array with exactly one element");
    });

    it("rejects responses with 0 elements", () => {
        expect(() =>
            parseIdkitResponse({ ...VALID_IDKIT_RESPONSE, responses: [] }),
        ).toThrow("responses must be an array with exactly one element");
    });

    it("rejects responses with 2 elements", () => {
        expect(() =>
            parseIdkitResponse({
                ...VALID_IDKIT_RESPONSE,
                responses: [
                    VALID_IDKIT_RESPONSE.responses[0],
                    VALID_IDKIT_RESPONSE.responses[0],
                ],
            }),
        ).toThrow("responses must be an array with exactly one element");
    });

    it("rejects responses[0] that is not an object", () => {
        expect(() =>
            parseIdkitResponse({ ...VALID_IDKIT_RESPONSE, responses: ["bad"] }),
        ).toThrow("responses[0] must be an object");
    });

    it("rejects identifier !== proof_of_human (e.g. selfie)", () => {
        expect(() =>
            parseIdkitResponse({
                ...VALID_IDKIT_RESPONSE,
                responses: [
                    { ...VALID_IDKIT_RESPONSE.responses[0], identifier: "selfie" },
                ],
            }),
        ).toThrow("responses[0].identifier must be proof_of_human (Orb-verified human)");
    });

    it("rejects the legacy placeholder identifier 'orb'", () => {
        expect(() =>
            parseIdkitResponse({
                ...VALID_IDKIT_RESPONSE,
                responses: [{ ...VALID_IDKIT_RESPONSE.responses[0], identifier: "orb" }],
            }),
        ).toThrow("responses[0].identifier must be proof_of_human (Orb-verified human)");
    });

    it("rejects a non-Orb issuer_schema_id (e.g. 11 = selfie)", () => {
        expect(() =>
            parseIdkitResponse({
                ...VALID_IDKIT_RESPONSE,
                responses: [
                    { ...VALID_IDKIT_RESPONSE.responses[0], issuer_schema_id: 11 },
                ],
            }),
        ).toThrow("responses[0].issuer_schema_id must be 1 (Orb proof_of_human credential)");
    });

    it("rejects a missing issuer_schema_id", () => {
        const { issuer_schema_id: _schema, ...responseWithout } =
            VALID_IDKIT_RESPONSE.responses[0];
        expect(() =>
            parseIdkitResponse({
                ...VALID_IDKIT_RESPONSE,
                responses: [responseWithout],
            }),
        ).toThrow("responses[0].issuer_schema_id must be 1 (Orb proof_of_human credential)");
    });

    it("rejects missing signal_hash", () => {
        const { signal_hash: _sh, ...responseWithout } = VALID_IDKIT_RESPONSE.responses[0];
        expect(() =>
            parseIdkitResponse({
                ...VALID_IDKIT_RESPONSE,
                responses: [responseWithout],
            }),
        ).toThrow("responses[0].signal_hash must be a non-empty string");
    });

    it("rejects empty signal_hash", () => {
        expect(() =>
            parseIdkitResponse({
                ...VALID_IDKIT_RESPONSE,
                responses: [{ ...VALID_IDKIT_RESPONSE.responses[0], signal_hash: "" }],
            }),
        ).toThrow("responses[0].signal_hash must be a non-empty string");
    });

    it("rejects missing nullifier", () => {
        const { nullifier: _n, ...responseWithout } = VALID_IDKIT_RESPONSE.responses[0];
        expect(() =>
            parseIdkitResponse({
                ...VALID_IDKIT_RESPONSE,
                responses: [responseWithout],
            }),
        ).toThrow("responses[0].nullifier must be a non-empty string");
    });

    it("rejects empty nullifier", () => {
        expect(() =>
            parseIdkitResponse({
                ...VALID_IDKIT_RESPONSE,
                responses: [{ ...VALID_IDKIT_RESPONSE.responses[0], nullifier: "" }],
            }),
        ).toThrow("responses[0].nullifier must be a non-empty string");
    });

    it("preserves extra fields in valid response (as-is forward)", () => {
        const withExtra = { ...VALID_IDKIT_RESPONSE, custom_field: "extra" };
        const result = parseIdkitResponse(withExtra);
        expect(result).toEqual(withExtra);
        expect((result as Record<string, unknown>).custom_field).toBe("extra");
    });
});

describe("canSubmitIdentity", () => {
    it("returns true for kyc even when worldIdResponse is null", () => {
        expect(canSubmitIdentity("kyc", null)).toBe(true);
    });

    it("returns true for kyc when worldIdResponse is undefined", () => {
        expect(canSubmitIdentity("kyc", undefined)).toBe(true);
    });

    it("returns false for world_id when worldIdResponse is null", () => {
        expect(canSubmitIdentity("world_id", null)).toBe(false);
    });

    it("returns false for world_id when worldIdResponse is undefined", () => {
        expect(canSubmitIdentity("world_id", undefined)).toBe(false);
    });

    it("returns true for world_id when worldIdResponse is a non-null object", () => {
        expect(canSubmitIdentity("world_id", VALID_IDKIT_RESPONSE)).toBe(true);
    });

    it("returns false for world_id when worldIdResponse is a string", () => {
        expect(canSubmitIdentity("world_id", "bad")).toBe(false);
    });

    it("returns false for world_id when worldIdResponse is a number", () => {
        expect(canSubmitIdentity("world_id", 42)).toBe(false);
    });
});

// ---- helpers ----

function worldIdForm(): { get(name: string): string | null } {
    return formData({
        identityProvider: "world_id",
        membershipId: MEMBERSHIP_ID,
        owner: OWNER,
        termsVersion: "1",
        signedStatementHash: SIGNED_STATEMENT_HASH,
    });
}

function formData(values: Record<string, string>): { get(name: string): string | null } {
    return {
        get(name: string): string | null {
            return values[name] ?? null;
        },
    };
}
