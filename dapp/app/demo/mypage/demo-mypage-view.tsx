"use client";

import { DEMO_AFFECTED_HOME_CELL_BAND3 } from "../../claim/catalog/demo-catalog";
import type { MembershipPassData } from "../../mypage/membership-pass-read";
import { MypageView } from "../../mypage/mypage-view";
import type { SonariLocale } from "../../register/wizard/locale";
import { TOHOKU_2011_DEMO_EARTHQUAKE } from "../_data/tohoku-2011";

/**
 * デモ用の My Page ビュー。
 *
 * 本番 MypageView をそのまま再利用し、登録済みの会員証（MembershipPass）を固定で
 * 注入する。demo を渡すと MypageView はチェーンを読まず、この固定 pass を ready
 * 状態として表示する（表示専用）。これにより、ウォレット接続や登録が無くても
 * 「救済を受け取る」入口を含む登録済み画面を確認できる。
 *
 * 値は東日本大震災(2011) のデモ世界観に合わせた固定値。homeCell は実被災セット内の
 * セル（DEMO_AFFECTED_HOME_CELL_BAND3）を使い、地図に自宅セルが被災エリア内として
 * 強調される。地図 API key が無い環境ではセル値のテキストにフォールバックする。
 */
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const DEMO_PASS: MembershipPassData = {
    objectId: "0xdemo000000000000000000000000000000000000000000000000000000000001",
    passLineageId: "0xdemo000000000000000000000000000000000000000000000000000000000002",
    status: 1, // active
    issuedAtMs: TOHOKU_2011_DEMO_EARTHQUAKE.occurredAtMs,
    homeCell: DEMO_AFFECTED_HOME_CELL_BAND3,
    homeCellRegisteredAtMs: TOHOKU_2011_DEMO_EARTHQUAKE.occurredAtMs,
    identityVerified: true,
    identityProviderMask: 3, // KYC + World ID
    identityVerifiedAtMs: TOHOKU_2011_DEMO_EARTHQUAKE.occurredAtMs,
    identityExpiresAtMs: TOHOKU_2011_DEMO_EARTHQUAKE.occurredAtMs + ONE_YEAR_MS,
};

export function DemoMypageView({ locale }: { readonly locale: SonariLocale }) {
    return <MypageView locale={locale} demo={{ pass: DEMO_PASS }} />;
}
