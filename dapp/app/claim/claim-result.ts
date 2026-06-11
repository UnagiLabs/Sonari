import type { WalletNetwork } from "../wallet/wallet-network";
import { suiExplorerTxUrl } from "../wallet/sui-explorer";
import type { ClaimMessage } from "./claim-messages";

// 申請トランザクションの進行状態。claim-view と claim-result が共有する正の型として
// ここに置き、表示モデルの導出を純関数に閉じ込める。
export type TxState =
    | { readonly status: "idle" }
    | { readonly status: "building" }
    | { readonly status: "submitting" }
    | { readonly status: "submitted"; readonly digest: string }
    | { readonly status: "failed"; readonly message: ClaimMessage };

// 結果パネルの描画に必要な要素だけを取り出した表示モデル。
// UI はこの値を見るだけで、スピナー・explorer リンク・次アクション CTA を出し分けられる。
export interface ClaimResultView {
    /** building / submitting の間 true。スピナーを出す。 */
    readonly loading: boolean;
    /** submitted のときの digest。未確定なら null。 */
    readonly digest: string | null;
    /** submitted かつ explorer がある network のときの tx URL。なければ null。 */
    readonly explorerUrl: string | null;
    /** submitted のとき true。マイページへの次アクション CTA を出す。 */
    readonly showDashboardCta: boolean;
}

export function buildClaimResultView(state: TxState, network: WalletNetwork): ClaimResultView {
    if (state.status === "submitted") {
        return {
            loading: false,
            digest: state.digest,
            explorerUrl: suiExplorerTxUrl(network, state.digest),
            showDashboardCta: true,
        };
    }

    return {
        loading: state.status === "building" || state.status === "submitting",
        digest: null,
        explorerUrl: null,
        showDashboardCta: false,
    };
}
