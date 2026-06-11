import type { MapsLoaderStatus } from "./google-maps-loader";

/**
 * 地図ロード状態が再試行可能かを返す。
 * status が "error" のときだけ true。
 */
export function canRetryMapLoad(status: MapsLoaderStatus): boolean {
    return status === "error";
}

/**
 * 再試行 nonce をインクリメントして返す。
 * effect の依存配列に加えることで再初期化をトリガーする。
 */
export function nextRetryNonce(current: number): number {
    return current + 1;
}
