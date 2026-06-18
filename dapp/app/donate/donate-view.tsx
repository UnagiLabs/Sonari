"use client";

import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    GENESIS_OBJECT_KIND,
    readGenesisObjectIds,
    selectGenesisObjectId,
} from "../chain/genesis-objects";
import { readClaimCampaigns } from "../claim/claim-campaigns";
import { createClaimReadClient } from "../claim/claim-read-client";
import { LoadingIndicator } from "../components/loading-indicator";
import { parseMainPoolObject } from "../dashboard/dashboard-chain";
import { formatAmount } from "../i18n/format";
import { SiteTopbar } from "../i18n/site-topbar";
import { buildDisasterPoolViews } from "../pools/disaster-pool-view-model";
import type { SonariLocale } from "../register/wizard/locale";
import { dAppKit } from "../wallet/dapp-kit";
import { readWalletNetwork, resolveGrpcBaseUrl } from "../wallet/wallet-network";
import { executeWalletTransaction } from "../wallet/wallet-transaction-adapter";
import { DonationCompleteView } from "./complete/donation-complete-view";
import { DonationReceiptView } from "./complete/donation-receipt-view";
import { validateDonationAmount } from "./donate-amount";
import { combineDonateConfig, type DonateConfig, readDonateEnvConfig } from "./donate-config";
import { readDonateDestinations } from "./donate-destinations";
import { buildDonateTransaction, type DonateDestinationInput } from "./donate-transaction";
import {
    buildCategoryListItems,
    buildDonateDonorPassReadState,
    buildDonateTxResultView,
    type CategoryListItem,
    type DonateDestinationMode,
    type DonateDestinationReadState,
    type DonateDonorPassReadState,
    type DonateSubmitDisabledReason,
    type DonateTxState,
    isDonateSubmitDisabled,
    resolveDonateSubmitDisabledReason,
} from "./donate-view-state";
import { readDonorPassId, readDonorPassIdUntilVisible } from "./donor-pass-read";
import type { EmergencyBannerCampaign } from "./emergency-banner-state";

const QUICK_AMOUNTS = ["$50", "$100", "$250", "$1,000"] as const;
const DEFAULT_DONATION_AMOUNT = "400";
const POST_SUBMIT_DONOR_PASS_LOOKUP_ATTEMPTS = 8;
const POST_SUBMIT_DONOR_PASS_LOOKUP_DELAY_MS = 750;
const USDC_DECIMALS = 1_000_000n;

type DonateMainPoolMetricsState =
    | { readonly status: "idle" | "loading" | "error" }
    | {
          readonly status: "ready";
          readonly totalReceived: string;
          readonly totalSent: string;
          readonly activeReliefPools: string;
      };

/**
 * デモページ用の差し込み設定。
 * このオブジェクトが渡されたときだけ DonateView は「デモモード」になり、
 * 固定キャンペーンを扱うデモの実送金を一切行わない。
 * 本番 /donate は demo を渡さない。
 */
export interface DonateDemoConfig {
    /** デモ対象のキャンペーン（実施中・概要付き）。 */
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
    onSubmittedChange,
    destinationLabelOverride,
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
    /**
     * 送金が submitted へ遷移したかを親へ通知する。embedded の呼び出し側が、完了画面へ
     * 切り替わるタイミングで自前 chrome（ヒーロー・メトリクス等）を隠すために使う。
     */
    readonly onSubmittedChange?: (submitted: boolean) => void;
    /**
     * 完了/領収書に表示する寄付先ラベルの上書き。campaign の generic ラベル
     * （"Campaign <shortId>"）を災害名などの友好名に差し替えるときに使う。
     */
    readonly destinationLabelOverride?: string;
}) {
    const demoMode = demo !== undefined;
    const t = useTranslations("donate");
    const account = useCurrentAccount();
    const suiClient = useCurrentClient();
    const claimClient = useMemo(() => createClaimReadClient(suiClient), [suiClient]);
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
    const [mainPoolMetricsState, setMainPoolMetricsState] = useState<DonateMainPoolMetricsState>({
        status: "idle",
    });
    // 完了→領収書のフェーズと、領収書に載せる宛名・匿名設定・受領時刻。
    const [receiptPhase, setReceiptPhase] = useState<"complete" | "receipt">("complete");
    const [receiptForm, setReceiptForm] = useState<{
        readonly donorName: string;
        readonly anonymous: boolean;
    }>({ donorName: "", anonymous: false });
    const [submittedAt, setSubmittedAt] = useState<number | null>(null);

    const amountValidation = useMemo(() => validateDonationAmount(amountInput), [amountInput]);
    const isWalletConnected = account !== null;

    // submitted への遷移を親へ通知（embedded の親が自前 chrome を隠すため）。
    useEffect(() => {
        onSubmittedChange?.(txState.status === "submitted");
    }, [txState.status, onSubmittedChange]);

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
        if (demoMode || embedded || config === null || fundingPackageId === null) {
            setMainPoolMetricsState({ status: "idle" });
            return;
        }

        let cancelled = false;
        setMainPoolMetricsState({ status: "loading" });

        void (async () => {
            try {
                const nowMs = Date.now();
                const [poolResponse, campaignResult] = await Promise.all([
                    suiClient.getObjects({
                        objectIds: [config.mainPoolId],
                        include: { json: true },
                    }),
                    readClaimCampaigns(claimClient, { packageId: fundingPackageId, nowMs }),
                ]);
                if (cancelled) {
                    return;
                }

                const mainPool = parseMainPoolObject(poolResponse.objects[0]);
                if (mainPool === null) {
                    console.error("donate metrics failed: main pool response is invalid.");
                    setMainPoolMetricsState({ status: "error" });
                    return;
                }
                if (campaignResult.kind === "error") {
                    console.error(`donate metrics failed: ${campaignResult.message}`);
                    setMainPoolMetricsState({ status: "error" });
                    return;
                }

                const activeReliefPoolCount = buildDisasterPoolViews(
                    campaignResult.campaigns,
                    nowMs,
                ).filter((pool) => pool.status === "active").length;

                setMainPoolMetricsState({
                    status: "ready",
                    totalReceived: formatMicroUsdc(mainPool.totalReceivedUsdc, locale),
                    totalSent: formatMicroUsdc(mainPool.totalFloorFundedUsdc, locale),
                    activeReliefPools: formatAmount(activeReliefPoolCount, locale),
                });
            } catch (error) {
                if (cancelled) {
                    return;
                }
                console.error(
                    `donate metrics failed: ${error instanceof Error ? error.message : "unknown error"}`,
                );
                setMainPoolMetricsState({ status: "error" });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [claimClient, config, demoMode, embedded, fundingPackageId, locale, suiClient]);

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
    const destination = useMemo<DonateDestinationInput>(() => {
        if (mode === "campaign") {
            return { kind: "campaign", campaignId };
        }
        if (mode === "category") {
            return { kind: "category", categoryPoolId };
        }
        return { kind: "general" };
    }, [campaignId, categoryPoolId, mode]);

    // 完了/領収書に渡す表示値。金額は micro USDC から直接整形する。
    const completionAmountLabel = amountValidation.ok
        ? formatMicroUsdc(amountValidation.microUsdc, locale)
        : "";
    const destinationLabel =
        destinationLabelOverride ??
        (mode === "general"
            ? t("pools.main.label")
            : mode === "category"
              ? (() => {
                    const item = buildCategoryListItems(destinationState.categories).find(
                        (c) => c.categoryPoolId === categoryPoolId,
                    );
                    return item !== undefined
                        ? formatCategoryOptionLabel(t, item)
                        : t("pools.main.label");
                })()
              : (destinationState.campaigns.find((c) => c.campaignId === campaignId)?.label ??
                t("types.general.label")));

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

    // フォーム編集で送金結果と完了フェーズを初期化し、フォームへ戻す。
    function resetTxToForm() {
        setTxState({ status: "idle" });
        setReceiptPhase("complete");
    }

    function handleQuickAmount(value: string) {
        setAmountInput(normalizeAmount(value));
        resetTxToForm();
    }

    function handleAmountChange(value: string) {
        setAmountInput(value);
        resetTxToForm();
    }

    function handleModeChange(nextMode: DonateDestinationMode) {
        setMode(nextMode);
        resetTxToForm();
    }

    function handleCategoryChange(nextCategoryPoolId: string) {
        setCategoryPoolId(nextCategoryPoolId);
        resetTxToForm();
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
            setSubmittedAt(Date.now());
            setReceiptPhase("complete");
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
                            <Link
                                className="choice-option donate-specific-disaster-choice"
                                href="/pools"
                            >
                                <span>
                                    <strong>{t("types.specificDisaster.label")}</strong>
                                    <small>{t("types.specificDisaster.description")}</small>
                                </span>
                                <span className="choice-arrow" aria-hidden="true">
                                    →
                                </span>
                            </Link>
                        </div>
                    </fieldset>
                )}

                {mode === "category" ? (
                    <fieldset className="control-group">
                        <legend>{t("form.categoryLegend")}</legend>
                        <div className="pool-select-list">
                            {destinationState.status === "loading" ? (
                                <p className="faint">{t("submit.disabled.categoryLoading")}</p>
                            ) : destinationState.status === "ready" &&
                              destinationState.categories.length === 0 ? (
                                <p className="faint">{t("submit.disabled.categoryNotFound")}</p>
                            ) : (
                                buildCategoryListItems(destinationState.categories).map((item) => (
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
                                            <strong>{formatCategoryOptionLabel(t, item)}</strong>
                                            <small>{item.categoryPoolId}</small>
                                        </span>
                                    </label>
                                ))
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
                <p className="faint" style={{ textAlign: "center" }}>
                    {t("note.inline")}
                </p>
            </form>

            {txState.status !== "idle" ? resultPanel : null}
        </section>
    );

    // 送金成功後の完了/領収書ビュー（ページ chrome なしの中身）。
    // embedded / 非embedded のどちらでも使い回す。
    const completionScreen =
        receiptPhase === "complete" ? (
            <DonationCompleteView
                amountLabel={completionAmountLabel}
                destinationLabel={destinationLabel}
                digest={txState.status === "submitted" ? txState.digest : ""}
                explorerUrl={resultView.explorerUrl}
                donorName={receiptForm.donorName}
                anonymous={receiptForm.anonymous}
                onDonorNameChange={(value) =>
                    setReceiptForm((prev) => ({ ...prev, donorName: value }))
                }
                onAnonymousChange={(value) =>
                    setReceiptForm((prev) => ({ ...prev, anonymous: value }))
                }
                onIssueReceipt={() => setReceiptPhase("receipt")}
                locale={locale}
            />
        ) : (
            <DonationReceiptView
                amountLabel={completionAmountLabel}
                destinationLabel={destinationLabel}
                network={network}
                digest={txState.status === "submitted" ? txState.digest : ""}
                explorerUrl={resultView.explorerUrl}
                donorPassId={donorPassState.status === "ready" ? donorPassState.passId : null}
                receivedAtMs={submittedAt}
                donorName={receiptForm.anonymous ? null : receiptForm.donorName.trim() || null}
                onBack={() => setReceiptPhase("complete")}
                locale={locale}
            />
        );

    // embedded モード（/donate/[eventId] など）ではページ chrome を描画せず
    // フォーム部分だけ返す。背景・SiteTopbar・緊急バナー・ヒーローは呼び出し側が用意する。
    // 送金成功後は完了/領収書ビューへ切り替える（chrome は親が温存）。
    if (embedded) {
        return txState.status === "submitted" ? completionScreen : donateForm;
    }

    // 送金成功後はヒーロー/メトリクスを置き換えて完了/領収書を全画面で出す。
    if (txState.status === "submitted") {
        return (
            <>
                <div className="watercolor-bg receipt-bg" />
                <div className="app">
                    <SiteTopbar active="donate" locale={locale} />
                    <main className="page donate-page">{completionScreen}</main>
                </div>
            </>
        );
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
                    </header>

                    {mainPoolMetricsState.status === "ready" ? (
                        <section
                            className="metrics-strip donate-metrics"
                            aria-label={t("metrics.label")}
                        >
                            <article className="metric-item">
                                <div className="label">{t("metrics.totalReceived")}</div>
                                <div className="value">{mainPoolMetricsState.totalReceived}</div>
                            </article>
                            <article className="metric-item">
                                <div className="label">{t("metrics.totalSent")}</div>
                                <div className="value">{mainPoolMetricsState.totalSent}</div>
                            </article>
                            <article className="metric-item">
                                <div className="label">{t("metrics.activeReliefPools")}</div>
                                <div className="value">
                                    {mainPoolMetricsState.activeReliefPools}
                                </div>
                            </article>
                        </section>
                    ) : null}

                    {donateForm}
                </main>
            </div>
        </>
    );
}

function formatMicroUsdc(value: bigint, locale: SonariLocale): string {
    return formatAmount(bigintToNumber(value) / Number(USDC_DECIMALS), locale, {
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function bigintToNumber(value: bigint): number {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return value > max ? Number.MAX_SAFE_INTEGER : Number(value);
}

function formatCategoryOptionLabel(t: (key: string) => string, item: CategoryListItem): string {
    if (item.category === 1) {
        return t("category.options.earthquake");
    }
    return item.label;
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
