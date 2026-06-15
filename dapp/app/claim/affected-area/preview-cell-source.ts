// ---------------------------------------------------------------------------
// preview-cell-source: 地図プレビュー用 CellSource 差し替え口
//
// 本番の DisasterClaimableProgram に対し、地図コンポーネント（AffectedAreaMap）が
// 表示できる CellSource を返す「typed seam（差し替え口）」モジュール。
//
// 現状: 被災セル取得ワーカーが未接続のため、#382 のデモ静的アセット源を返す。
// 将来: resolvePreviewCellSource の実装を「program.eventUid → 本物のワーカー取得源」
//       へ差し替えることで、この1か所だけ変更すれば地図全体が本番データに切り替わる。
// ---------------------------------------------------------------------------

import { DEMO_CLAIMABLE_PROGRAMS } from "../catalog/demo-catalog";
import {
    type CellSource,
    type ClaimableProgram,
    type DisasterClaimableProgram,
    isDisasterProgram,
} from "../catalog/claimable-program";

// ---------------------------------------------------------------------------
// pickPreviewCellSource
// ---------------------------------------------------------------------------

/**
 * デモカタログから「プレビュー表示に使う被災セル源」を選ぶ純粋関数。
 * カタログ内の災害プログラムのうち static-asset 源を持つ最初のものを返す。
 * 見つからなければ安全側に倒して { kind: "deferred" } を返す（fail-closed）。
 *
 * - 入力は破壊しない。
 * - 副作用なし・決定的。
 */
export function pickPreviewCellSource(catalog: readonly ClaimableProgram[]): CellSource {
    for (const p of catalog) {
        if (isDisasterProgram(p) && p.cellSource.kind === "static-asset") {
            return p.cellSource;
        }
    }
    // 見つからなければ安全側（fail-closed）
    return { kind: "deferred" };
}

// ---------------------------------------------------------------------------
// resolvePreviewCellSource
// ---------------------------------------------------------------------------

/**
 * 本番の災害プログラムに対し、地図プレビュー用の CellSource を返す差し替え口（typed seam）。
 *
 * 現状: 被災セル取得ワーカーが未接続のため、#382 のデモ静的アセット源を返す。
 * 将来: ここを「program.eventUid → 本物の被災セル取得ワーカー源」に差し替える。
 *       （typed seam: 引数の program はその将来の分岐のために受け取る）
 *
 * @param _program 将来の差し替え時に eventUid などで分岐するために受け取る（現状未使用）
 */
export function resolvePreviewCellSource(
    // 将来の実装で program.eventUid → ワーカー取得源へ切り替える差し替え口
    _program: DisasterClaimableProgram,
): CellSource {
    // 現状はデモカタログの static-asset 源を返す
    return pickPreviewCellSource(DEMO_CLAIMABLE_PROGRAMS);
}
