import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { readWalletNetwork, type WalletNetwork } from "../wallet/wallet-network";
import type { GenesisObjectQueryClient } from "./genesis-objects";

export interface JsonRpcEventClientOptions {
    readonly network?: WalletNetwork;
    readonly jsonRpcUrl?: string;
}

let cachedClient:
    | {
          readonly network: WalletNetwork;
          readonly url: string;
          readonly client: SuiJsonRpcClient;
      }
    | null = null;

export function resolveJsonRpcEventClientConfig(
    options: JsonRpcEventClientOptions = {},
): { readonly network: WalletNetwork; readonly url: string } {
    const network = options.network ?? readWalletNetwork();
    const override = (options.jsonRpcUrl ?? process.env.NEXT_PUBLIC_SONARI_JSONRPC_URL ?? "").trim();
    const url = override.length > 0 ? override : getJsonRpcFullnodeUrl(network);
    return { network, url };
}

export function createJsonRpcEventClient(
    options: JsonRpcEventClientOptions = {},
): GenesisObjectQueryClient {
    const config = resolveJsonRpcEventClientConfig(options);
    if (
        cachedClient !== null &&
        cachedClient.network === config.network &&
        cachedClient.url === config.url
    ) {
        return cachedClient.client;
    }

    const client = new SuiJsonRpcClient({ network: config.network, url: config.url });
    cachedClient = { ...config, client };
    return client;
}
