import type { APIOptions } from "@googlemaps/js-api-loader";

export type MapsLoaderStatus = "unconfigured" | "loading" | "ready" | "error";

// 住所検索の Places Autocomplete と地図描画に必要なライブラリ。
const RESIDENCE_MAPS_LIBRARIES = ["maps", "places"] as const;

// --- 純粋関数（テスト対象） ---

/**
 * env から API key を読む。既定は process.env。
 * NEXT_PUBLIC_GOOGLE_MAPS_API_KEY を trim して返す（無ければ ""）。
 * output: "export" では process.env.NEXT_PUBLIC_* はビルド時静的置換されるため、
 * テスト可能にするため env を引数で注入できるようにしている。
 */
export function readGoogleMapsApiKey(
    env: Record<string, string | undefined> = process.env as Record<
        string,
        string | undefined
    >,
): string {
    return (env["NEXT_PUBLIC_GOOGLE_MAPS_API_KEY"] ?? "").trim();
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
