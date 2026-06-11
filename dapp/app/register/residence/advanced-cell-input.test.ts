import { describe, expect, it } from "vitest";
import type { MapsLoaderStatus } from "./google-maps-loader";
import { shouldShowAdvancedCellInput } from "./advanced-cell-input";

describe("shouldShowAdvancedCellInput", () => {
    it('returns true when status is "unconfigured"', () => {
        const status: MapsLoaderStatus = "unconfigured";
        expect(shouldShowAdvancedCellInput(status)).toBe(true);
    });

    it('returns true when status is "error"', () => {
        const status: MapsLoaderStatus = "error";
        expect(shouldShowAdvancedCellInput(status)).toBe(true);
    });

    it('returns false when status is "loading"', () => {
        const status: MapsLoaderStatus = "loading";
        expect(shouldShowAdvancedCellInput(status)).toBe(false);
    });

    it('returns false when status is "ready"', () => {
        const status: MapsLoaderStatus = "ready";
        expect(shouldShowAdvancedCellInput(status)).toBe(false);
    });
});
