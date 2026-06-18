import type { RegisterEnokiWalletsOptions } from "@mysten/enoki";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { describe, expect, it, vi } from "vitest";
import { registerConfiguredEnokiWallets, resolveEnokiRedirectUrl } from "./enoki-wallets";

describe("registerConfiguredEnokiWallets", () => {
    const client = {} as ClientWithCoreApi;
    const redirectUrl = "https://sonari.help/";
    const enabledConfig = {
        kind: "enabled" as const,
        config: {
            apiKey: "enoki_public_key",
            googleClientId: "google-client-id",
            network: "testnet" as const,
        },
    };

    it("registers Google Enoki wallet on testnet with env config and current client", () => {
        const unregister = vi.fn();
        const register = vi.fn(() => ({ wallets: {}, unregister }));

        const cleanup = registerConfiguredEnokiWallets({
            configResult: enabledConfig,
            network: "testnet",
            client,
            redirectUrl,
            register,
        });

        expect(register).toHaveBeenCalledTimes(1);
        expect(register).toHaveBeenCalledWith({
            apiKey: "enoki_public_key",
            client,
            network: "testnet",
            providers: {
                google: {
                    clientId: "google-client-id",
                    redirectUrl,
                },
            },
        } satisfies RegisterEnokiWalletsOptions);
        expect(cleanup).toBe(unregister);
    });

    it("does not register when Enoki env config is disabled", () => {
        const register = vi.fn(() => ({ wallets: {}, unregister: vi.fn() }));

        const cleanup = registerConfiguredEnokiWallets({
            configResult: {
                kind: "disabled",
                reason: "missing_api_key",
            },
            network: "testnet",
            client,
            redirectUrl,
            register,
        });

        expect(register).not.toHaveBeenCalled();
        expect(cleanup).toBeUndefined();
    });

    it.each(["mainnet", "localnet"] as const)("does not register on %s", (network) => {
        const register = vi.fn(() => ({ wallets: {}, unregister: vi.fn() }));

        const cleanup = registerConfiguredEnokiWallets({
            configResult: enabledConfig,
            network,
            client,
            redirectUrl,
            register,
        });

        expect(register).not.toHaveBeenCalled();
        expect(cleanup).toBeUndefined();
    });

    it("returns cleanup from the register result", () => {
        const unregister = vi.fn();
        const register = vi.fn(() => ({ wallets: {}, unregister }));

        const cleanup = registerConfiguredEnokiWallets({
            configResult: enabledConfig,
            network: "testnet",
            client,
            redirectUrl,
            register,
        });

        cleanup?.();

        expect(unregister).toHaveBeenCalledTimes(1);
    });

    it("resolves the OAuth redirect URL to the origin root", () => {
        expect(resolveEnokiRedirectUrl({ origin: "https://sonari.help" })).toBe(
            "https://sonari.help/",
        );
        expect(resolveEnokiRedirectUrl({ origin: "http://localhost:3000" })).toBe(
            "http://localhost:3000/",
        );
    });
});
