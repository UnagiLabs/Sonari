import type { ReactNode } from "react";

interface LoadingIndicatorProps {
    /** 処理中であることを伝えるラベル文字列。呼び出し側で翻訳済みの文言を渡す。 */
    readonly label: string;
    /** スピナーの併記要素（任意）。digest など補足を添えたいときに使う。 */
    readonly children?: ReactNode;
}

/**
 * スピナー付きの共通ローディング表示。
 *
 * テキストだけの待機表示を置き換え、処理中であることを一目で分かるようにする。
 * `role="status"` と `aria-live="polite"` でスクリーンリーダーにも進行を伝える。
 */
export function LoadingIndicator({ label, children }: LoadingIndicatorProps) {
    return (
        <div aria-live="polite" className="loading-indicator" role="status">
            <span aria-hidden="true" className="loading-spinner" />
            <span className="loading-indicator-label">{label}</span>
            {children}
        </div>
    );
}
