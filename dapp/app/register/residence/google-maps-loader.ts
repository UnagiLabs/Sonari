import type { LoaderOptions } from "@googlemaps/js-api-loader";

export type MapsLoaderStatus = "unconfigured" | "loading" | "ready" | "error";

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

/** Loader へ渡す設定。libraries には必ず "places" を含める。 */
export function buildMapsLoaderConfig(
    apiKey: string,
): Pick<LoaderOptions, "apiKey" | "libraries"> {
    return {
        apiKey,
        libraries: ["places"],
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
  * Google Maps の必要ライブラリ（maps, places, marker）を読み込む。
  * Loader はランタイム動的 import（node テスト環境で DOM 依存コードを読み込まないため）。
  * 失敗時は例外を投げる（呼び出し側が error 状態へ）。
  */
export async function loadGoogleMapsLibraries(apiKey: string): Promise<void> {
    const { Loader } = await import("@googlemaps/js-api-loader");
    const loader = new Loader(buildMapsLoaderConfig(apiKey));
    await loader.importLibrary("maps");
    await loader.importLibrary("places");
    await loader.importLibrary("marker");
}
