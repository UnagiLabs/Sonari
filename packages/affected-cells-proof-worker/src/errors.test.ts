import { describe, expect, it } from "vitest";
import {
    AffectedCellsProofError,
    errorResponse,
    toAffectedCellsProofError,
} from "./errors.js";

describe("AffectedCellsProofError", () => {
    it("stores code, message, and status", () => {
        const err = new AffectedCellsProofError("invalid_request", "bad request", 400);
        expect(err.code).toBe("invalid_request");
        expect(err.message).toBe("bad request");
        expect(err.status).toBe(400);
        expect(err.name).toBe("AffectedCellsProofError");
        expect(err instanceof Error).toBe(true);
    });
});

describe("error code → HTTP status mapping", () => {
    const cases: Array<[import("./errors.js").AffectedCellsProofErrorCode, number]> = [
        ["invalid_request", 400],
        ["unauthorized", 401],
        ["walrus_fetch_failed", 400],
        ["affected_cells_hash_mismatch", 400],
        ["affected_cells_root_mismatch", 400],
        ["affected_cells_invalid", 400],
        ["affected_cell_not_in_event", 404],
        ["proof_manifest_missing", 500],
        ["proof_manifest_invalid", 500],
        ["proof_shard_missing", 500],
        ["proof_shard_integrity_mismatch", 500],
        ["proof_shard_invalid", 500],
        ["method_not_allowed", 405],
        ["not_found", 404],
        ["internal", 500],
    ];

    it.each(cases)("code=%s returns status %d", (code, expectedStatus) => {
        const err = new AffectedCellsProofError(code, "test", expectedStatus);
        expect(err.status).toBe(expectedStatus);
    });
});

describe("errorResponse", () => {
    it("returns a Response with the correct status and JSON body", async () => {
        const err = new AffectedCellsProofError("invalid_request", "Request was invalid", 400);
        const response = errorResponse(err);

        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");

        const body = await response.json();
        expect(body).toEqual({
            error: {
                code: "invalid_request",
                message: "Request was invalid",
            },
        });
    });

    it("returns 401 for unauthorized error", async () => {
        const err = new AffectedCellsProofError("unauthorized", "Unauthorized", 401);
        const response = errorResponse(err);

        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body).toEqual({
            error: {
                code: "unauthorized",
                message: "Unauthorized",
            },
        });
    });

    it("returns 500 for internal error", async () => {
        const err = new AffectedCellsProofError("internal", "Unexpected error", 500);
        const response = errorResponse(err);

        expect(response.status).toBe(500);
    });

    it("returns 405 for method_not_allowed", async () => {
        const err = new AffectedCellsProofError("method_not_allowed", "Method not allowed", 405);
        const response = errorResponse(err);

        expect(response.status).toBe(405);
    });
});

describe("toAffectedCellsProofError", () => {
    it("passes AffectedCellsProofError through unchanged", () => {
        const original = new AffectedCellsProofError("not_found", "Not found", 404);
        const result = toAffectedCellsProofError(original);

        expect(result).toBe(original);
        expect(result.code).toBe("not_found");
        expect(result.status).toBe(404);
    });

    it("normalizes unknown Error to internal 500", () => {
        const err = new Error("something went wrong");
        const result = toAffectedCellsProofError(err);

        expect(result.code).toBe("internal");
        expect(result.status).toBe(500);
        expect(result instanceof AffectedCellsProofError).toBe(true);
    });

    it("normalizes plain string to internal 500", () => {
        const result = toAffectedCellsProofError("unexpected string error");

        expect(result.code).toBe("internal");
        expect(result.status).toBe(500);
    });

    it("normalizes null to internal 500", () => {
        const result = toAffectedCellsProofError(null);

        expect(result.code).toBe("internal");
        expect(result.status).toBe(500);
    });

    it("normalizes undefined to internal 500", () => {
        const result = toAffectedCellsProofError(undefined);

        expect(result.code).toBe("internal");
        expect(result.status).toBe(500);
    });

    it("normalizes object to internal 500", () => {
        const result = toAffectedCellsProofError({ something: "unexpected" });

        expect(result.code).toBe("internal");
        expect(result.status).toBe(500);
    });
});
