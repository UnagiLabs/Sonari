import { describe, expect, it } from "vitest";
import {
    isAllowedNetwork,
    resolveGrpcBaseUrl,
    resolveNetwork,
    shouldShowTestnetBadge,
    shouldWarnNetworkMismatch,
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

describe("shouldWarnNetworkMismatch", () => {
    it("returns true when connected to mainnet", () => {
        expect(shouldWarnNetworkMismatch("connected", "mainnet")).toBe(true);
    });

    it("returns false when connected to testnet", () => {
        expect(shouldWarnNetworkMismatch("connected", "testnet")).toBe(false);
    });

    it("returns false when connected to localnet", () => {
        expect(shouldWarnNetworkMismatch("connected", "localnet")).toBe(false);
    });

    it("returns false when connected but network is empty string", () => {
        expect(shouldWarnNetworkMismatch("connected", "")).toBe(false);
    });

    it("returns false when connected but network is null", () => {
        expect(shouldWarnNetworkMismatch("connected", null)).toBe(false);
    });

    it("returns false when connected but network is undefined", () => {
        expect(shouldWarnNetworkMismatch("connected", undefined)).toBe(false);
    });

    it("returns true when connected to mainnet with surrounding whitespace", () => {
        expect(shouldWarnNetworkMismatch("connected", " mainnet ")).toBe(true);
    });

    it("returns false when disconnected even if network is mainnet", () => {
        expect(shouldWarnNetworkMismatch("disconnected", "mainnet")).toBe(false);
    });

    it("returns false when connecting even if network is mainnet", () => {
        expect(shouldWarnNetworkMismatch("connecting", "mainnet")).toBe(false);
    });

    it("returns false when reconnecting even if network is mainnet", () => {
        expect(shouldWarnNetworkMismatch("reconnecting", "mainnet")).toBe(false);
    });
});

describe("shouldShowTestnetBadge", () => {
    it("returns true only when connected to testnet", () => {
        expect(shouldShowTestnetBadge("connected", "testnet")).toBe(true);
    });

    it("returns false when disconnected even if network is testnet", () => {
        expect(shouldShowTestnetBadge("disconnected", "testnet")).toBe(false);
    });

    it("returns false when connected to localnet", () => {
        expect(shouldShowTestnetBadge("connected", "localnet")).toBe(false);
    });

    it("returns false when connected to mainnet", () => {
        expect(shouldShowTestnetBadge("connected", "mainnet")).toBe(false);
    });

    it("trims surrounding whitespace before checking testnet", () => {
        expect(shouldShowTestnetBadge("connected", " testnet ")).toBe(true);
    });

    it("returns false when connected but network is empty", () => {
        expect(shouldShowTestnetBadge("connected", "")).toBe(false);
    });

    it("returns false when connected but network is null", () => {
        expect(shouldShowTestnetBadge("connected", null)).toBe(false);
    });

    it("returns false when connected but network is undefined", () => {
        expect(shouldShowTestnetBadge("connected", undefined)).toBe(false);
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
