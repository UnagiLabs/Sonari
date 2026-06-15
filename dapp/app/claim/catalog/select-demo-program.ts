import type { ClaimableProgram } from "./claimable-program";

/**
 * programs から id 一致の 1 件を返す。無ければ null。
 * 純粋関数（外部 I/O なし・入力を破壊しない）。
 *
 * - 副作用なし・決定的。
 * - 返り値は ClaimableProgram 全体（category / detailHref 等
 *   詳細ページルーティングで必要なフィールドを保持）。
 *
 * @see selectCampaignById 同じ流儀の本番キャンペーン版
 */
export function selectDemoProgramById(
    programs: readonly ClaimableProgram[],
    programId: string,
): ClaimableProgram | null {
    return programs.find((p) => p.id === programId) ?? null;
}
