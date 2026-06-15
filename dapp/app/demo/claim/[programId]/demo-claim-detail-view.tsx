"use client";

// ---------------------------------------------------------------------------
// DemoClaimDetailView – /demo/claim/[programId] 詳細ビュー
//
// selectDemoProgramById で対象プログラムを1件引き、カテゴリで表示を出し分ける。
// - disaster: AffectedAreaMap で東日本大震災の実セルを本物のバンド色＋
//   デモ居住セル中心で表示＋概要 dl。
// - student-fund / medical（非 disaster）: 地図なし。対象条件・金額・締切・
//   表示専用申請ボタン。
// - 未知 programId: not-found テキスト表示（Next の notFound() は使わない）。
//
// 設計方針:
// - チェーン読込・ウォレット接続に依存しない（表示専用）。
// - isDisasterProgram で型 narrowing してから cellSource 等にアクセスする（型安全）。
// - 地図には program.cellSource をそのまま渡す（resolvePreviewCellSource は使わない）。
//   これにより本物のバンド色が出る。
// - residenceCell には DEMO_AFFECTED_HOME_CELL_BAND3 を渡し、
//   デモ居住セルが被災エリア内として強調される。
// ---------------------------------------------------------------------------

import { useTranslations } from "next-intl";
import { AffectedAreaMap } from "../../../claim/affected-area/affected-area-map";
import { buildClaimListCard } from "../../../claim/catalog/claim-list-card";
import { isDisasterProgram } from "../../../claim/catalog/claimable-program";
import {
    DEMO_CLAIMABLE_PROGRAMS,
    DEMO_RESIDENCE_HOME_CELL,
} from "../../../claim/catalog/demo-catalog";
import { selectDemoProgramById } from "../../../claim/catalog/select-demo-program";
import { SiteTopbar } from "../../../i18n/site-topbar";
import type { SonariLocale } from "../../../register/wizard/locale";

// ---------------------------------------------------------------------------
// DemoClaimDetailView
// ---------------------------------------------------------------------------

export function DemoClaimDetailView({
    locale,
    programId,
}: {
    readonly locale: SonariLocale;
    readonly programId: string;
}) {
    // デモ専用ラベル（backToList / mapNote / eligibilityLabel / applyButton / displayOnlyNote）
    const tDemo = useTranslations("demo.claim");
    // 詳細ページ共通ラベル（notFoundTitle / notFoundBody / mapTitle / summary*）
    const tDetail = useTranslations("claim.detail");
    // カードラベル（amountLabel / amount / deadlineLabel / deadline）
    const tList = useTranslations("claim.list");

    const program = selectDemoProgramById(DEMO_CLAIMABLE_PROGRAMS, programId);

    // not-found: programId が不明なとき
    if (program === null) {
        return (
            <>
                <div className="watercolor-bg" />
                <div className="app">
                    <SiteTopbar active="claim" locale={locale} />
                    <main className="page claim-page">
                        <div className="claim-not-found">
                            <h1>{tDetail("notFoundTitle")}</h1>
                            <p>{tDetail("notFoundBody")}</p>
                            <a className="btn btn-secondary" href="/demo/claim">
                                {tDemo("detail.backToList")}
                            </a>
                        </div>
                    </main>
                </div>
            </>
        );
    }

    // 表示用の整形済みデータ（amountText / deadlineText）
    const card = buildClaimListCard(program);

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="claim" locale={locale} />

                <main className="page claim-page">
                    {/* 詳細ページ共通ヘッダ */}
                    <section
                        className="claim-event-panel"
                        aria-labelledby="demo-claim-detail-title"
                    >
                        <div className="form-heading">
                            <div>
                                <h2 id="demo-claim-detail-title">{program.title}</h2>
                            </div>
                            <a className="text-action" href="/demo/claim">
                                {tDemo("detail.backToList")}
                            </a>
                        </div>

                        {/* 災害カテゴリ: 概要 dl（地図メタ含む） */}
                        {isDisasterProgram(program) ? (
                            <dl className="pass-grid">
                                <div>
                                    <dt>{tDetail("summaryRegion")}</dt>
                                    <dd>{program.scope}</dd>
                                </div>
                                <div>
                                    <dt>{tDetail("summaryBand")}</dt>
                                    <dd>Band {program.severityBand}</dd>
                                </div>
                                <div>
                                    <dt>{tDetail("summaryAffectedCells")}</dt>
                                    <dd>{program.affectedCellCount}</dd>
                                </div>
                                <div>
                                    <dt>{tDetail("summaryDeadline")}</dt>
                                    <dd>{card.deadlineText}</dd>
                                </div>
                            </dl>
                        ) : (
                            /* 非災害カテゴリ: 対象条件・金額・締切 */
                            <dl className="pass-grid">
                                <div>
                                    <dt>{tDemo("detail.eligibilityLabel")}</dt>
                                    <dd>{program.scope}</dd>
                                </div>
                                <div>
                                    <dt>{tList("amountLabel")}</dt>
                                    <dd>{tList("amount", { amount: card.amountText })}</dd>
                                </div>
                                <div>
                                    <dt>{tList("deadlineLabel")}</dt>
                                    <dd>{tList("deadline", { date: card.deadlineText })}</dd>
                                </div>
                            </dl>
                        )}
                    </section>

                    {/* 災害カテゴリ: 被災エリア地図セクション */}
                    {isDisasterProgram(program) ? (
                        <section
                            className="claim-map-section"
                            aria-labelledby="demo-map-section-title"
                        >
                            <div className="panel-header">
                                <div>
                                    <h2 id="demo-map-section-title">{tDetail("mapTitle")}</h2>
                                </div>
                            </div>
                            {/* mapNote: 東日本大震災の実データ表示であることを注記 */}
                            <p className="muted claim-sub">{tDemo("detail.mapNote")}</p>
                            {/*
                             * cellSource: program.cellSource をそのまま渡す。
                             * resolvePreviewCellSource は使わない → 本物のバンド色が出る。
                             * residenceCell: DEMO_RESIDENCE_HOME_CELL（仙台付近・band2・陸地）。
                             * → 地図が陸地（市街地）を中心に表示され、自宅セルが強調される。
                             */}
                            <AffectedAreaMap
                                cellSource={program.cellSource}
                                residenceCell={DEMO_RESIDENCE_HOME_CELL}
                            />
                        </section>
                    ) : null}

                    {/* 申請ボタン（全カテゴリ共通・表示専用）。災害も学生/医療も同じ導線を出す。 */}
                    <section className="claim-layout" aria-label={program.title}>
                        <div className="claim-main">
                            <section className="claim-summary-panel">
                                <div className="claim-action-list">
                                    {/* 申請ボタン: disabled の表示専用。押下しても何もしない。 */}
                                    <button
                                        className="btn btn-primary btn-lg"
                                        disabled
                                        type="button"
                                    >
                                        {tDemo("detail.applyButton")}
                                    </button>
                                </div>
                                {/* 表示専用注記 */}
                                <p className="muted claim-sub">{tDemo("detail.displayOnlyNote")}</p>
                            </section>
                        </div>
                    </section>
                </main>
            </div>
        </>
    );
}
