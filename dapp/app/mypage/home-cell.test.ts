import { latLngToCell } from "h3-js";
import { describe, expect, it } from "vitest";
import { parseHomeCell } from "./home-cell";

// Build canonical decimal cell ids at known resolutions via h3-js so the test
// does not hardcode brittle magic numbers.
function decimalCell(lat: number, lng: number, res: number): string {
    return BigInt(`0x${latLngToCell(lat, lng, res)}`).toString();
}

const RES7_DECIMAL = decimalCell(35.681236, 139.767125, 7);
const RES7_HEX = latLngToCell(35.681236, 139.767125, 7);
const RES10_DECIMAL = decimalCell(35.681236, 139.767125, 10);

describe("parseHomeCell", () => {
    it("parses a valid res7 decimal cell", () => {
        const result = parseHomeCell(RES7_DECIMAL);
        expect(result).not.toBeNull();
        expect(result?.decimal).toBe(RES7_DECIMAL);
        expect(result?.hex).toBe(RES7_HEX);
    });

    it("returns null for a cell at a different resolution", () => {
        expect(parseHomeCell(RES10_DECIMAL)).toBeNull();
    });

    it("returns null for the unset value 0", () => {
        expect(parseHomeCell("0")).toBeNull();
    });

    it("returns null for a non-numeric value", () => {
        expect(parseHomeCell("not-a-number")).toBeNull();
    });

    it("returns null for an empty string", () => {
        expect(parseHomeCell("")).toBeNull();
    });
});
