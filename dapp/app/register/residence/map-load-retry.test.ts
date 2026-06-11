import { describe, expect, it } from "vitest";
import type { MapsLoaderStatus } from "./google-maps-loader";
import { canRetryMapLoad, nextRetryNonce } from "./map-load-retry";

describe("canRetryMapLoad", () => {
    it('returns true when status is "error"', () => {
        const status: MapsLoaderStatus = "error";
        expect(canRetryMapLoad(status)).toBe(true);
    });

    it('returns false when status is "loading"', () => {
        const status: MapsLoaderStatus = "loading";
        expect(canRetryMapLoad(status)).toBe(false);
    });

    it('returns false when status is "ready"', () => {
        const status: MapsLoaderStatus = "ready";
        expect(canRetryMapLoad(status)).toBe(false);
    });

    it('returns false when status is "unconfigured"', () => {
        const status: MapsLoaderStatus = "unconfigured";
        expect(canRetryMapLoad(status)).toBe(false);
    });
});

describe("nextRetryNonce", () => {
    it("increments 0 to 1", () => {
        expect(nextRetryNonce(0)).toBe(1);
    });

    it("increments 5 to 6", () => {
        expect(nextRetryNonce(5)).toBe(6);
    });

    it("increments arbitrary number", () => {
        expect(nextRetryNonce(99)).toBe(100);
    });
});
