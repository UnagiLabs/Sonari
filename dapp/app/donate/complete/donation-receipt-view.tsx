"use client";

// ---------------------------------------------------------------------------
// DonationReceiptView — 印刷可能なオンチェーン寄付領収書（証明書）
//
// 完了画面で入力した宛名・匿名設定と tx コンテキストから領収書を描画する。
// `Sonari Receipt.html` モックの二重フレーム証明書レイアウトを移植。操作バー・背景は
// .no-print で印刷対象外。領収書カードのみ A4 縦 1 ページに収まる（globals.css の @media print）。
// ---------------------------------------------------------------------------

import { useTranslations } from "next-intl";
import { QRCodeSVG } from "qrcode.react";
import { formatDate } from "../../i18n/format";
import type { SonariLocale } from "../../register/wizard/locale";
import type { WalletNetwork } from "../../wallet/wallet-network";
import { receiptNumber } from "./receipt-number";

// QR / シールの濃色は sage-900 相当の固定 hex（印刷・QR コントラスト確保のため）。
const SEAL_DARK = "#23302a";

export interface DonationReceiptViewProps {
    readonly amountLabel: string;
    readonly destinationLabel: string;
    readonly network: WalletNetwork;
    readonly digest: string;
    readonly explorerUrl: string | null;
    readonly donorPassId: string | null;
    readonly receivedAtMs: number | null;
    /** 宛名。null は匿名（領収書には「匿名の寄付者」と記載）。 */
    readonly donorName: string | null;
    readonly onBack: () => void;
    readonly locale: SonariLocale;
}

export function DonationReceiptView({
    amountLabel,
    destinationLabel,
    network,
    digest,
    explorerUrl,
    donorPassId,
    receivedAtMs,
    donorName,
    onBack,
    locale,
}: DonationReceiptViewProps) {
    const t = useTranslations("donate.receipt");
    const receivedLabel = formatDate(receivedAtMs ?? 0, locale) ?? "—";
    const donorLabel = donorName ?? t("anonymous");
    const qrValue = explorerUrl ?? digest;

    function handlePrint() {
        window.print();
    }

    return (
        <div className="receipt-stage">
            <div className="receipt-actions no-print">
                <button className="btn btn-secondary" onClick={onBack} type="button">
                    {t("back")}
                </button>
                <span className="receipt-actions-spacer" />
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
                <button className="btn btn-secondary" onClick={handlePrint} type="button">
                    {t("savePdf")}
                </button>
                <button className="btn btn-primary" onClick={handlePrint} type="button">
                    {t("print")}
                </button>
            </div>

            <article className="receipt-card">
                <div className="receipt-frame">
                    <span className="receipt-corner receipt-corner-tl" aria-hidden="true" />
                    <span className="receipt-corner receipt-corner-tr" aria-hidden="true" />
                    <span className="receipt-corner receipt-corner-bl" aria-hidden="true" />
                    <span className="receipt-corner receipt-corner-br" aria-hidden="true" />

                    <header className="receipt-head">
                        <div className="receipt-brand">
                            <span className="receipt-logo" aria-hidden="true">
                                S
                            </span>
                            <span className="receipt-brand-text">
                                <span className="receipt-brand-name">Sonari</span>
                                <span className="receipt-brand-tagline">{t("brandTagline")}</span>
                            </span>
                        </div>
                        <div className="receipt-head-right">
                            <span className="receipt-head-kicker">
                                {t("heading")} · {t("headingEn")}
                            </span>
                            <span className="receipt-head-no mono">
                                {t("numberLabel")} {receiptNumber(digest, receivedAtMs)}
                            </span>
                        </div>
                    </header>

                    <div className="receipt-amount-block">
                        <div className="receipt-amount-label">{t("amountLabel")}</div>
                        <div className="receipt-amount">
                            {amountLabel} <span className="receipt-amount-unit">USDC</span>
                        </div>
                        <p className="receipt-certify">{t("certify")}</p>
                    </div>

                    <div className="receipt-grid">
                        <div className="receipt-grid-cell">
                            <div className="receipt-grid-label">{t("received")}</div>
                            <div className="receipt-grid-value">{receivedLabel}</div>
                        </div>
                        <div className="receipt-grid-cell">
                            <div className="receipt-grid-label">{t("destination")}</div>
                            <div className="receipt-grid-value">{destinationLabel}</div>
                        </div>
                        <div className="receipt-grid-cell">
                            <div className="receipt-grid-label">{t("networkLabel")}</div>
                            <div className="receipt-grid-value">{t(`network.${network}`)}</div>
                        </div>
                        <div className="receipt-grid-cell">
                            <div className="receipt-grid-label">{t("donor")}</div>
                            <div className="receipt-grid-value">{donorLabel}</div>
                        </div>
                    </div>

                    <div className="receipt-verify">
                        <div className="receipt-verify-main">
                            <div>
                                <div className="receipt-grid-label">{t("txDigest")}</div>
                                <div className="receipt-digest mono">{digest}</div>
                            </div>
                            {donorPassId !== null ? (
                                <div className="receipt-objects">
                                    <span className="receipt-grid-label">
                                        {t("donorPassLabel")}
                                    </span>
                                    <span className="receipt-object-id mono">{donorPassId}</span>
                                </div>
                            ) : null}
                        </div>

                        <div className="receipt-qr">
                            <div className="receipt-qr-frame">
                                <QRCodeSVG
                                    value={qrValue}
                                    size={120}
                                    bgColor="#ffffff"
                                    fgColor={SEAL_DARK}
                                    marginSize={0}
                                />
                            </div>
                            <span className="receipt-qr-hint">{t("scanHint")}</span>
                        </div>
                    </div>

                    <footer className="receipt-footer">
                        <p className="receipt-disclaimer">{t("disclaimer")}</p>
                        <svg
                            className="receipt-seal"
                            viewBox="0 0 120 120"
                            width="96"
                            height="96"
                            aria-hidden="true"
                        >
                            <title>{t("verifiedSeal")}</title>
                            <defs>
                                <path
                                    id="receiptSealArc"
                                    d="M60,60 m-44,0 a44,44 0 1,1 88,0 a44,44 0 1,1 -88,0"
                                />
                            </defs>
                            <circle
                                cx="60"
                                cy="60"
                                r="56"
                                fill="none"
                                stroke="var(--sage-300)"
                                strokeWidth="1"
                            />
                            <circle
                                cx="60"
                                cy="60"
                                r="46"
                                fill="none"
                                stroke="var(--sage-200)"
                                strokeWidth="1"
                            />
                            <text
                                fontFamily="var(--font-mono)"
                                fontSize="8.4"
                                fill="var(--sage-600)"
                            >
                                <textPath href="#receiptSealArc" startOffset="2%">
                                    {t("verifiedSeal")}
                                </textPath>
                            </text>
                            <path
                                d="M47,61 l8,8 l18,-20"
                                fill="none"
                                stroke="var(--sage-700)"
                                strokeWidth="3.4"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    </footer>
                </div>
            </article>
        </div>
    );
}
