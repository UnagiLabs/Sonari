"use client";

import { useTranslations } from "next-intl";
import { SiteTopbar } from "../i18n/site-topbar";
import type { SonariLocale } from "../register/wizard/locale";
import { WalletConnect } from "../wallet/wallet-connect";

// モックの金額・残高などのデータは翻訳対象外なので定数のまま保持する。
const donationTypeIds = ["general", "earthquake"] as const;
const poolOptions = [
    { id: "main-pool", key: "main", balance: "$1.28M", defaultChecked: true },
    { id: "earthquake-pool", key: "earthquake", balance: "$642K", defaultChecked: false },
] as const;
const splitPreview = [
    { key: "main", value: "$80.00" },
    { key: "relief", value: "$320.00" },
] as const;
const resultPreviewKeys = ["donationRecord", "donorPass", "receipt", "leaderboard"] as const;
const quickAmounts = ["$50", "$100", "$250", "$1,000"] as const;

export function DonateView({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("donate");

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="donate" locale={locale} showWallet />

                <main className="page donate-page">
                    <header className="donate-hero">
                        <div>
                            <div className="eyebrow">{t("hero.eyebrow")}</div>
                            <h1>{t("hero.title")}</h1>
                            <p className="muted donate-sub">{t("hero.sub")}</p>
                        </div>
                        <div className="donate-wallet-panel">
                            <span className="tag tag-neutral">{t("hero.walletTag")}</span>
                            <p>{t("hero.walletBody")}</p>
                            <WalletConnect />
                        </div>
                    </header>

                    <section className="donate-layout" aria-label={t("form.title")}>
                        <form className="donate-form" aria-labelledby="donation-form-title">
                            <div className="form-heading">
                                <div>
                                    <div className="eyebrow">{t("form.eyebrow")}</div>
                                    <h2 id="donation-form-title">{t("form.title")}</h2>
                                </div>
                                <span className="tag tag-ok tag-dot">USDC</span>
                            </div>

                            <fieldset className="control-group">
                                <legend>{t("form.typeLegend")}</legend>
                                <div className="choice-grid">
                                    {donationTypeIds.map((id) => (
                                        <label className="choice-option" key={id}>
                                            <input
                                                defaultChecked={id === "general"}
                                                name="donationType"
                                                type="radio"
                                                value={id}
                                            />
                                            <span>
                                                <strong>{t(`types.${id}.label`)}</strong>
                                                <small>{t(`types.${id}.description`)}</small>
                                                <em>{t(`types.${id}.destination`)}</em>
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </fieldset>

                            <fieldset className="control-group">
                                <legend>{t("form.poolLegend")}</legend>
                                <div className="pool-select-list">
                                    {poolOptions.map((pool) => (
                                        <label className="pool-select-option" key={pool.id}>
                                            <input
                                                defaultChecked={pool.defaultChecked}
                                                name="pool"
                                                type="radio"
                                                value={pool.id}
                                            />
                                            <span>
                                                <strong>{t(`pools.${pool.key}.label`)}</strong>
                                                <small>{t(`pools.${pool.key}.detail`)}</small>
                                            </span>
                                            <b>{pool.balance}</b>
                                        </label>
                                    ))}
                                </div>
                            </fieldset>

                            <div className="amount-field">
                                <label htmlFor="donation-amount">{t("form.amountLabel")}</label>
                                <div className="amount-input-wrap">
                                    <input
                                        defaultValue="400"
                                        id="donation-amount"
                                        inputMode="decimal"
                                        name="amount"
                                        type="text"
                                    />
                                    <span>USDC</span>
                                </div>
                                <div className="quick-amounts">
                                    {quickAmounts.map((amount) => (
                                        <button key={amount} type="button">
                                            {amount}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <fieldset className="control-group">
                                <legend>{t("form.displayLegend")}</legend>
                                <div className="toggle-list">
                                    <label className="toggle-row">
                                        <span>
                                            <strong>{t("display.publicName.title")}</strong>
                                            <small>{t("display.publicName.description")}</small>
                                        </span>
                                        <input
                                            defaultChecked
                                            name="publicDisplay"
                                            type="checkbox"
                                        />
                                    </label>
                                    <label className="toggle-row">
                                        <span>
                                            <strong>{t("display.anonymous.title")}</strong>
                                            <small>{t("display.anonymous.description")}</small>
                                        </span>
                                        <input name="anonymous" type="checkbox" />
                                    </label>
                                    <label className="toggle-row">
                                        <span>
                                            <strong>{t("display.corporate.title")}</strong>
                                            <small>{t("display.corporate.description")}</small>
                                        </span>
                                        <input name="corporateMode" type="checkbox" />
                                    </label>
                                </div>
                            </fieldset>

                            <div className="form-actions">
                                <button className="btn btn-primary btn-lg" type="button">
                                    {t("form.donatePreview")}
                                </button>
                                <button className="btn btn-secondary btn-lg" type="button">
                                    {t("form.saveDraft")}
                                </button>
                            </div>
                        </form>

                        <aside className="donate-side" aria-label={t("split.title")}>
                            <section className="preview-block">
                                <div className="panel-header compact">
                                    <div>
                                        <div className="eyebrow">{t("split.eyebrow")}</div>
                                        <h2>{t("split.title")}</h2>
                                    </div>
                                    <span className="stat-num">$400</span>
                                </div>
                                <div className="split-list">
                                    {splitPreview.map((row) => (
                                        <div className="split-row" key={row.key}>
                                            <div>
                                                <strong>{t(`split.${row.key}.label`)}</strong>
                                                <small>{t(`split.${row.key}.detail`)}</small>
                                            </div>
                                            <span>{row.value}</span>
                                        </div>
                                    ))}
                                </div>
                            </section>

                            <section className="preview-block">
                                <div className="panel-header compact">
                                    <div>
                                        <div className="eyebrow">{t("result.eyebrow")}</div>
                                        <h2>{t("result.title")}</h2>
                                    </div>
                                </div>
                                <div className="result-list">
                                    {resultPreviewKeys.map((key) => (
                                        <div className="result-row" key={key}>
                                            <span className="result-dot" />
                                            <div>
                                                <strong>{t(`result.${key}.label`)}</strong>
                                                <small>{t(`result.${key}.value`)}</small>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </section>

                            <section className="donate-note">
                                <h3>{t("note.title")}</h3>
                                <p>{t("note.body")}</p>
                                <a className="text-action" href="/dashboard">
                                    {t("note.link")}
                                </a>
                            </section>
                        </aside>
                    </section>
                </main>
            </div>
        </>
    );
}
