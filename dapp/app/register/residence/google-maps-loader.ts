import type { APIOptions } from "@googlemaps/js-api-loader";

export type MapsLoaderStatus = "unconfigured" | "loading" | "ready" | "error";

// 住所検索の PlaceAutocompleteElement と地図描画に必要なライブラリ。
const RESIDENCE_MAPS_LIBRARIES = ["maps", "places"] as const;

// --- 純粋関数（テスト対象） ---

/**
 * API key を trim して返す（無ければ ""）。
 *
 * 既定値を「静的な process.env.NEXT_PUBLIC_* メンバー参照」にしているのが要点。
 * Next/Turbopack はこの静的形だけをクライアントバンドルへインライン展開する。
 * process.env を別名へ入れて env["..."] のように動的アクセスすると展開されず、
 * クライアントでは値が空になり地図が出ない（過去の不具合の原因）。
 * テストでは raw に文字列を直接渡して検証する。
 */
export function readGoogleMapsApiKey(
    raw: string | undefined = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
): string {
    return (raw ?? "").trim();
}

/** trim 後に非空なら true。 */
export function isGoogleMapsConfigured(apiKey: string): boolean {
    return apiKey.trim().length > 0;
}

/**
 * Maps JavaScript API へ渡すオプション。
 * v2 では key（v1 の apiKey ではない）と libraries を使う。
 */
export function buildMapsLoaderConfig(apiKey: string): APIOptions {
    return {
        key: apiKey,
        libraries: [...RESIDENCE_MAPS_LIBRARIES],
    };
}

/** key 空 → "unconfigured"、非空 → "loading"。 */
export function resolveInitialMapsStatus(apiKey: string): MapsLoaderStatus {
    if (!isGoogleMapsConfigured(apiKey)) {
        return "unconfigured";
    }
    return "loading";
}

/** key 空 → "unconfigured"。非空かつ loadSucceeded → "ready"、失敗 → "error"。 */
export function resolveLoadedMapsStatus(
    apiKey: string,
    loadSucceeded: boolean,
): MapsLoaderStatus {
    if (!isGoogleMapsConfigured(apiKey)) {
        return "unconfigured";
    }
    return loadSucceeded ? "ready" : "error";
}

// --- 副作用ラッパ（テスト対象外・薄く） ---

/**
 * Google Maps の必要ライブラリ（maps, places）を読み込む。
 * v2 の関数 API（setOptions + importLibrary）を使う。Loader クラスは非推奨のため使わない。
 * ランタイム実装は動的 import（node テスト環境で DOM 依存コードを読み込まないため）。
 * 失敗時は例外を投げる（呼び出し側が error 状態へ）。
 */
export async function loadGoogleMapsLibraries(apiKey: string): Promise<void> {
    const { setOptions, importLibrary } = await import("@googlemaps/js-api-loader");
    setOptions(buildMapsLoaderConfig(apiKey));
    for (const library of RESIDENCE_MAPS_LIBRARIES) {
        await importLibrary(library);
    }
}
