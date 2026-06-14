import { describe, expect, it } from "vitest";
import { suiExplorerTxUrl } from "./sui-explorer";

describe("suiExplorerTxUrl", () => {
    const digest = "8oM2nT3kQ4abcDEFghiJKLmnopQRstUVwxyz1234567";

    it("returns a SuiScan testnet tx URL for testnet", () => {
        expect(suiExplorerTxUrl("testnet", digest)).toBe(
            `https://suiscan.xyz/testnet/tx/${digest}`,
        );
    });

    it("returns a SuiScan mainnet tx URL for mainnet", () => {
        expect(suiExplorerTxUrl("mainnet", digest)).toBe(
            `https://suiscan.xyz/mainnet/tx/${digest}`,
        );
    });

    it("returns null for localnet because no public explorer exists", () => {
        expect(suiExplorerTxUrl("localnet", digest)).toBeNull();
    });

    it("returns null for an empty digest", () => {
        expect(suiExplorerTxUrl("testnet", "")).toBeNull();
    });

    it("trims surrounding whitespace from the digest before building the URL", () => {
        expect(suiExplorerTxUrl("testnet", `  ${digest}  `)).toBe(
            `https://suiscan.xyz/testnet/tx/${digest}`,
        );
    });

    it("returns null for a whitespace-only digest", () => {
        expect(suiExplorerTxUrl("testnet", "   ")).toBeNull();
    });
});
