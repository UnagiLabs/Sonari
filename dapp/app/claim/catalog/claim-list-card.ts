// ---------------------------------------------------------------------------
// ClaimListCard: 一覧カード表示用の整形済みデータを作る純粋関数
//
// ClaimableProgram を受け取り、一覧カードの表示に必要な文字列を整形して返す。
// - 金額: range は "<min>–<max>"（U+2013 EN DASH）、fixed は "<usdc>"（通貨語なし）
// - 締切: 10 進 ms 文字列を YYYY-MM-DD へ。不正値は元文字列をそのまま返す
// - id / title / scope / detailHref は program から透過
//
// 翻訳が要る語は含めない。数値・日付の整形のみ担当する。
// 翻訳は後続 STEP の i18n が担当する。
// ---------------------------------------------------------------------------

import type { AmountSummary, ClaimableProgram } from "./claimable-program";

// ---------------------------------------------------------------------------
// ClaimListCardView: 一覧カードの表示用データ型
// ---------------------------------------------------------------------------

/**
 * 一覧カードの表示用データ（翻訳が要る語は含めない。数値・日付の整形のみ）。
 */
export interface ClaimListCardView {
    /** プログラム識別子。program から透過。 */
    readonly id: string;
    /** 表示タイトル。program から透過。 */
    readonly title: string;
    /** 対象範囲の説明。program から透過。 */
    readonly scope: string;
    /**
     * 金額表記。通貨語は付けない。数値のみ。
     * - range: "<minUsdc>–<maxUsdc>"（U+2013 EN DASH 区切り）
     * - fixed: "<usdc>"
     */
    readonly amountText: string;
    /**
     * 締切表記。10 進 ms 文字列を YYYY-MM-DD へ整形する。
     * 不正値（Number 変換後に Number.isSafeInteger を満たさない、または負数）は
     * 元の deadlineMs 文字列をそのまま返す。
     */
    readonly deadlineText: string;
    /** 詳細ページへのリンク。program.detailHref をそのまま透過。 */
    readonly detailHref: string;
}

// ---------------------------------------------------------------------------
// buildClaimListCard: ClaimableProgram → ClaimListCardView
// ---------------------------------------------------------------------------

/**
 * `ClaimableProgram` を一覧カードの表示用データへ整形する pure 関数。
 *
 * 副作用なし・決定的。同じ program を渡すと常に同じ結果を返す。
 */
export function buildClaimListCard(program: ClaimableProgram): ClaimListCardView {
    return {
        id: program.id,
        title: program.title,
        scope: program.scope,
        amountText: formatAmountText(program.amountSummary),
        deadlineText: formatDeadlineText(program.deadlineMs),
        detailHref: program.detailHref,
    };
}

// ---------------------------------------------------------------------------
// 内部ヘルパー: 金額整形
// ---------------------------------------------------------------------------

/**
 * `AmountSummary` を表示用文字列へ整形する。
 * - range: "<minUsdc>–<maxUsdc>"（U+2013 EN DASH で区切る。通貨語なし）
 * - fixed: "<usdc>"（通貨語なし）
 */
function formatAmountText(summary: AmountSummary): string {
    if (summary.kind === "range") {
        // U+2013 EN DASH で区切る（ハイフン U+002D ではない）
        return `${String(summary.minUsdc)}–${String(summary.maxUsdc)}`;
    }
    // kind === "fixed"
    return String(summary.usdc);
}

// ---------------------------------------------------------------------------
// 内部ヘルパー: 締切整形
// ---------------------------------------------------------------------------

/**
 * 10 進 ms 文字列を YYYY-MM-DD へ整形する。
 *
 * 既存 `claim-view.tsx` の `formatClaimWindow` と同じロジック:
 * - `Number(deadlineMs)` で変換
 * - `Number.isSafeInteger(n) && n >= 0` を満たすなら `new Date(n).toISOString().slice(0, 10)`
 * - それ以外は `deadlineMs` をそのまま返す
 */
function formatDeadlineText(deadlineMs: string): string {
    const n = Number(deadlineMs);
    if (!Number.isSafeInteger(n) || n < 0) {
        return deadlineMs;
    }
    return new Date(n).toISOString().slice(0, 10);
}
