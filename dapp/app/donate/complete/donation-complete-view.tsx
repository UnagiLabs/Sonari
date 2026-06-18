"use client";

// ---------------------------------------------------------------------------
// DonationCompleteView — 寄付完了画面（要約＋領収書発行フォーム）
//
// 送金成功後に表示する。tx 要約（受領金額・寄付先・digest）と、領収書の宛名入力＋
// 匿名トグルを持つ。「領収書を発行する」で領収書ビューへ切り替える（onIssueReceipt）。
// ページ chrome（背景・topbar・main）は呼び出し側が用意するため、ここでは中身だけ返す。
// ---------------------------------------------------------------------------

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { SonariLocale } from "../../register/wizard/locale";

export interface DonationCompleteViewProps {
    readonly amountLabel: string;
    readonly destinationLabel: string;
    readonly digest: string;
    readonly explorerUrl: string | null;
    readonly donorName: string;
    readonly anonymous: boolean;
    readonly onDonorNameChange: (value: string) => void;
    readonly onAnonymousChange: (value: boolean) => void;
    readonly onIssueReceipt: () => void;
    readonly locale: SonariLocale;
}

export function DonationCompleteView({
    amountLabel,
    destinationLabel,
    digest,
    explorerUrl,
    donorName,
    anonymous,
    onDonorNameChange,
    onAnonymousChange,
    onIssueReceipt,
    locale: _locale,
}: DonationCompleteViewProps) {
    const t = useTranslations("donate.complete");
    // 非匿名で宛名未入力のときは発行不可。
    const isIssueDisabled = !anonymous && donorName.trim() === "";

    return (
        <section className="donation-complete" aria-labelledby="donation-complete-title">
            <div className="donation-complete-check" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="34" height="34">
                    <title>{t("eyebrow")}</title>
                    <path
                        d="M5 12.5 l4.2 4.2 L19 7"
                        fill="none"
                        stroke="var(--sage-700)"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </div>

            <header className="donation-complete-head">
                <div className="eyebrow">{t("eyebrow")}</div>
                <h1 id="donation-complete-title">{t("title")}</h1>
                <p className="faint">{t("body")}</p>
            </header>

            <div className="donation-complete-card">
                <dl className="donation-complete-summary">
                    <div className="donation-complete-summary-row">
                        <dt>{t("amountLabel")}</dt>
                        <dd className="donation-complete-amount">
                            <strong>{amountLabel}</strong>
                            <span>USDC</span>
                        </dd>
                    </div>
                    <div className="donation-complete-summary-row">
                        <dt>{t("destinationLabel")}</dt>
                        <dd>
                            <strong>{destinationLabel}</strong>
                        </dd>
                    </div>
                    <div className="donation-complete-summary-digest">
                        <dt>{t("txDigestLabel")}</dt>
                        <dd className="mono">{digest}</dd>
                        {explorerUrl !== null ? (
                            <a
                                className="text-action"
                                href={explorerUrl}
                                rel="noopener noreferrer"
                                target="_blank"
                            >
                                {t("explorerLink")}
                            </a>
                        ) : null}
                    </div>
                </dl>
            </div>

            <div className="donation-complete-card">
                <div className="donation-complete-issue-head">
                    <h2>{t("issueTitle")}</h2>
                    <p className="faint">{t("issueBody")}</p>
                </div>

                <label className="donation-complete-field" htmlFor="receipt-donor-name">
                    <span className="donation-complete-field-label">{t("nameLabel")}</span>
                    <input
                        id="receipt-donor-name"
                        name="receiptDonorName"
                        type="text"
                        autoComplete="name"
                        disabled={anonymous}
                        placeholder={t("namePlaceholder")}
                        value={donorName}
                        onChange={(event) => onDonorNameChange(event.target.value)}
                    />
                </label>

                <label className="donation-complete-anonymous">
                    <input
                        type="checkbox"
                        name="receiptAnonymous"
                        checked={anonymous}
                        onChange={(event) => onAnonymousChange(event.target.checked)}
                    />
                    <span>
                        <strong>{t("anonymous")}</strong>
                        <small>{t("anonymousHint")}</small>
                    </span>
                </label>

                <button
                    className="btn btn-primary btn-lg donation-complete-issue-button"
                    disabled={isIssueDisabled}
                    onClick={onIssueReceipt}
                    type="button"
                >
                    {t("issueButton")}
                </button>
                <p className="faint donation-complete-print-hint">{t("printHint")}</p>
            </div>

            <footer className="donation-complete-footer">
                <Link className="text-action" href="/dashboard">
                    {t("viewDashboard")}
                </Link>
                <Link className="text-action" href="/">
                    {t("backHome")}
                </Link>
            </footer>
        </section>
    );
}
