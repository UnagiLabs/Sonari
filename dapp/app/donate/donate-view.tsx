"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import {
    GENESIS_OBJECT_KIND,
    readGenesisObjectIds,
    selectGenesisObjectId,
} from "../chain/genesis-objects";
import { LoadingIndicator } from "../components/loading-indicator";
import { formatAmount } from "../i18n/format";
import { SiteTopbar } from "../i18n/site-topbar";
import type { SonariLocale } from "../register/wizard/locale";
import { dAppKit } from "../wallet/dapp-kit";
import { WalletConnect } from "../wallet/wallet-connect";
import { readWalletNetwork, resolveGrpcBaseUrl } from "../wallet/wallet-network";
import { executeWalletTransaction } from "../wallet/wallet-transaction-adapter";
import { validateDonationAmount } from "./donate-amount";
import { combineDonateConfig, type DonateConfig, readDonateEnvConfig } from "./donate-config";
import { readDonateDestinations } from "./donate-destinations";
import { buildDonateTransaction, type DonateDestinationInput } from "./donate-transaction";
import {
    buildDonateSplitRows,
    buildDonateTxResultView,
    type DonateDestinationMode,
    type DonateDestinationReadState,
    type DonateSubmitDisabledReason,
    type DonateTxState,
    resolveDonateSubmitDisabledReason,
} from "./donate-view-state";

const QUICK_AMOUNTS = ["$50", "$100", "$250", "$1,000"] as const;
const DEFAULT_DONATION_AMOUNT = "400";

export function DonateView({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("donate");
    const account = useCurrentAccount();
    const network = readWalletNetwork();
    // env から読むのは packageID だけ。pause_state / pool は packageID 起点で導出する。
    const envConfig = useMemo(() => readDonateEnvConfig(), []);
    const fundingPackageId = envConfig.kind === "ok" ? envConfig.config.fundingPackageId : null;
    const [config, setConfig] = useState<DonateConfig | null>(null);

    const [destinationState, setDestinationState] = useState<DonateDestinationReadState>({
        status: "idle",
        campaigns: [],
        categories: [],
        errorMessage: null,
    });
    const [mode, setMode] = useState<DonateDestinationMode>("general");
    const [campaignId, setCampaignId] = useState("");
    const [categoryPoolId, setCategoryPoolId] = useState("");
    const [amountInput, setAmountInput] = useState(DEFAULT_DONATION_AMOUNT);
    const [txState, setTxState] = useState<DonateTxState>({ status: "idle" });

    const amountValidation = useMemo(() => validateDonationAmount(amountInput), [amountInput]);
    const isWalletConnected = account !== null;

    // packageID から pause_state / pool を導出して完全な設定を組み立てる。
    // 失敗の詳細は開発者向けに console へ出し、画面には設定不備の汎用文言を出す。
    useEffect(() => {
        if (fundingPackageId === null) {
            console.error(
                "donate config failed: NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID is required.",
            );
            setConfig(null);
            return;
        }

        const client = new SuiJsonRpcClient({ network, url: resolveGrpcBaseUrl(network) });
        let cancelled = false;
        setConfig(null);

        void (async () => {
            const genesis = await readGenesisObjectIds(client, { packageId: fundingPackageId });
            if (cancelled) {
                return;
            }
            if (genesis.kind === "error") {
                console.error(`donate config failed: ${genesis.message}`);
                setConfig(null);
                return;
            }

            const donationPauseStateId = selectGenesisObjectId(
                genesis.ids,
                GENESIS_OBJECT_KIND.pauseState,
            );
            const mainPoolId = selectGenesisObjectId(genesis.ids, GENESIS_OBJECT_KIND.mainPool);
            const operationsPoolId = selectGenesisObjectId(
                genesis.ids,
                GENESIS_OBJECT_KIND.operationsPool,
            );
            const donorRegistryId = selectGenesisObjectId(
                genesis.ids,
                GENESIS_OBJECT_KIND.donorRegistry,
            );
            if (
                donationPauseStateId === null ||
                donorRegistryId === null ||
                mainPoolId === null ||
                operationsPoolId === null
            ) {
                console.error(
                    "donate config failed: genesis objects for pause/donor registry/main/operations were not found.",
                );
                setConfig(null);
                return;
            }

            setConfig(
                combineDonateConfig(
                    { fundingPackageId },
                    { donationPauseStateId, donorRegistryId, mainPoolId, operationsPoolId },
                    network,
                ),
            );
        })();

        return () => {
            cancelled = true;
        };
    }, [fundingPackageId, network]);

    useEffect(() => {
        if (fundingPackageId === null) {
            setDestinationState({
                status: "ready",
                campaigns: [],
                categories: [],
                errorMessage: null,
            });
            return;
        }

        const client = new SuiJsonRpcClient({ network, url: resolveGrpcBaseUrl(network) });
        let cancelled = false;
        setDestinationState({
            status: "loading",
            campaigns: [],
            categories: [],
            errorMessage: null,
        });

        void (async () => {
            try {
                const result = await readDonateDestinations(client, {
                    packageId: fundingPackageId,
                });

                if (cancelled) {
                    return;
                }

                if (result.kind === "ok") {
                    setDestinationState({
                        status: "ready",
                        campaigns: result.campaigns,
                        categories: result.categories,
                        errorMessage: null,
                    });
                    return;
                }

                setDestinationState({
                    status: "error",
                    campaigns: [],
                    categories: [],
                    errorMessage: result.message,
                });
            } catch (error) {
                if (cancelled) {
                    return;
                }
                const message =
                    error instanceof Error
                        ? error.message
                        : "Failed to load donation destinations.";
                setDestinationState({
                    status: "error",
                    campaigns: [],
                    categories: [],
                    errorMessage: message,
                });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [fundingPackageId, network]);

    useEffect(() => {
        if (destinationState.status !== "ready") {
            return;
        }

        if (mode === "campaign") {
            const hasSelected = destinationState.campaigns.some(
                (campaign) => campaign.id === campaignId,
            );
            if (!hasSelected) {
                setCampaignId(destinationState.campaigns[0]?.id ?? "");
            }
            return;
        }

        if (mode === "category") {
            const hasSelected = destinationState.categories.some(
                (category) => category.id === categoryPoolId,
            );
            if (!hasSelected) {
                setCategoryPoolId(destinationState.categories[0]?.id ?? "");
            }
        }
    }, [destinationState, mode, campaignId, categoryPoolId]);

    const disabledReason = resolveDonateSubmitDisabledReason({
        configReady: config !== null,
        walletConnected: isWalletConnected,
        amountValidation,
        selectedMode: mode,
        destinationState,
        selectedCampaignId: campaignId,
        selectedCategoryPoolId: categoryPoolId,
    });

    const resultView = buildDonateTxResultView(txState, network);
    const destination = useMemo<DonateDestinationInput>(() => {
        if (mode === "campaign") {
            return { kind: "campaign", campaignId };
        }
        if (mode === "category") {
            return { kind: "category", categoryPoolId };
        }
        return { kind: "general" };
    }, [campaignId, categoryPoolId, mode]);

    const isDonateInFlight = txState.status === "building" || txState.status === "submitting";
    const isSubmitDisabled = disabledReason !== null || isDonateInFlight;

    const statusClass =
        txState.status === "failed"
            ? "submit-status submit-status-failed"
            : txState.status === "submitted"
              ? "submit-status submit-status-success"
              : isDonateInFlight
                ? "submit-status submit-status-submitting"
                : "submit-status";

    const selectedAmountLabel = useMemo(() => {
        if (!amountValidation.ok) {
            return `$${amountInput.trim().replace(/,/g, "")}`;
        }

        const normalized = amountInput.trim().replace(/\$/g, "").replace(/,/g, "");
        const amount = Number(normalized);
        if (Number.isFinite(amount)) {
            return `$${formatAmount(amount, locale, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
        }

        return `$${normalized}`;
    }, [amountValidation.ok, amountInput, locale]);

    const splitRows = useMemo(
        () =>
            buildDonateSplitRows({
                mode,
                campaignLabel:
                    destinationState.campaigns.find((campaign) => campaign.id === campaignId)
                        ?.label ?? t("types.campaign.label"),
                categoryLabel:
                    destinationState.categories.find((category) => category.id === categoryPoolId)
                        ?.label ?? t("types.category.label"),
                t,
            }),
        [
            campaignId,
            categoryPoolId,
            destinationState.campaigns,
            destinationState.categories,
            mode,
            t,
        ],
    );

    const txMessage = () => {
        if (txState.status === "failed") {
            return t("tx.failed.message");
        }
        if (disabledReason !== null) {
            return formatSubmitDisabledReason(t, disabledReason, destinationState.errorMessage);
        }

        switch (txState.status) {
            case "idle":
                return t("tx.idle.message");
            case "building":
                return t("tx.building.message");
            case "submitting":
                return t("tx.submitting.message");
            case "submitted":
                return t("tx.submitted.message");
        }
    };

    const txDetail = () => {
        if (txState.status === "submitted") {
            return t("tx.submitted.detail", { digest: txState.digest });
        }
        if (txState.status === "failed") {
            return txState.message;
        }
        if (disabledReason !== null) {
            return formatSubmitDisabledReason(t, disabledReason, destinationState.errorMessage);
        }
        if (txState.status === "building") {
            return t("tx.building.detail");
        }
        if (txState.status === "submitting") {
            return t("tx.submitting.detail");
        }
        return t("tx.idle.detail");
    };

    function normalizeAmount(value: string): string {
        return value.replace(/\$/g, "").replace(/,/g, "").trim();
    }

    function handleQuickAmount(value: string) {
        setAmountInput(normalizeAmount(value));
        setTxState({ status: "idle" });
    }

    function handleAmountChange(value: string) {
        setAmountInput(value);
        setTxState({ status: "idle" });
    }

    function handleModeChange(nextMode: DonateDestinationMode) {
        setMode(nextMode);
        setTxState({ status: "idle" });
    }

    function handleCampaignChange(nextCampaignId: string) {
        setCampaignId(nextCampaignId);
        setTxState({ status: "idle" });
    }

    function handleCategoryChange(nextCategoryPoolId: string) {
        setCategoryPoolId(nextCategoryPoolId);
        setTxState({ status: "idle" });
    }

    async function handleSubmit() {
        if (disabledReason !== null || isDonateInFlight || config === null) {
            return;
        }
        if (account === null || !amountValidation.ok) {
            setTxState({
                status: "failed",
                message: txMessage(),
            });
            return;
        }

        setTxState({ status: "building" });
        try {
            const { transaction } = buildDonateTransaction({
                senderAddress: account.address,
                packageId: config.fundingPackageId,
                usdcType: config.usdcType,
                amountMicroUsdc: amountValidation.microUsdc,
                objects: {
                    pauseState: config.donationPauseStateId,
                    mainPool: config.mainPoolId,
                    operationsPool: config.operationsPoolId,
                },
                destination,
            });

            setTxState({ status: "submitting" });
            const { digest } = await executeWalletTransaction(dAppKit, { transaction });
            setTxState({ status: "submitted", digest });
        } catch (error) {
            const message = error instanceof Error ? error.message : t("tx.failed.generic");
            setTxState({ status: "failed", message });
        }
    }

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="donate" locale={locale} />

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
                                    <label className="choice-option">
                                        <input
                                            checked={mode === "general"}
                                            name="donationMode"
                                            onChange={() => handleModeChange("general")}
                                            type="radio"
                                            value="general"
                                        />
                                        <span>
                                            <strong>{t("types.general.label")}</strong>
                                            <small>{t("types.general.description")}</small>
                                        </span>
                                    </label>
                                    <label className="choice-option">
                                        <input
                                            checked={mode === "campaign"}
                                            name="donationMode"
                                            onChange={() => handleModeChange("campaign")}
                                            type="radio"
                                            value="campaign"
                                        />
                                        <span>
                                            <strong>{t("types.campaign.label")}</strong>
                                            <small>{t("types.campaign.description")}</small>
                                        </span>
                                    </label>
                                    <label className="choice-option">
                                        <input
                                            checked={mode === "category"}
                                            name="donationMode"
                                            onChange={() => handleModeChange("category")}
                                            type="radio"
                                            value="category"
                                        />
                                        <span>
                                            <strong>{t("types.category.label")}</strong>
                                            <small>{t("types.category.description")}</small>
                                        </span>
                                    </label>
                                </div>
                            </fieldset>

                            {mode === "campaign" ? (
                                <fieldset className="control-group">
                                    <legend>{t("form.campaignLegend")}</legend>
                                    <div className="pool-select-list">
                                        {destinationState.status === "ready" &&
                                        destinationState.campaigns.length > 0 ? (
                                            destinationState.campaigns.map((campaign) => (
                                                <label
                                                    className="pool-select-option"
                                                    key={campaign.id}
                                                >
                                                    <input
                                                        checked={campaign.id === campaignId}
                                                        name="donateCampaign"
                                                        onChange={() =>
                                                            handleCampaignChange(campaign.id)
                                                        }
                                                        type="radio"
                                                        value={campaign.id}
                                                    />
                                                    <span>
                                                        <strong>{campaign.label}</strong>
                                                        <small>{campaign.campaignId}</small>
                                                    </span>
                                                </label>
                                            ))
                                        ) : destinationState.status === "loading" ? (
                                            <p className="faint">
                                                {t("submit.disabled.campaignLoading")}
                                            </p>
                                        ) : destinationState.campaigns.length === 0 ? (
                                            <p className="faint">
                                                {t("submit.disabled.campaignNotFound")}
                                            </p>
                                        ) : null}
                                    </div>
                                </fieldset>
                            ) : null}

                            {mode === "category" ? (
                                <fieldset className="control-group">
                                    <legend>{t("form.categoryLegend")}</legend>
                                    <div className="pool-select-list">
                                        {destinationState.status === "ready" &&
                                        destinationState.categories.length > 0 ? (
                                            destinationState.categories.map((category) => (
                                                <label
                                                    className="pool-select-option"
                                                    key={category.id}
                                                >
                                                    <input
                                                        checked={category.id === categoryPoolId}
                                                        name="donateCategory"
                                                        onChange={() =>
                                                            handleCategoryChange(category.id)
                                                        }
                                                        type="radio"
                                                        value={category.id}
                                                    />
                                                    <span>
                                                        <strong>{category.label}</strong>
                                                        <small>{category.categoryPoolId}</small>
                                                    </span>
                                                </label>
                                            ))
                                        ) : destinationState.status === "loading" ? (
                                            <p className="faint">
                                                {t("submit.disabled.categoryLoading")}
                                            </p>
                                        ) : destinationState.categories.length === 0 ? (
                                            <p className="faint">
                                                {t("submit.disabled.categoryNotFound")}
                                            </p>
                                        ) : null}
                                    </div>
                                </fieldset>
                            ) : null}

                            <div className="amount-field">
                                <label htmlFor="donation-amount">{t("form.amountLabel")}</label>
                                <div className="amount-input-wrap">
                                    <input
                                        id="donation-amount"
                                        inputMode="decimal"
                                        name="amount"
                                        onChange={(event) => {
                                            handleAmountChange(event.target.value);
                                        }}
                                        value={amountInput}
                                    />
                                    <span>USDC</span>
                                </div>
                                <div className="quick-amounts">
                                    {QUICK_AMOUNTS.map((amount) => (
                                        <button
                                            key={amount}
                                            onClick={() => {
                                                handleQuickAmount(amount);
                                            }}
                                            type="button"
                                        >
                                            {amount}
                                        </button>
                                    ))}
                                </div>
                                {!amountValidation.ok ? (
                                    <p className="faint">
                                        {t(`amount.error.${amountValidation.errorCode}`)}
                                    </p>
                                ) : null}
                            </div>

                            <div className="form-actions">
                                <button
                                    className="btn btn-primary btn-lg"
                                    disabled={isSubmitDisabled}
                                    onClick={handleSubmit}
                                    type="button"
                                >
                                    {isDonateInFlight ? t("form.submitting") : t("form.submit")}
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
                                    <span className="stat-num">{selectedAmountLabel}</span>
                                </div>
                                <div className="split-list">
                                    {splitRows.map((row) => (
                                        <div className="split-row" key={row.key}>
                                            <div>
                                                <strong>{row.label}</strong>
                                                <small>{row.detail}</small>
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
                                <div className={statusClass}>
                                    {resultView.loading ? (
                                        <LoadingIndicator label={txMessage()} />
                                    ) : (
                                        <strong>{txMessage()}</strong>
                                    )}
                                    <small>{txDetail()}</small>
                                    {resultView.digest !== null ? (
                                        <small className="faint">{resultView.digest}</small>
                                    ) : null}
                                    {resultView.explorerUrl !== null ? (
                                        <a
                                            className="text-action"
                                            href={resultView.explorerUrl}
                                            rel="noopener noreferrer"
                                            target="_blank"
                                        >
                                            {t("tx.submitted.explorerLink")}
                                        </a>
                                    ) : null}
                                    {resultView.canRetry ? (
                                        <small>{t("tx.failed.retryHint")}</small>
                                    ) : null}
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

function formatSubmitDisabledReason(
    t: (key: string) => string,
    reason: DonateSubmitDisabledReason,
    destinationErrorMessage: string | null,
): string {
    switch (reason.kind) {
        case "configMissing":
            return t("submit.disabled.configMissing");
        case "walletDisconnected":
            return t("submit.disabled.walletDisconnected");
        case "amountInvalid":
            return t(`amount.error.${reason.code}`);
        case "destinationNotFound":
            return reason.mode === "campaign"
                ? t("submit.disabled.campaignNotFound")
                : t("submit.disabled.categoryNotFound");
        case "destinationNotSelected":
            return reason.mode === "campaign"
                ? t("submit.disabled.campaignNotSelected")
                : t("submit.disabled.categoryNotSelected");
        case "destinationsError":
            return destinationErrorMessage ?? reason.message;
        case "destinationsLoading":
            return reason.mode === "campaign"
                ? t("submit.disabled.campaignLoading")
                : t("submit.disabled.categoryLoading");
    }
}
