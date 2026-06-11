import type { MapsLoaderStatus } from "./google-maps-loader";

/**
 * Advanced cell input（H3 セルID 手入力欄）を表示すべきかを返す。
 * 地図が使えないとき（unconfigured / error）だけ true。
 * 地図が正常表示中（loading / ready）は false。
 */
export function shouldShowAdvancedCellInput(status: MapsLoaderStatus): boolean {
    return status === "unconfigured" || status === "error";
}
