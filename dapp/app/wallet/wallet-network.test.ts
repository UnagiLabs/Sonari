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
    it("returns the hardcoded testnet gRPC URL", () => {
        expect(resolveGrpcBaseUrl("testnet")).toBe("https://fullnode.testnet.sui.io:443");
    });

    it("returns the hardcoded localnet gRPC URL", () => {
        expect(resolveGrpcBaseUrl("localnet")).toBe("http://127.0.0.1:9000");
    });
});
