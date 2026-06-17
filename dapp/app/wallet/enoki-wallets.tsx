"use client";

import { useCurrentClient, useCurrentNetwork } from "@mysten/dapp-kit-react";
import { type RegisterEnokiWalletsOptions, registerEnokiWallets } from "@mysten/enoki";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { useEffect } from "react";
import { type EnokiConfigResult, readEnokiConfig } from "./enoki-config";
import type { WalletNetwork } from "./wallet-network";

type RegisterEnokiWallets = (
    options: RegisterEnokiWalletsOptions,
) => ReturnType<typeof registerEnokiWallets>;

type RegisterConfiguredEnokiWalletsInput = {
    readonly configResult: EnokiConfigResult;
    readonly network: WalletNetwork;
    readonly client: ClientWithCoreApi;
    readonly register?: RegisterEnokiWallets;
};

export function registerConfiguredEnokiWallets({
    configResult,
    network,
    client,
    register = registerEnokiWallets,
}: RegisterConfiguredEnokiWalletsInput): (() => void) | undefined {
    if (configResult.kind !== "enabled" || network !== "testnet") {
        return undefined;
    }

    const result = register({
        apiKey: configResult.config.apiKey,
        client,
        network,
        providers: {
            google: {
                clientId: configResult.config.googleClientId,
            },
        },
    });

    return result.unregister;
}

export function RegisterEnokiWallets() {
    const client = useCurrentClient();
    const network = useCurrentNetwork();

    useEffect(() => {
        return registerConfiguredEnokiWallets({
            configResult: readEnokiConfig(),
            network,
            client,
        });
    }, [client, network]);

    return null;
}
