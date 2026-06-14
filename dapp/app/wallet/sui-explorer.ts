import type { WalletNetwork } from "./wallet-network";

// トランザクション digest を Sui explorer のページ URL へ変換する純関数。
// ネットワークごとの差異をここに閉じ込め、UI 側はリンク有無だけを見れば良いようにする。
// explorer は SuiScan を採用する（mainnet / testnet を安定して開ける公開 explorer）。
// localnet は公開 explorer が無いため null を返し、UI はプレーン表示へ退避する。

const SUISCAN_MAINNET_TX_BASE = "https://suiscan.xyz/mainnet/tx";
const SUISCAN_TESTNET_TX_BASE = "https://suiscan.xyz/testnet/tx";

export function suiExplorerTxUrl(network: WalletNetwork, digest: string): string | null {
    const trimmed = digest.trim();
    if (trimmed.length === 0) {
        return null;
    }

    switch (network) {
        case "mainnet":
            return `${SUISCAN_MAINNET_TX_BASE}/${trimmed}`;
        case "testnet":
            return `${SUISCAN_TESTNET_TX_BASE}/${trimmed}`;
        case "localnet":
            return null;
    }
}
