import { describe, it, expect } from "vitest";
import {
    readGoogleMapsApiKey,
    isGoogleMapsConfigured,
    buildMapsLoaderConfig,
    resolveInitialMapsStatus,
    resolveLoadedMapsStatus,
    type MapsLoaderStatus,
} from "./google-maps-loader";

describe("readGoogleMapsApiKey", () => {
    it("前後の空白を trim して返す", () => {
        expect(readGoogleMapsApiKey("  abc  ")).toBe("abc");
    });

    it("空文字はそのまま空文字", () => {
        expect(readGoogleMapsApiKey("")).toBe("");
    });

    it("空白のみは空文字になる", () => {
        expect(readGoogleMapsApiKey("   ")).toBe("");
    });
});

describe("isGoogleMapsConfigured", () => {
    it("空文字は false", () => {
        expect(isGoogleMapsConfigured("")).toBe(false);
    });

    it("空白のみは false", () => {
        expect(isGoogleMapsConfigured("   ")).toBe(false);
    });

    it("非空文字列は true", () => {
        expect(isGoogleMapsConfigured("k")).toBe(true);
    });
});

describe("buildMapsLoaderConfig", () => {
    it("key が一致する", () => {
        const config = buildMapsLoaderConfig("k");
        expect(config.key).toBe("k");
    });

    it("libraries に 'places' が含まれる", () => {
        const config = buildMapsLoaderConfig("k");
        expect(config.libraries).toContain("places");
    });
});

describe("resolveInitialMapsStatus", () => {
    it("key が空のとき 'unconfigured'", () => {
        expect(resolveInitialMapsStatus("")).toBe("unconfigured");
    });

    it("key が非空のとき 'loading'", () => {
        expect(resolveInitialMapsStatus("k")).toBe("loading");
    });
});

describe("resolveLoadedMapsStatus", () => {
    it("key が空のとき 'unconfigured'（loadSucceeded=true でも）", () => {
        expect(resolveLoadedMapsStatus("", true)).toBe("unconfigured");
    });

    it("key が非空かつ loadSucceeded=true のとき 'ready'", () => {
        expect(resolveLoadedMapsStatus("k", true)).toBe("ready");
    });

    it("key が非空かつ loadSucceeded=false のとき 'error'", () => {
        expect(resolveLoadedMapsStatus("k", false)).toBe("error");
    });
});

describe("MapsLoaderStatus の状態区別", () => {
    it("'unconfigured' と 'error' は別の文字列状態", () => {
        const unconfigured: MapsLoaderStatus = resolveLoadedMapsStatus("", false);
        const error: MapsLoaderStatus = resolveLoadedMapsStatus("k", false);
        expect(unconfigured).not.toBe(error);
        expect(unconfigured).toBe("unconfigured");
        expect(error).toBe("error");
    });
});
