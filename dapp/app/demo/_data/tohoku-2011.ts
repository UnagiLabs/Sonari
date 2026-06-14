/**
 * 東日本大震災(2011)のデモ表示用の固定データ。
 *
 * 出どころ(実データ): great_tohoku_2011 フィクスチャ
 *   - nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/input/usgs_detail.json
 *   - nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/unsigned_payload.json
 *   - nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/result.json
 *
 * 18,429 セルの影響範囲データはブラウザに載せず、イベント概要のみを定数で持つ。
 * H3 セルの地図表示は本 issue の範囲外(別 issue)。将来の地図表示で出どころを
 * 辿れるよう、このコメントにフィクスチャパスを残す。
 */
export interface TohokuDemoEarthquake {
    /** USGS タイトル(マグニチュード込み)。 */
    readonly title: string;
    /** 地域名。 */
    readonly region: string;
    /** 発生日(ISO, 表示用)。occurredAtMs 由来。 */
    readonly occurredOn: string;
    /** 発生時刻(UNIX ミリ秒, フィクスチャ raw)。 */
    readonly occurredAtMs: number;
    /** マグニチュード。 */
    readonly magnitude: number;
    /** 最大震度 MMI。 */
    readonly mmi: number;
    /** severity band(1-3)。 */
    readonly severityBand: number;
    /** 影響セル数(H3)。 */
    readonly affectedCellCount: number;
    /** H3 解像度。 */
    readonly h3Resolution: number;
    /** 震源。 */
    readonly epicenter: {
        readonly latitude: number;
        readonly longitude: number;
        readonly depthKm: number;
    };
    /** USGS event id。 */
    readonly usgsEventId: string;
}

export const TOHOKU_2011_DEMO_EARTHQUAKE: TohokuDemoEarthquake = {
    title: "M 9.1 - 2011 Great Tohoku Earthquake, Japan",
    region: "2011 Great Tohoku Earthquake, Japan",
    occurredOn: "2011-03-11",
    occurredAtMs: 1299822384120,
    magnitude: 9.1,
    mmi: 8.18,
    severityBand: 3,
    affectedCellCount: 18429,
    h3Resolution: 7,
    epicenter: { latitude: 38.297, longitude: 142.373, depthKm: 29 },
    usgsEventId: "official20110311054624120_30",
};
