import { describe, expect, it } from "vitest";
import { resolveJsonRpcEventClientConfig } from "./json-rpc-event-client";

describe("resolveJsonRpcEventClientConfig", () => {
    it("uses the explicit JSON-RPC URL when provided", () => {
        expect(
            resolveJsonRpcEventClientConfig({
                network: "testnet",
                jsonRpcUrl: " https://rpc.example.test ",
            }),
        ).toEqual({
            network: "testnet",
            url: "https://rpc.example.test",
        });
    });

    it("falls back to the Sui fullnode URL for the selected network", () => {
        expect(resolveJsonRpcEventClientConfig({ network: "mainnet", jsonRpcUrl: "" })).toEqual({
            network: "mainnet",
            url: "https://fullnode.mainnet.sui.io:443",
        });
    });
});
