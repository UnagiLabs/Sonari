// ---------------------------------------------------------------------------
// 領収書番号（受付番号）の決定的採番。
//
// トランザクション digest から再現可能な番号を導出する純関数。ダミー値を残さず、
// 同じ digest からは常に同じ番号（SNR-<年>-<6桁 base36>）を返す。
// 年は受領日（submittedAt のミリ秒）が分かればその年を、無ければ現在年を使う。
// ---------------------------------------------------------------------------

const SUFFIX_LENGTH = 6;
const BASE36_RADIX = 36;
// 32bit FNV 系の単純な転がしハッシュ。暗号用途ではなく表示用の決定的採番。
const HASH_MULTIPLIER = 31;

/**
 * digest から決定的な受付番号を作る。
 *
 * @param digest        トランザクションダイジェスト（base58 文字列）。
 * @param receivedAtMs  受領時刻（ミリ秒）。null / 非正値なら現在年を使う。
 */
export function receiptNumber(digest: string, receivedAtMs: number | null): string {
    const year =
        receivedAtMs !== null && receivedAtMs > 0
            ? new Date(receivedAtMs).getFullYear()
            : new Date().getFullYear();
    return `SNR-${year}-${digestSuffix(digest)}`;
}

/** digest を 6 桁の base36（大文字）に圧縮する。空文字でも安定して 0 埋めを返す。 */
function digestSuffix(digest: string): string {
    let hash = 0;
    for (let index = 0; index < digest.length; index += 1) {
        hash = (hash * HASH_MULTIPLIER + digest.charCodeAt(index)) >>> 0;
    }
    return hash
        .toString(BASE36_RADIX)
        .toUpperCase()
        .padStart(SUFFIX_LENGTH, "0")
        .slice(-SUFFIX_LENGTH);
}
