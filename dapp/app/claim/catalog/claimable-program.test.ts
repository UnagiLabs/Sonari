import { describe, expect, it } from "vitest";
import {
    isDisasterProgram,
    programHasMap,
    parseClaimableProgram,
} from "./claimable-program";
import type {
    ClaimableProgram,
    DisasterClaimableProgram,
    AmountSummary,
} from "./claimable-program";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EVENT_UID = "0x" + "a".repeat(64);

const validDisasterInput: unknown = {
    id: "prog-001",
    category: "disaster",
    title: "東日本大震災 2011",
    scope: "岩手・宮城・福島",
    amountSummary: { kind: "range", minUsdc: 100, maxUsdc: 300 },
    deadlineMs: "1893456000000",
    detailHref: "/claim/prog-001",
    eventUid: EVENT_UID,
    severityBand: 3,
    affectedCellCount: 1200,
    cellSource: { kind: "static-asset", path: "/demo/tohoku-2011/affected-cells.json" },
    affectedAreaArtifact: {
        kind: "tiled-affected-cells",
        manifestPath: "/demo/tohoku-2011/affected-area-manifest.json",
    },
    affectedCellsRoot: "0x" + "b".repeat(64),
};

const validStudentInput: unknown = {
    id: "prog-002",
    category: "student-fund",
    title: "学生支援基金 2025",
    scope: "全国の大学生",
    amountSummary: { kind: "fixed", usdc: 500 },
    deadlineMs: "1893456000000",
    detailHref: "/claim/prog-002",
};

const validMedicalInput: unknown = {
    id: "prog-003",
    category: "medical",
    title: "難病支援プログラム",
    scope: "指定難病患者",
    amountSummary: { kind: "fixed", usdc: 800 },
    deadlineMs: "1893456000000",
    detailHref: "/claim/prog-003",
};

// ---------------------------------------------------------------------------
// parseClaimableProgram — disaster
// ---------------------------------------------------------------------------

describe("parseClaimableProgram — disaster", () => {
    it("parses a valid disaster program", () => {
        const result = parseClaimableProgram(validDisasterInput);
        expect(result).not.toBeNull();
        expect(result?.category).toBe("disaster");
        expect(result?.id).toBe("prog-001");
    });

    it("parsed disaster program has map meta fields", () => {
        const result = parseClaimableProgram(validDisasterInput) as DisasterClaimableProgram | null;
        expect(result).not.toBeNull();
        expect(result?.eventUid).toBe(EVENT_UID);
        expect(result?.severityBand).toBe(3);
        expect(result?.affectedCellCount).toBe(1200);
        expect(result?.cellSource).toEqual({
            kind: "static-asset",
            path: "/demo/tohoku-2011/affected-cells.json",
        });
        expect(result?.affectedAreaArtifact).toEqual({
            kind: "tiled-affected-cells",
            manifestPath: "/demo/tohoku-2011/affected-area-manifest.json",
        });
    });

    it("parsed disaster program accepts tiled affected area artifact", () => {
        const input = {
            ...(validDisasterInput as Record<string, unknown>),
            affectedAreaArtifact: {
                kind: "tiled-affected-cells",
                manifestPath: "/demo/tohoku-2011/affected-area-manifest.json",
            },
        };

        const result = parseClaimableProgram(input);

        expect(result).not.toBeNull();
        if (result?.category === "disaster") {
            expect(result.affectedAreaArtifact).toEqual({
                kind: "tiled-affected-cells",
                manifestPath: "/demo/tohoku-2011/affected-area-manifest.json",
            });
        }
    });

    it("returns null when affectedAreaArtifact is invalid", () => {
        const input = {
            ...(validDisasterInput as Record<string, unknown>),
            affectedAreaArtifact: {
                kind: "band-overlay-image",
                manifestPath: "/demo/tohoku-2011/affected-area-manifest.json",
            },
        };

        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("parses without optional affectedAreaArtifact", () => {
        const input = { ...(validDisasterInput as Record<string, unknown>) };
        delete input["affectedAreaArtifact"];
        const result = parseClaimableProgram(input);
        expect(result).not.toBeNull();
        if (result?.category === "disaster") {
            expect(result.affectedAreaArtifact).toBeUndefined();
        }
    });

    it("parsed disaster program accepts deferred cellSource", () => {
        const input = { ...validDisasterInput as Record<string, unknown>, cellSource: { kind: "deferred" } };
        const result = parseClaimableProgram(input);
        expect(result).not.toBeNull();
        expect(result?.category).toBe("disaster");
        if (result?.category === "disaster") {
            expect(result.cellSource).toEqual({ kind: "deferred" });
        }
    });

    it("parsed disaster program includes amountSummary as range", () => {
        const result = parseClaimableProgram(validDisasterInput);
        expect(result?.amountSummary).toEqual({ kind: "range", minUsdc: 100, maxUsdc: 300 });
    });

    it("returns null when disaster is missing eventUid", () => {
        const input = { ...validDisasterInput as Record<string, unknown> };
        delete input["eventUid"];
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when disaster is missing cellSource", () => {
        const input = { ...validDisasterInput as Record<string, unknown> };
        delete input["cellSource"];
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when disaster has invalid cellSource kind", () => {
        const input = { ...validDisasterInput as Record<string, unknown>, cellSource: { kind: "unknown-kind" } };
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when disaster has invalid severityBand", () => {
        const input = { ...validDisasterInput as Record<string, unknown>, severityBand: 5 };
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when disaster has invalid severityBand 0", () => {
        const input = { ...validDisasterInput as Record<string, unknown>, severityBand: 0 };
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("parses without optional affectedCellsRoot", () => {
        const input = { ...validDisasterInput as Record<string, unknown> };
        delete input["affectedCellsRoot"];
        const result = parseClaimableProgram(input);
        expect(result).not.toBeNull();
        if (result?.category === "disaster") {
            expect(result.affectedCellsRoot).toBeUndefined();
        }
    });
});

// ---------------------------------------------------------------------------
// parseClaimableProgram — student-fund
// ---------------------------------------------------------------------------

describe("parseClaimableProgram — student-fund", () => {
    it("parses a valid student-fund program", () => {
        const result = parseClaimableProgram(validStudentInput);
        expect(result).not.toBeNull();
        expect(result?.category).toBe("student-fund");
        expect(result?.id).toBe("prog-002");
    });

    it("parsed student-fund program has fixed amountSummary", () => {
        const result = parseClaimableProgram(validStudentInput);
        expect(result?.amountSummary).toEqual({ kind: "fixed", usdc: 500 });
    });

    it("student-fund does not have map meta fields at type level (runtime check)", () => {
        const result = parseClaimableProgram(validStudentInput);
        expect(result).not.toBeNull();
        // student-fund must not have disaster-specific fields
        expect((result as unknown as Record<string, unknown>)["eventUid"]).toBeUndefined();
        expect((result as unknown as Record<string, unknown>)["cellSource"]).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// parseClaimableProgram — medical
// ---------------------------------------------------------------------------

describe("parseClaimableProgram — medical", () => {
    it("parses a valid medical program", () => {
        const result = parseClaimableProgram(validMedicalInput);
        expect(result).not.toBeNull();
        expect(result?.category).toBe("medical");
        expect(result?.id).toBe("prog-003");
    });

    it("medical does not have map meta fields at type level (runtime check)", () => {
        const result = parseClaimableProgram(validMedicalInput);
        expect(result).not.toBeNull();
        expect((result as unknown as Record<string, unknown>)["eventUid"]).toBeUndefined();
        expect((result as unknown as Record<string, unknown>)["cellSource"]).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// parseClaimableProgram — invalid / missing fields
// ---------------------------------------------------------------------------

describe("parseClaimableProgram — invalid input", () => {
    it("returns null for null", () => {
        expect(parseClaimableProgram(null)).toBeNull();
    });

    it("returns null for non-object", () => {
        expect(parseClaimableProgram("string")).toBeNull();
        expect(parseClaimableProgram(42)).toBeNull();
        expect(parseClaimableProgram([])).toBeNull();
    });

    it("returns null for unknown category", () => {
        const input = { ...validStudentInput as Record<string, unknown>, category: "unknown-category" };
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when id is missing", () => {
        const input = { ...validStudentInput as Record<string, unknown> };
        delete input["id"];
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when id is empty string", () => {
        const input = { ...validStudentInput as Record<string, unknown>, id: "" };
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when title is missing", () => {
        const input = { ...validStudentInput as Record<string, unknown> };
        delete input["title"];
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when scope is missing", () => {
        const input = { ...validStudentInput as Record<string, unknown> };
        delete input["scope"];
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when deadlineMs is missing", () => {
        const input = { ...validStudentInput as Record<string, unknown> };
        delete input["deadlineMs"];
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when deadlineMs is not a valid decimal ms string", () => {
        const input = { ...validStudentInput as Record<string, unknown>, deadlineMs: "not-a-number" };
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when detailHref is missing", () => {
        const input = { ...validStudentInput as Record<string, unknown> };
        delete input["detailHref"];
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when amountSummary has unknown kind", () => {
        const input = { ...validStudentInput as Record<string, unknown>, amountSummary: { kind: "unknown" } };
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when amountSummary range is missing minUsdc", () => {
        const input = {
            ...validDisasterInput as Record<string, unknown>,
            amountSummary: { kind: "range", maxUsdc: 300 },
        };
        expect(parseClaimableProgram(input)).toBeNull();
    });

    it("returns null when amountSummary fixed is missing usdc", () => {
        const input = {
            ...validStudentInput as Record<string, unknown>,
            amountSummary: { kind: "fixed" },
        };
        expect(parseClaimableProgram(input)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// isDisasterProgram
// ---------------------------------------------------------------------------

describe("isDisasterProgram", () => {
    it("returns true for a disaster program", () => {
        const prog = parseClaimableProgram(validDisasterInput);
        expect(prog).not.toBeNull();
        expect(isDisasterProgram(prog!)).toBe(true);
    });

    it("returns false for a student-fund program", () => {
        const prog = parseClaimableProgram(validStudentInput);
        expect(prog).not.toBeNull();
        expect(isDisasterProgram(prog!)).toBe(false);
    });

    it("returns false for a medical program", () => {
        const prog = parseClaimableProgram(validMedicalInput);
        expect(prog).not.toBeNull();
        expect(isDisasterProgram(prog!)).toBe(false);
    });

    it("narrows type to DisasterClaimableProgram allowing access to eventUid", () => {
        const prog = parseClaimableProgram(validDisasterInput);
        expect(prog).not.toBeNull();
        if (isDisasterProgram(prog!)) {
            // TypeScript should allow this access without error
            expect(prog.eventUid).toBe(EVENT_UID);
            expect(prog.severityBand).toBe(3);
        }
    });
});

// ---------------------------------------------------------------------------
// programHasMap
// ---------------------------------------------------------------------------

describe("programHasMap", () => {
    it("returns true for disaster program", () => {
        const prog = parseClaimableProgram(validDisasterInput);
        expect(prog).not.toBeNull();
        expect(programHasMap(prog!)).toBe(true);
    });

    it("returns false for student-fund program", () => {
        const prog = parseClaimableProgram(validStudentInput);
        expect(prog).not.toBeNull();
        expect(programHasMap(prog!)).toBe(false);
    });

    it("returns false for medical program", () => {
        const prog = parseClaimableProgram(validMedicalInput);
        expect(prog).not.toBeNull();
        expect(programHasMap(prog!)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// AmountSummary shape
// ---------------------------------------------------------------------------

describe("AmountSummary", () => {
    it("range AmountSummary has minUsdc and maxUsdc", () => {
        const prog = parseClaimableProgram(validDisasterInput);
        const summary = prog?.amountSummary as AmountSummary;
        expect(summary.kind).toBe("range");
        if (summary.kind === "range") {
            expect(summary.minUsdc).toBe(100);
            expect(summary.maxUsdc).toBe(300);
        }
    });

    it("fixed AmountSummary has usdc", () => {
        const prog = parseClaimableProgram(validStudentInput);
        const summary = prog?.amountSummary as AmountSummary;
        expect(summary.kind).toBe("fixed");
        if (summary.kind === "fixed") {
            expect(summary.usdc).toBe(500);
        }
    });
});
