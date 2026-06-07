import { describe, expect, it } from "vitest";
import {
    isAllowedNetwork,
    resolveGrpcBaseUrl,
    resolveNetwork,
} from "./wallet-network";

describe("isAllowedNetwork", () => {
    it("returns true for testnet", () => {
        expect(isAllowedNetwork("testnet")).toBe(true);
    });

    it("returns true for localnet", () => {
        expect(isAllowedNetwork("localnet")).toBe(true);
    });

    it("returns false for mainnet", () => {
        expect(isAllowedNetwork("mainnet")).toBe(false);
    });

    it("returns false for empty string", () => {
        expect(isAllowedNetwork("")).toBe(false);
    });

    it("returns false for arbitrary strings", () => {
        expect(isAllowedNetwork("foo")).toBe(false);
    });
});

describe("resolveNetwork", () => {
    it("returns testnet for undefined", () => {
        expect(resolveNetwork(undefined)).toBe("testnet");
    });

    it("returns testnet for empty string", () => {
        expect(resolveNetwork("")).toBe("testnet");
    });

    it("returns testnet for disallowed value like mainnet", () => {
        expect(resolveNetwork("mainnet")).toBe("testnet");
    });

    it("returns testnet for foo", () => {
        expect(resolveNetwork("foo")).toBe("testnet");
    });

    it("returns testnet for testnet", () => {
        expect(resolveNetwork("testnet")).toBe("testnet");
    });

    it("returns localnet for localnet", () => {
        expect(resolveNetwork("localnet")).toBe("localnet");
    });

    it("trims surrounding whitespace before resolving", () => {
        expect(resolveNetwork(" testnet ")).toBe("testnet");
    });

    it("trims surrounding whitespace for localnet", () => {
        expect(resolveNetwork("  localnet  ")).toBe("localnet");
    });
});

describe("resolveGrpcBaseUrl", () => {
    it("returns the testnet default URL when no env override is given", () => {
        expect(resolveGrpcBaseUrl("testnet")).toBe("https://fullnode.testnet.sui.io:443");
    });

    it("returns the localnet default URL when no env override is given", () => {
        expect(resolveGrpcBaseUrl("localnet")).toBe("http://127.0.0.1:9000");
    });

    it("returns the custom testnet URL when env.testnet is set", () => {
        expect(resolveGrpcBaseUrl("testnet", { testnet: "https://custom:443" })).toBe(
            "https://custom:443",
        );
    });

    it("returns the custom localnet URL when env.localnet is set", () => {
        expect(
            resolveGrpcBaseUrl("localnet", { localnet: "http://192.168.1.1:9000" }),
        ).toBe("http://192.168.1.1:9000");
    });

    it("falls back to default when env.testnet is empty string", () => {
        expect(resolveGrpcBaseUrl("testnet", { testnet: "" })).toBe(
            "https://fullnode.testnet.sui.io:443",
        );
    });

    it("falls back to default when env.localnet is empty string", () => {
        expect(resolveGrpcBaseUrl("localnet", { localnet: "" })).toBe(
            "http://127.0.0.1:9000",
        );
    });

    it("ignores localnet override when resolving testnet", () => {
        expect(
            resolveGrpcBaseUrl("testnet", { localnet: "http://ignored:9000" }),
        ).toBe("https://fullnode.testnet.sui.io:443");
    });
});
