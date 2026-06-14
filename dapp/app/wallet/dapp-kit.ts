import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { readWalletNetwork, resolveGrpcBaseUrl, type WalletNetwork } from "./wallet-network";

// MVP の wallet connect は testnet を既定にし、mainnet 切り替えと localnet 開発を許可する。
// 接続先は env の NEXT_PUBLIC_SUI_NETWORK で決まり、gRPC アドレスは network ごとにハードコードして分岐する。
// public fullnode endpoint は MVP/testnet 用。本番 traffic は別 issue で dedicated RPC に切り替える。
const WALLET_NETWORKS: WalletNetwork[] = ["mainnet", "testnet", "localnet"];

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
