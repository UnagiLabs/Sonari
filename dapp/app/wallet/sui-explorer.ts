import type { WalletNetwork } from "./wallet-network";

// トランザクション digest を Sui explorer のページ URL へ変換する純関数。
// ネットワークごとの差異をここに閉じ込め、UI 側はリンク有無だけを見れば良いようにする。
// explorer は SuiVision を採用する（testnet を安定して開ける公開 explorer）。
// localnet は公開 explorer が無いため null を返し、UI はプレーン表示へ退避する。

const SUIVISION_TESTNET_TX_BASE = "https://testnet.suivision.xyz/txblock";

export function suiExplorerTxUrl(network: WalletNetwork, digest: string): string | null {
    const trimmed = digest.trim();
    if (trimmed.length === 0) {
        return null;
    }

    switch (network) {
        case "testnet":
            return `${SUIVISION_TESTNET_TX_BASE}/${trimmed}`;
        case "localnet":
            return null;
    }
}
