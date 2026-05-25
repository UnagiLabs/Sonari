import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixtureRelayerSubmitInput } from "../nautilus/verifiers/earthquake/relayer/src/index.js";
import { createNautilusSidecarServer } from "./nautilus_sidecar.js";

const servers: ReturnType<typeof createNautilusSidecarServer>[] = [];

describe("Nautilus sidecar relayer submit endpoint", () => {
    afterEach(async () => {
        await Promise.all(
            servers.splice(0).map(
                (server) =>
                    new Promise<void>((resolve, reject) => {
                        server.close((error) => (error === undefined ? resolve() : reject(error)));
                    }),
            ),
        );
    });

    it("fails closed as signer-not-configured instead of submitting to Sui", async () => {
        const server = createNautilusSidecarServer();
        servers.push(server);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const { port } = server.address() as AddressInfo;

        const response = await fetch(`http://127.0.0.1:${port}/relayer/submit`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                input: loadFixtureRelayerSubmitInput("usgs/finalized_minimal"),
                target: "0x123::disaster_oracle::submit_payload_v1",
                registry: "0x456",
                verifierRegistry: "0x654",
                grpcUrl: "https://fullnode.testnet.sui.io:443",
                senderAddress: "0x789",
            }),
        });

        await expect(response.json()).resolves.toEqual({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "submit signer is not configured in the local sidecar",
        });
        expect(response.status).toBe(400);
    });
});
