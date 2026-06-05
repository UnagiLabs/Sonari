import { AffectedCellsProofError } from "./errors.js";

/**
 * token 認証に必要な Env フィールドのサブセット。
 * walrus.ts の Env から extends する代わりにここでも独立定義し、
 * walrus.ts 側で AuthEnv を import して intersection を取る。
 */
export interface AuthEnv {
    AFFECTED_PROOF_REGISTER_TOKEN?: string;
    GEO_RESOLUTION?: string;
}

/**
 * リクエストヘッダー `x-sonari-affected-proof-register-token` を読み取り、
 * `env.AFFECTED_PROOF_REGISTER_TOKEN` と定数時間比較する。
 *
 * fail-closed: 以下の条件はすべて `unauthorized`(401) を throw する。
 * - secret 未設定（undefined）または空文字
 * - header 欠落
 * - header が空文字
 * - secret と token が不一致
 *
 * 定数時間比較の実装方針:
 * 1. 長さが違う場合でも早期 return しない（長さ差もタイミング情報になるため）。
 *    両者を同じ長さに揃えてから比較する。
 * 2. TextEncoder で bytes 化し、byte ごとに XOR を蓄積する。
 *    XOR 蓄積値が 0 であれば全 byte が一致。早期 return しない。
 * 3. 長さが違う場合は最終的に mismatch フラグを立てる（長さも比較対象）。
 *
 * これにより、タイミング攻撃で secret の内容や長さが漏れることを防ぐ。
 */
export async function verifyRegisterToken(req: Request, env: AuthEnv): Promise<void> {
    const secret = env.AFFECTED_PROOF_REGISTER_TOKEN;
    const token = req.headers.get("x-sonari-affected-proof-register-token");

    // fail-closed: secret 未設定または空文字は「認証不可」として即 401
    // （ただし、timing 情報を漏らさないよう定数時間比較を必ず実行する）
    const secretConfigured = secret !== undefined && secret.length > 0;

    // header 欠落または空文字も 401
    const tokenPresent = token !== null && token.length > 0;

    // 定数時間比較 (byte XOR 蓄積方式)
    // secret/token どちらかが空でも比較処理自体は実行して timing を均一化する
    const secretValue = secret ?? "";
    const tokenValue = token ?? "";
    const timingSafeMatch = await constantTimeEqual(secretValue, tokenValue);

    if (!secretConfigured || !tokenPresent || !timingSafeMatch) {
        throw new AffectedCellsProofError(
            "unauthorized",
            "Invalid or missing register token",
            401,
        );
    }
}

/**
 * 2 つの文字列を定数時間で比較する。
 *
 * 実装:
 * 1. TextEncoder で bytes 化する。
 * 2. 長い方の長さに揃え、短い方をゼロ埋めして比較する。
 *    → 長さが違う場合は byte 値が異なるためフラグが立つ。
 * 3. 全 byte の XOR を蓄積し、最後に 0 か否かで判定する。
 *    どの byte で不一致が起きても処理時間が変わらない。
 * 4. 長さ自体も比較して、長さ違いを確実に弾く。
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const aBytes = encoder.encode(a);
    const bBytes = encoder.encode(b);

    const maxLen = Math.max(aBytes.length, bBytes.length);

    // 長さが 0 同士の場合は「一致」にせず呼び出し元で制御する
    // ここでは純粋に bytes の一致を返す（呼び出し元で secretConfigured と組み合わせて判断）
    if (maxLen === 0) {
        return true;
    }

    // 両者をゼロ埋めで同じ長さに揃える
    const aPadded = new Uint8Array(maxLen);
    const bPadded = new Uint8Array(maxLen);
    aPadded.set(aBytes);
    bPadded.set(bBytes);

    // 全 byte の XOR を蓄積 (早期 return なし)
    let diff = 0;
    for (let i = 0; i < maxLen; i++) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        diff |= aPadded[i]! ^ bPadded[i]!;
    }

    // 長さも比較（XOR で長さ差は検出されるが明示的に確認する）
    const lengthEqual = aBytes.length === bBytes.length ? 0 : 1;

    return (diff | lengthEqual) === 0;
}
