"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { readWalletNetwork, resolveGrpcBaseUrl } from "../wallet/wallet-network";
import { executeWalletTransaction } from "../wallet/wallet-transaction-adapter";
import { validateDonationAmount } from "./donate-amount";
import { combineDonateConfig, type DonateConfig, readDonateEnvConfig } from "./donate-config";
import { readDonateDestinations } from "./donate-destinations";
import { buildDonateTransaction, type DonateDestinationInput } from "./donate-transaction";
import {
    buildCategoryListItems,
    buildDonateDonorPassReadState,
    buildDonateSplitRows,
    buildDonateTxResultView,
    type DonateDestinationMode,
    type DonateDestinationReadState,
    type DonateDonorPassReadState,
    type DonateSubmitDisabledReason,
    type DonateTxState,
    isDonateSubmitDisabled,
    resolveDonateSubmitDisabledReason,
    selectEmergencyBannerCampaign,
} from "./donate-view-state";
import { readDonorPassId, readDonorPassIdUntilVisible } from "./donor-pass-read";
import { EmergencyBanner } from "./emergency-banner";
import type { EmergencyBannerCampaign } from "./emergency-banner-state";

const QUICK_AMOUNTS = ["$50", "$100", "$250", "$1,000"] as const;
const DEFAULT_DONATION_AMOUNT = "400";
const POST_SUBMIT_DONOR_PASS_LOOKUP_ATTEMPTS = 8;
const POST_SUBMIT_DONOR_PASS_LOOKUP_DELAY_MS = 750;

/**
 * デモページ用の差し込み設定。
 * このオブジェクトが渡されたときだけ DonateView は「デモモード」になり、
 * 緊急バナーに固定キャンペーンを表示し、実送金を一切行わない。
 * 本番 /donate は demo を渡さないため、挙動は従来と変わらない。
 */
export interface DonateDemoConfig {
    /** 緊急バナーに固定表示するキャンペーン（実施中・概要付き）。 */
    readonly emergencyCampaign: EmergencyBannerCampaign;
    /** 結果パネルに表示する、デモであることの注記（ローカライズ済み）。 */
    readonly statusNote: string;
}

export function DonateView({
    locale,
    demo,
    initialMode,
    initialCampaignId,
    lockDestination = false,
    embedded = false,
}: {
    readonly locale: SonariLocale;
    readonly demo?: DonateDemoConfig;
    /**
     * 寄付先モードの初期値。省略時は "general"（従来どおり）。
     * lockDestination と組み合わせて campaign モードを固定するときに使う。
     */
    readonly initialMode?: DonateDestinationMode;
    /**
     * キャンペーン ID の初期値。initialMode === "campaign" と一緒に使う。
     * 省略時は auto-select（従来どおり）。
     */
    readonly initialCampaignId?: string;
    /**
     * true にすると寄付先の mode 切替 UI・campaign 選択 UI を非描画にし、
     * 固定された寄付先のみを表示する。未指定時は false（従来どおり）。
     */
    readonly lockDestination?: boolean;
    /**
     * true にするとページ chrome（背景・SiteTopbar・緊急バナー・ヒーロー・main）を
     * 描画せず、寄付フォーム部分だけを返す。/donate/[eventId] のように、呼び出し側が
     * 既にページ chrome を用意している場合の二重描画を防ぐ。未指定時は false（従来どおり）。
     */
    readonly embedded?: boolean;
}) {
    const demoMode = demo !== undefined;
    const t = useTranslations("donate");
    const account = useCurrentAccount();
    const network = readWalletNetwork();
    // env から読むのは packageID だけ。pause_state / pool は packageID 起点で導出する。
    const envConfig = useMemo(() => readDonateEnvConfig(), []);
    const fundingPackageId = envConfig.kind === "ok" ? envConfig.config.fundingPackageId : null;
    const [config, setConfig] = useState<DonateConfig | null>(null);
    const latestDonorPassLookupContext = useRef<{
        readonly owner: string | null;
        readonly network: typeof network;
        readonly donorRegistryId: string | null;
    }>({
        owner: null,
        network,
        donorRegistryId: null,
    });

    const [destinationState, setDestinationState] = useState<DonateDestinationReadState>({
        status: "idle",
        campaigns: [],
        categories: [],
        errorMessage: null,
    });
    const [donorPassState, setDonorPassState] = useState<DonateDonorPassReadState>({
        status: "idle",
    });
    const [mode, setMode] = useState<DonateDestinationMode>(initialMode ?? "general");
    const [campaignId, setCampaignId] = useState(initialCampaignId ?? "");
    const [categoryPoolId, setCategoryPoolId] = useState("");
    const [amountInput, setAmountInput] = useState(DEFAULT_DONATION_AMOUNT);
    const [txState, setTxState] = useState<DonateTxState>({ status: "idle" });

    const amountValidation = useMemo(() => validateDonationAmount(amountInput), [amountInput]);
    const isWalletConnected = account !== null;

    useEffect(() => {
        latestDonorPassLookupContext.current = {
            owner: account?.address ?? null,
            network,
            donorRegistryId: config?.donorRegistryId ?? null,
        };
    }, [account?.address, config?.donorRegistryId, network]);

    // packageID から pause_state / pool を導出して完全な設定を組み立てる。
    // 失敗の詳細は開発者向けに console へ出し、画面には設定不備の汎用文言を出す。
    useEffect(() => {
        // デモモードではチェーンを読まない（送金導線を持たない表示専用のため）。
        if (demoMode) {
            setConfig(null);
            return;
        }
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
    }, [demoMode, fundingPackageId, network]);

    useEffect(() => {
        // デモモードではチェーンを読まず、空の ready 状態にしてフォーム表示だけ保つ。
        if (demoMode || fundingPackageId === null) {
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
    }, [demoMode, fundingPackageId, network]);

    useEffect(() => {
        if (config === null || account === null) {
            setDonorPassState({ status: "idle" });
            return;
        }

        const client = new SuiGrpcClient({ network, baseUrl: resolveGrpcBaseUrl(network) });
        let cancelled = false;
        setDonorPassState({ status: "loading" });

        void (async () => {
            const result = await readDonorPassId(client, config.donorRegistryId, account.address);
            if (cancelled) {
                return;
            }

            setDonorPassState(buildDonateDonorPassReadState(result, { noneAsError: false }));
        })();

        return () => {
            cancelled = true;
        };
    }, [account, config, network]);

    useEffect(() => {
        if (destinationState.status !== "ready") {
            return;
        }

        if (mode === "campaign") {
            const hasSelected = destinationState.campaigns.some(
                (campaign) => campaign.id === campaignId,
            );
            if (!hasSelected) {
                // initialCampaignId が指定済みで、かつそのキャンペーンがまだ読み込まれていない場合は
                // 初期値を保持したまま待つ（auto-select で initialCampaignId を上書きしない）。
                if (initialCampaignId !== undefined && initialCampaignId.length > 0) {
                    return;
                }
                setCampaignId(destinationState.campaigns[0]?.id ?? "");
            }
            return;
        }

        if (mode === "category") {
            const hasSelected = destinationState.categories.some(
                (category) => category.id === categoryPoolId,
            );
            if (!hasSelected) {
                // Auto-select the first available (real on-chain) category.
                // buildCategoryListItems puts earthquake first, so use sorted order.
                const categoryItems = buildCategoryListItems(destinationState.categories);
                const firstAvailable = categoryItems.find((item) => item.kind === "available");
                setCategoryPoolId(
                    firstAvailable?.kind === "available" ? firstAvailable.categoryPoolId : "",
                );
            }
        }
    }, [destinationState, mode, campaignId, categoryPoolId, initialCampaignId]);

    // デモモードでは送金導線を出さないため、無効化理由の算出自体を省く。
    const disabledReason = demoMode
        ? null
        : resolveDonateSubmitDisabledReason({
              configReady: config !== null,
              walletConnected: isWalletConnected,
              amountValidation,
              donorPassState,
              selectedMode: mode,
              destinationState,
              selectedCampaignId: campaignId,
              selectedCategoryPoolId: categoryPoolId,
          });

    const resultView = buildDonateTxResultView(txState, network);
    // デモモードでは固定キャンペーンを注入し、本番ではチェーン由来の実施中キャンペーンを選ぶ。
    const emergencyBannerCampaign =
        demo !== undefined
            ? demo.emergencyCampaign
            : selectEmergencyBannerCampaign(destinationState, BigInt(Date.now()));
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
    const isSubmitDisabled = isDonateSubmitDisabled({
        demoMode,
        disabledReason,
        isInFlight: isDonateInFlight,
    });

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
        if (demo !== undefined) {
            return demo.statusNote;
        }
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
        if (demo !== undefined) {
            return "";
        }
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

    function handleBannerDonate(bannerCampaignId: string) {
        // デモモードではバナー CTA を無効化し、送金フローへのモード切替を行わない。
        if (demoMode) {
            return;
        }
        setMode("campaign");
        setCampaignId(bannerCampaignId);
        setTxState({ status: "idle" });
    }

    async function handleSubmit() {
        // デモモードでは実送金を一切行わない（最初の防御線）。
        if (demoMode) {
            return;
        }
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
        if (donorPassState.status !== "ready") {
            setTxState({
                status: "failed",
                message: txMessage(),
            });
            return;
        }

        setTxState({ status: "building" });
        try {
            const donorPass =
                donorPassState.passId === null
                    ? ({ kind: "none" } as const)
                    : ({ kind: "existing", passId: donorPassState.passId } as const);
            const submittedLookupContext = {
                owner: account.address,
                network,
                donorRegistryId: config.donorRegistryId,
            };
            const { transaction } = buildDonateTransaction({
                senderAddress: account.address,
                packageId: config.fundingPackageId,
                usdcType: config.usdcType,
                amountMicroUsdc: amountValidation.microUsdc,
                objects: {
                    pauseState: config.donationPauseStateId,
                    donorRegistry: config.donorRegistryId,
                    mainPool: config.mainPoolId,
                    operationsPool: config.operationsPoolId,
                },
                destination,
                donorPass,
            });

            setTxState({ status: "submitting" });
            const { digest } = await executeWalletTransaction(dAppKit, { transaction });
            setTxState({ status: "submitted", digest });
            if (donorPass.kind === "none") {
                setDonorPassState({ status: "loading" });
                const client = new SuiGrpcClient({
                    network,
                    baseUrl: resolveGrpcBaseUrl(network),
                });
                const result = await readDonorPassIdUntilVisible(
                    client,
                    config.donorRegistryId,
                    account.address,
                    {
                        maxAttempts: POST_SUBMIT_DONOR_PASS_LOOKUP_ATTEMPTS,
                        delayMs: POST_SUBMIT_DONOR_PASS_LOOKUP_DELAY_MS,
                    },
                );
                const latestLookupContext = latestDonorPassLookupContext.current;
                if (
                    latestLookupContext.owner !== submittedLookupContext.owner ||
                    latestLookupContext.network !== submittedLookupContext.network ||
                    latestLookupContext.donorRegistryId !== submittedLookupContext.donorRegistryId
                ) {
                    return;
                }
                setDonorPassState(buildDonateDonorPassReadState(result, { noneAsError: true }));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : t("tx.failed.generic");
            setTxState({ status: "failed", message });
        }
    }

    // 送金結果（ステータス）パネル。embedded / 通常どちらでも使うため抽出する。
    const resultPanel = (
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
                {resultView.canRetry ? <small>{t("tx.failed.retryHint")}</small> : null}
            </div>
        </section>
    );

    const donateForm = (
        <section
            className={`donate-layout${embedded ? " donate-layout-embedded" : ""}`}
            aria-label={t("form.title")}
        >
            <form className="donate-form" aria-labelledby="donation-form-title">
                <div className="form-heading">
                    <div>
                        <div className="eyebrow">{t("form.eyebrow")}</div>
                        <h2 id="donation-form-title">{t("form.title")}</h2>
                    </div>
                    <span className="tag tag-ok tag-dot">USDC</span>
                </div>

                {lockDestination ? (
                    <div className="locked-destination control-group">
                        <p className="faint">{t("form.lockedDestination")}</p>
                    </div>
                ) : (
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
                )}

                {!lockDestination && mode === "campaign" ? (
                    <fieldset className="control-group">
                        <legend>{t("form.campaignLegend")}</legend>
                        <div className="pool-select-list">
                            {destinationState.status === "ready" &&
                            destinationState.campaigns.length > 0 ? (
                                destinationState.campaigns.map((campaign) => (
                                    <label className="pool-select-option" key={campaign.id}>
                                        <input
                                            checked={campaign.id === campaignId}
                                            name="donateCampaign"
                                            onChange={() => handleCampaignChange(campaign.id)}
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
                                <p className="faint">{t("submit.disabled.campaignLoading")}</p>
                            ) : destinationState.campaigns.length === 0 ? (
                                <p className="faint">{t("submit.disabled.campaignNotFound")}</p>
                            ) : null}
                        </div>
                    </fieldset>
                ) : null}

                {mode === "category" ? (
                    <fieldset className="control-group">
                        <legend>{t("form.categoryLegend")}</legend>
                        <div className="pool-select-list">
                            {destinationState.status === "loading" ? (
                                <p className="faint">{t("submit.disabled.categoryLoading")}</p>
                            ) : destinationState.status === "ready" &&
                              destinationState.categories.length === 0 ? (
                                <>
                                    <p className="faint">{t("submit.disabled.categoryNotFound")}</p>
                                    {buildCategoryListItems([]).map((item) =>
                                        item.kind === "comingSoon" ? (
                                            <label
                                                className="pool-select-option pool-select-option-disabled"
                                                key={item.id}
                                            >
                                                <input
                                                    disabled
                                                    name="donateCategory"
                                                    type="radio"
                                                    value={item.id}
                                                />
                                                <span>
                                                    <strong>{t(item.labelKey)}</strong>
                                                    <small className="tag tag-neutral">
                                                        {t("category.comingSoonBadge")}
                                                    </small>
                                                </span>
                                            </label>
                                        ) : null,
                                    )}
                                </>
                            ) : (
                                buildCategoryListItems(destinationState.categories).map((item) => {
                                    if (item.kind === "available") {
                                        return (
                                            <label className="pool-select-option" key={item.id}>
                                                <input
                                                    checked={item.categoryPoolId === categoryPoolId}
                                                    name="donateCategory"
                                                    onChange={() =>
                                                        handleCategoryChange(item.categoryPoolId)
                                                    }
                                                    type="radio"
                                                    value={item.categoryPoolId}
                                                />
                                                <span>
                                                    <strong>{item.label}</strong>
                                                    <small>{item.categoryPoolId}</small>
                                                </span>
                                            </label>
                                        );
                                    }
                                    return (
                                        <label
                                            className="pool-select-option pool-select-option-disabled"
                                            key={item.id}
                                        >
                                            <input
                                                disabled
                                                name="donateCategory"
                                                type="radio"
                                                value={item.id}
                                            />
                                            <span>
                                                <strong>{t(item.labelKey)}</strong>
                                                <small className="tag tag-neutral">
                                                    {t("category.comingSoonBadge")}
                                                </small>
                                            </span>
                                        </label>
                                    );
                                })
                            )}
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
                        <p className="faint">{t(`amount.error.${amountValidation.errorCode}`)}</p>
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

            {embedded ? (
                // embedded（/donate/[eventId]）では分配プレビューと DonorPass ノートを出さず、
                // フォーム＋送金結果だけの単一カラムにしてシンプルにする。
                // 送金結果は寄付を実行した後（idle 以外）にだけ出す。
                txState.status !== "idle" ? (
                    resultPanel
                ) : null
            ) : (
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

                    {resultPanel}

                    <section className="donate-note">
                        <h3>{t("note.title")}</h3>
                        <p>{t("note.body")}</p>
                        <a className="text-action" href="/dashboard">
                            {t("note.link")}
                        </a>
                    </section>
                </aside>
            )}
        </section>
    );

    // embedded モード（/donate/[eventId] など）ではページ chrome を描画せず
    // フォーム部分だけ返す。背景・SiteTopbar・緊急バナー・ヒーローは呼び出し側が用意する。
    if (embedded) {
        return donateForm;
    }

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="donate" locale={locale} />

                <main className="page donate-page">
                    <EmergencyBanner
                        campaign={emergencyBannerCampaign}
                        onDonate={handleBannerDonate}
                    />
                    <header className="donate-hero">
                        <div>
                            <div className="eyebrow">{t("hero.eyebrow")}</div>
                            <h1>{t("hero.title")}</h1>
                            <p className="muted donate-sub">{t("hero.sub")}</p>
                        </div>
                    </header>

                    {donateForm}
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
        case "donorPassLoading":
            return t("submit.disabled.donorPassLoading");
        case "donorPassError":
            return reason.message;
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
