import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { readWalletNetwork, resolveGrpcBaseUrl, type WalletNetwork } from "./wallet-network";

// MVP の wallet connect は testnet を既定にし、localnet を開発用に許可する。
// 接続先は env の NEXT_PUBLIC_SUI_NETWORK で決まり、gRPC アドレスは network ごとにハードコードして分岐する。
// mainnet は UI から選ばせない（network 検証は wallet-network.ts に集約）。
// public fullnode endpoint は MVP/testnet 用。本番 traffic は別 issue で dedicated RPC に切り替える。
const WALLET_NETWORKS: WalletNetwork[] = ["testnet", "localnet"];

export const dAppKit = createDAppKit({
    networks: WALLET_NETWORKS,
    defaultNetwork: readWalletNetwork(),
    createClient: (network) => new SuiGrpcClient({ network, baseUrl: resolveGrpcBaseUrl(network) }),
});

declare module "@mysten/dapp-kit-react" {
    interface Register {
        dAppKit: typeof dAppKit;
    }
}
