/**
 * デモカタログ固定データ。
 *
 * 3カテゴリ（disaster / student-fund / medical）を固定値で保持し、
 * UI 各画面が同一データソースを参照できるようにする。
 * すべて純粋な定数であり、外部 I/O を行わない。
 */

import { bandAmount } from "./cell-band-rules";
import type { ClaimableProgram, DisasterClaimableProgram } from "./claimable-program";
import { TOHOKU_2011_DEMO_EARTHQUAKE } from "../../../app/demo/_data/tohoku-2011";

// ---------------------------------------------------------------------------
// 代表居住セル定数
//
// 東日本大震災の実被災セット内のセル（res7・10進 H3）。
// デモ会員証 DEMO_PASS とデモ請求詳細で使う。
// ---------------------------------------------------------------------------

/**
 * 実被災セット内の Band3 セル（10進 H3 res7）。
 * デモ会員証の homeCell として使い、地図に自宅が被災エリア内として強調される。
 */
export const DEMO_AFFECTED_HOME_CELL_BAND3 = "608795190286614527";

/**
 * 実被災セット内の Band1 セル（10進 H3 res7）。
 * デモ請求詳細で Band1 の例示として使う。
 */
export const DEMO_AFFECTED_HOME_CELL_BAND1 = "608795262395088895";

// ---------------------------------------------------------------------------
// 災害プログラム: 東日本大震災 2011
//
// eventUid / affectedCellsRoot は以下フィクスチャ由来:
//   nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/unsigned_payload.json
// 表示・受け渡し用に持つだけで検証ロジックは作らない。
//
// cellSource の path は STEP 5 が dapp/public/demo/tohoku-2011-affected-cells.json
// に生成する静的アセットの URL パスと一致させる（実体は STEP 5 で生成）。
// ---------------------------------------------------------------------------

const TOHOKU_2011_PROGRAM: DisasterClaimableProgram = {
    id: "tohoku-2011",
    category: "disaster",
    title: TOHOKU_2011_DEMO_EARTHQUAKE.title,
    scope: TOHOKU_2011_DEMO_EARTHQUAKE.region,
    amountSummary: {
        // 金額は表示用デモ値、バンドは実値
        kind: "range",
        minUsdc: bandAmount(1),
        maxUsdc: bandAmount(3),
    },
    // 締切は表示用デモ値（2025-12-31 23:59:59 JST = UTC+9）
    deadlineMs: "1767214799000",
    detailHref: "/demo/claim/tohoku-2011",
    // eventUid: nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/unsigned_payload.json 由来
    // 表示・受け渡し用に持つだけで検証ロジックは作らない。
    eventUid: "0x552d0b5280b31910b6ff306632e05e9f2c0b4e9176d8ddba77d20a5e22d7a622",
    severityBand: TOHOKU_2011_DEMO_EARTHQUAKE.severityBand as 3,
    affectedCellCount: TOHOKU_2011_DEMO_EARTHQUAKE.affectedCellCount,
    // cellSource: 実体は STEP 5 で生成する静的アセット
    cellSource: {
        kind: "static-asset",
        path: "/demo/tohoku-2011-affected-cells.json",
    },
    // affectedCellsRoot: nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/unsigned_payload.json 由来
    // 表示・受け渡し用に持つだけで検証ロジックは作らない。
    affectedCellsRoot:
        "0xa1aec0d65af57c5e5df7d22bede61fa5fdbe41580d412114acec7866b533359c",
};

// ---------------------------------------------------------------------------
// 学生支援基金プログラム
// ---------------------------------------------------------------------------

const STUDENT_FUND_PROGRAM: ClaimableProgram = {
    id: "student-fund-2025",
    category: "student-fund",
    title: "緊急学生支援基金 2025",
    scope: "国内在籍の大学・大学院・専門学校生（所得制限あり）",
    amountSummary: {
        // 金額は表示用デモ値（固定給付）
        kind: "fixed",
        usdc: 500,
    },
    // 締切は表示用デモ値（2025-09-30 23:59:59 JST）
    deadlineMs: "1759294799000",
    detailHref: "/demo/claim/student-fund-2025",
};

// ---------------------------------------------------------------------------
// 医療・難病支援プログラム
// ---------------------------------------------------------------------------

const MEDICAL_PROGRAM: ClaimableProgram = {
    id: "medical-support-2025",
    category: "medical",
    title: "医療・難病支援プログラム 2025",
    scope: "指定難病または長期療養中の患者（診断書提出必須）",
    amountSummary: {
        // 金額は表示用デモ値（固定給付）
        kind: "fixed",
        usdc: 300,
    },
    // 締切は表示用デモ値（2025-12-31 23:59:59 JST）
    deadlineMs: "1767214799000",
    detailHref: "/demo/claim/medical-support-2025",
};

// ---------------------------------------------------------------------------
// エクスポート: デモカタログ一覧
// ---------------------------------------------------------------------------

/**
 * デモ画面が参照する固定カタログ。
 * 3カテゴリ（disaster / student-fund / medical）を含む。
 * 本番ではこの配列をオンチェーンデータ取得に置き換える予定。
 */
export const DEMO_CLAIMABLE_PROGRAMS: readonly ClaimableProgram[] = [
    TOHOKU_2011_PROGRAM,
    STUDENT_FUND_PROGRAM,
    MEDICAL_PROGRAM,
] as const;
