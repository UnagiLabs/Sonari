"use client";

// ---------------------------------------------------------------------------
// ClaimDetailView – /claim/[campaignId] 詳細ビュー
//
// 現行 claim-view.tsx（一覧ページ用）の請求フローを campaignId 駆動で移植。
// 選択の置換:
//   - 旧: selectedEventId state + ラジオ選択 UI
//   - 新: URL の campaignId から selectCampaignById で1件を特定
// 地図: AffectedAreaMap を resolvePreviewCellSource 経由で表示（デモデータ）。
//       地図データは請求の被災セル証明（fetchAffectedCellsProof）とは別経路。
// ロジック: 引数・分岐・トランザクション構築は claim-view.tsx の意味を保つ。
// ---------------------------------------------------------------------------

import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { computeIdentityStatementHash } from "@sonari/proof-core";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LoadingIndicator } from "../../components/loading-indicator";
import {
    type MembershipDappGenesisObjects,
    resolveMembershipDappGenesisObjects,
} from "../../chain/genesis-objects";
import { SiteTopbar } from "../../i18n/site-topbar";
import { type MembershipPassData, readMembershipPass } from "../../mypage/membership-pass-read";
import { MEMBERSHIP_TERMS_VERSION } from "../../register/terms-version";
import type { SonariLocale } from "../../register/wizard/locale";
import { dAppKit } from "../../wallet/dapp-kit";
import { WalletConnect } from "../../wallet/wallet-connect";
import { readWalletNetwork } from "../../wallet/wallet-network";
import { executeWalletTransaction } from "../../wallet/wallet-transaction-adapter";
import { AffectedAreaMap } from "../affected-area/affected-area-map";
import {
    resolvePreviewAffectedAreaArtifact,
    resolvePreviewCellSource,
} from "../affected-area/preview-cell-source";
import {
    type AffectedCellsProof,
    assertProofMatchesClaimContext,
    buildClaimTransaction,
    type ClaimTransactionObjectConfig,
    fetchAffectedCellsProof,
} from "../affected-cells-proof";
import { claimCampaignToProgram } from "../catalog/claim-campaign-adapter";
import {
    type ClaimCampaignState,
    type ClaimEligibility,
    readClaimCampaigns,
    readClaimEligibility,
} from "../claim-campaigns";
import { readClaimConfig } from "../claim-config";
import { buildClaimFlowActions, type ClaimFlowAction } from "../claim-flow";
import { resolveWorldIdClaimIdentity } from "../claim-identity";
import { type ClaimMessage, resolveClaimProofError, resolveClaimTxError } from "../claim-messages";
import {
    buildCampaignNotice,
    buildConfigNotice,
    buildPassNotice,
    buildWorldIdNotice,
    type ClaimNotice,
} from "../claim-notices";
import { createClaimReadClient } from "../claim-read-client";
import { buildClaimResultView, type TxState } from "../claim-result";
import { selectCampaignById } from "../select-campaign";

const WorldIdVerifyButton = dynamic(
    () =>
        import("../../register/identity/world-id-verify-button").then(
            (module) => module.WorldIdVerifyButton,
        ),
    { ssr: false },
);

type CheckKey = "finalized" | "membership" | "residence" | "noPreviousClaim" | "poolBudget";

const affectedProofWorkerUrl = process.env.NEXT_PUBLIC_SONARI_AFFECTED_PROOF_WORKER_URL ?? "";
const signedStatementHash = computeIdentityStatementHash(MEMBERSHIP_TERMS_VERSION);

const checkDefinitions: readonly { key: CheckKey; defaultStatus: "ready" | "pending" }[] = [
    { key: "finalized", defaultStatus: "ready" },
    { key: "membership", defaultStatus: "ready" },
    { key: "residence", defaultStatus: "ready" },
    { key: "noPreviousClaim", defaultStatus: "ready" },
    { key: "poolBudget", defaultStatus: "pending" },
];

const claimPreviewItems: readonly { labelKey: string; value?: string; valueKey?: string }[] = [
    { labelKey: "estimatedRelief", value: "$280 USDC" },
    { labelKey: "poolSource", value: "Earthquake Relief Pool" },
    { labelKey: "campaign", value: "USGS Earthquake Relief" },
    { labelKey: "receipt", valueKey: "receiptValue" },
];

type ProofState =
    | { readonly status: "idle" }
    | { readonly status: "checking" }
    | { readonly status: "ready"; readonly proof: AffectedCellsProof }
    | { readonly status: "blocked"; readonly message: ClaimMessage };

type PassState =
    | { readonly status: "idle" }
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly pass: MembershipPassData }
    | { readonly status: "none" }
    | { readonly status: "failed"; readonly message: string };

type CampaignState =
    | { readonly status: "loading"; readonly campaigns: readonly ClaimCampaignState[] }
    | { readonly status: "ready"; readonly campaigns: readonly ClaimCampaignState[] }
    | {
          readonly status: "failed";
          readonly campaigns: readonly ClaimCampaignState[];
          readonly message: string;
      };

type EligibilityState =
    | { readonly status: "idle" }
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly eligibility: ClaimEligibility }
    | { readonly status: "failed"; readonly message: string };

type GenesisObjectsState =
    | { readonly status: "idle" }
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly objects: MembershipDappGenesisObjects }
    | { readonly status: "failed"; readonly message: string };

const EMPTY_DUPLICATE_KEY_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
const ELIGIBILITY_REFRESH_INTERVAL_MS = 30_000;

export function ClaimDetailView({
    locale,
    campaignId,
}: {
    readonly locale: SonariLocale;
    readonly campaignId: string;
}) {
    const t = useTranslations("claim");
    const account = useCurrentAccount();
    const suiClient = useCurrentClient();
    // 読み取りは createClaimReadClient 経由。queryEvents は JSON-RPC、object 読み取りは
    // gRPC（dApp Kit クライアント）へ委譲する（gRPC にイベント検索が無いため）。
    const client = useMemo(() => createClaimReadClient(suiClient), [suiClient]);
    const claimConfigResult = useMemo(() => readClaimConfig(), []);
    const claimConfig = claimConfigResult.kind === "ok" ? claimConfigResult.config : null;

    const [proofState, setProofState] = useState<ProofState>({ status: "idle" });
    const [txState, setTxState] = useState<TxState>({ status: "idle" });
    const [txAction, setTxAction] = useState<ClaimFlowAction | null>(null);
    const [passState, setPassState] = useState<PassState>({ status: "idle" });
    const [worldIdResponse, setWorldIdResponse] = useState<Record<string, unknown> | null>(null);
    const [campaignReadNonce, setCampaignReadNonce] = useState(0);
    const [passReadNonce, setPassReadNonce] = useState(0);
    const [eligibilityReadNonce, setEligibilityReadNonce] = useState(0);
    const [campaignState, setCampaignState] = useState<CampaignState>({
        status: "loading",
        campaigns: [],
    });
    const [eligibilityState, setEligibilityState] = useState<EligibilityState>({
        status: "idle",
    });
    const [genesisObjectsState, setGenesisObjectsState] = useState<GenesisObjectsState>({
        status: "idle",
    });

    const resetClaimProgress = useCallback(() => {
        setProofState({ status: "idle" });
        setTxState({ status: "idle" });
        setTxAction(null);
        setWorldIdResponse(null);
        setEligibilityState({ status: "idle" });
    }, []);

    const network = readWalletNetwork();
    const resultView = buildClaimResultView(txState, network);

    // URL の campaignId から1件を特定する（ラジオ選択は不要）。
    const selectedEvent =
        campaignState.status === "loading"
            ? null
            : selectCampaignById(campaignState.campaigns, campaignId);

    const isWalletConnected = account !== null;
    const membershipPass = passState.status === "ready" ? passState.pass : null;
    const genesisObjects =
        genesisObjectsState.status === "ready" ? genesisObjectsState.objects : null;
    const identityMaterial =
        claimConfig === null
            ? { kind: "missing" as const, reason: "world_id_config" as const }
            : resolveWorldIdClaimIdentity({
                  rpId: claimConfig.worldIdRpId,
                  action: claimConfig.worldIdAction,
                  idkitResponse: worldIdResponse,
              });
    const txObjects =
        genesisObjects !== null && membershipPass !== null && selectedEvent !== null
            ? buildClaimTransactionObjects(genesisObjects, membershipPass, selectedEvent)
            : null;
    const isClaimInFlight = txState.status === "building" || txState.status === "submitting";
    const claimEligibility =
        eligibilityState.status === "ready" ? eligibilityState.eligibility : null;
    const claimable = claimEligibility?.kind === "claimable";
    const proofRequired = claimable && claimEligibility.claimProofKind === "initial";
    const worldIdRequired = claimable && claimEligibility.requiresIdentity;
    const claimActions = buildClaimFlowActions({
        proofReady: proofState.status === "ready",
        proofRequired,
        walletConnected: isWalletConnected,
        txObjectsReady: txObjects !== null,
        worldIdReady: identityMaterial.kind === "ok",
        worldIdRequired,
        claimable,
        inFlight: isClaimInFlight,
    });
    const configNotice = buildConfigNotice(claimConfigResult.kind);
    const campaignNotice = buildCampaignNotice({
        status: campaignState.status,
        campaignCount: campaignState.campaigns.length,
    });
    const passNotice = buildPassNotice({
        walletConnected: isWalletConnected,
        status: passState.status,
    });
    const worldIdNotice = buildWorldIdNotice(
        worldIdRequired && identityMaterial.kind === "missing" ? identityMaterial.reason : null,
    );

    useEffect(() => {
        resetClaimProgress();

        if (claimConfig === null) {
            setGenesisObjectsState({ status: "idle" });
            return;
        }

        let cancelled = false;
        setGenesisObjectsState({ status: "loading" });
        resolveMembershipDappGenesisObjects(client, { packageId: claimConfig.packageId })
            .then((result) => {
                if (cancelled) {
                    return;
                }
                if (result.kind === "ok") {
                    setGenesisObjectsState({ status: "ready", objects: result.objects });
                    return;
                }
                setGenesisObjectsState({ status: "failed", message: result.message });
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setGenesisObjectsState({
                        status: "failed",
                        message:
                            error instanceof Error
                                ? error.message
                                : "Failed to resolve claim objects.",
                    });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [claimConfig, client, resetClaimProgress]);

    // 地図プレビュー用の CellSource（被災セル証明とは別経路）。
    // selectedEvent → DisasterClaimableProgram → resolvePreviewCellSource の流れ。
    const previewProgram = selectedEvent !== null ? claimCampaignToProgram(selectedEvent) : null;
    const previewCellSource =
        previewProgram !== null ? resolvePreviewCellSource(previewProgram) : null;
    const previewAffectedAreaArtifact =
        previewProgram !== null ? resolvePreviewAffectedAreaArtifact(previewProgram) : null;

    // biome-ignore lint/correctness/useExhaustiveDependencies: campaignReadNonce is a retry trigger.
    useEffect(() => {
        if (claimConfig === null) {
            setCampaignState({ status: "ready", campaigns: [] });
            return;
        }

        let cancelled = false;
        setCampaignState({ status: "loading", campaigns: [] });
        readClaimCampaigns(client, { packageId: claimConfig.packageId, nowMs: Date.now() })
            .then((result) => {
                if (cancelled) {
                    return;
                }
                if (result.kind === "ok") {
                    setCampaignState({ status: "ready", campaigns: result.campaigns });
                    return;
                }
                setCampaignState({
                    status: "failed",
                    campaigns: [],
                    message: result.message,
                });
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setCampaignState({
                        status: "failed",
                        campaigns: [],
                        message:
                            error instanceof Error ? error.message : "Failed to read campaigns.",
                    });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [campaignReadNonce, claimConfig, client]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: passReadNonce is a retry trigger.
    useEffect(() => {
        resetClaimProgress();

        if (account === null) {
            setPassState({ status: "idle" });
            return;
        }
        if (claimConfig === null) {
            setPassState({ status: "failed", message: "Claim config is not ready." });
            return;
        }
        if (genesisObjects === null) {
            setPassState({ status: "idle" });
            return;
        }

        let cancelled = false;
        setPassState({ status: "loading" });
        readMembershipPass(
            client,
            account.address,
            claimConfig.packageId,
            genesisObjects.identityRegistry,
        )
            .then((result) => {
                if (cancelled) {
                    return;
                }
                if (result.kind === "ok") {
                    setPassState({ status: "ready", pass: result.pass });
                    return;
                }
                if (result.kind === "none") {
                    setPassState({ status: "none" });
                    return;
                }
                setPassState({ status: "failed", message: result.message });
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setPassState({
                        status: "failed",
                        message:
                            error instanceof Error
                                ? error.message
                                : "Failed to read MembershipPass.",
                    });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [account, claimConfig, client, genesisObjects, passReadNonce, resetClaimProgress]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: eligibilityReadNonce is a retry trigger.
    useEffect(() => {
        if (
            claimConfig === null ||
            selectedEvent === null ||
            membershipPass === null ||
            account === null
        ) {
            setEligibilityState({ status: "idle" });
            return;
        }

        let cancelled = false;
        setEligibilityState({ status: "loading" });
        readClaimEligibility(client, {
            packageId: claimConfig.packageId,
            campaign: selectedEvent,
            passLineageId: membershipPass.passLineageId,
            nowMs: Date.now(),
        })
            .then((result) => {
                if (cancelled) {
                    return;
                }
                if (result.kind === "ok") {
                    setEligibilityState({ status: "ready", eligibility: result.eligibility });
                    return;
                }
                setEligibilityState({ status: "failed", message: result.message });
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setEligibilityState({
                        status: "failed",
                        message:
                            error instanceof Error
                                ? error.message
                                : "Failed to read claim eligibility.",
                    });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [account, claimConfig, client, eligibilityReadNonce, membershipPass, selectedEvent]);

    useEffect(() => {
        if (
            claimConfig === null ||
            selectedEvent === null ||
            membershipPass === null ||
            account === null
        ) {
            return;
        }

        const timer = window.setInterval(() => {
            setEligibilityReadNonce((value) => value + 1);
        }, ELIGIBILITY_REFRESH_INTERVAL_MS);
        return () => {
            window.clearInterval(timer);
        };
    }, [account, claimConfig, membershipPass, selectedEvent]);

    // カタログのキー or 原文を、現在の locale で表示文字列へ解決する。
    const renderMessage = (message: ClaimMessage): string =>
        message.kind === "key" ? t(message.key) : message.text;

    const renderNotice = (notice: ClaimNotice | null, onRetry?: () => void) =>
        notice === null ? null : (
            <div className={`claim-inline-notice ${notice.level}`} role="status">
                <span>{t(notice.key)}</span>
                {notice.retryable && onRetry !== undefined ? (
                    <button className="text-action" onClick={onRetry} type="button">
                        {t("status.retry")}
                    </button>
                ) : null}
            </div>
        );

    const proofMessage = (): string => {
        switch (proofState.status) {
            case "idle":
                return t("proof.idle");
            case "checking":
                return t("proof.checking");
            case "ready":
                return t("proof.ready");
            case "blocked":
                return renderMessage(proofState.message);
        }
    };

    const txMessage = (): string => {
        switch (txState.status) {
            case "idle":
                return t("tx.idle.message");
            case "building":
                return t("tx.building.message");
            case "submitting":
                return t("tx.submitting.message");
            case "submitted":
                return t("tx.submitted.message");
            case "failed":
                return renderMessage(txState.message);
        }
    };

    const txDetail = (): string => {
        switch (txState.status) {
            case "idle":
                return t("tx.idle.detail");
            case "building":
                return t("tx.building.detail");
            case "submitting":
                return t("tx.submitting.detail");
            case "submitted":
                return t("tx.submitted.detail", { digest: txState.digest });
            case "failed":
                return t("tx.failed.detail");
        }
    };

    const checks = checkDefinitions.map((definition) => {
        // 居住セルのチェックだけは証明の結果に追従する。証明が未完了なら
        // 証明メッセージを detail にしてステータスを pending にする。
        if (definition.key === "residence" && proofState.status !== "ready") {
            return {
                key: definition.key,
                label: t("checks.residence.label"),
                detail: proofMessage(),
                status: "pending" as const,
            };
        }
        return {
            key: definition.key,
            label: t(`checks.${definition.key}.label`),
            detail: t(`checks.${definition.key}.detail`),
            status: definition.defaultStatus,
        };
    });

    async function handleCheckEligibility() {
        if (selectedEvent === null || membershipPass === null) {
            return;
        }
        if (!proofRequired) {
            setProofState({ status: "idle" });
            return;
        }

        setProofState({ status: "checking" });
        setTxState({ status: "idle" });

        try {
            const proof = await fetchAffectedCellsProof({
                workerUrl: affectedProofWorkerUrl,
                eventUid: selectedEvent.eventUid,
                eventRevision: selectedEvent.eventRevision,
                homeCell: membershipPass.homeCell,
            });
            assertProofMatchesClaimContext(proof, {
                eventUid: selectedEvent.eventUid,
                eventRevision: selectedEvent.eventRevision,
                homeCell: membershipPass.homeCell,
                affectedCellsRoot: selectedEvent.affectedCellsRoot,
            });
            setProofState({ status: "ready", proof });
        } catch (error) {
            setProofState({ status: "blocked", message: resolveClaimProofError(error) });
        }
    }

    async function handleClaimAction(action: ClaimFlowAction) {
        if (selectedEvent === null || membershipPass === null || txObjects === null) {
            return;
        }
        if (claimConfig === null) {
            setTxState({
                status: "failed",
                message: { kind: "key", key: "tx.failed.generic" },
            });
            return;
        }
        if (account === null) {
            setTxState({
                status: "failed",
                message: { kind: "key", key: "tx.failed.walletRequired" },
            });
            return;
        }
        if (claimEligibility?.kind !== "claimable") {
            setTxState({
                status: "failed",
                message: { kind: "key", key: "tx.failed.nothingToClaim" },
            });
            return;
        }
        if (claimEligibility.requiresIdentity && identityMaterial.kind !== "ok") {
            setTxState({
                status: "failed",
                message: { kind: "key", key: "tx.failed.generic" },
            });
            return;
        }

        setTxState({ status: "building" });
        setTxAction(action);
        try {
            const transaction = buildClaimTransaction({
                senderAddress: account.address,
                packageId: claimConfig.packageId,
                objects: txObjects,
                identityProvider:
                    identityMaterial.kind === "ok" ? identityMaterial.identityProvider : 0,
                duplicateKeyHash:
                    identityMaterial.kind === "ok"
                        ? identityMaterial.duplicateKeyHash
                        : EMPTY_DUPLICATE_KEY_HASH,
                claimProof:
                    claimEligibility.claimProofKind === "initial"
                        ? (() => {
                              if (proofState.status !== "ready") {
                                  throw new Error("Affected cells proof is not ready.");
                              }
                              return {
                                  kind: "initial" as const,
                                  proof: proofState.proof,
                                  context: {
                                      eventUid: selectedEvent.eventUid,
                                      eventRevision: selectedEvent.eventRevision,
                                      homeCell: membershipPass.homeCell,
                                      affectedCellsRoot: selectedEvent.affectedCellsRoot,
                                  },
                              };
                          })()
                        : { kind: "continuing" },
            }).transaction;

            setTxState({ status: "submitting" });
            const { digest } = await executeWalletTransaction(dAppKit, { transaction });
            setEligibilityReadNonce((value) => value + 1);
            setTxState({ status: "submitted", digest });
        } catch (error) {
            setTxState({ status: "failed", message: resolveClaimTxError(error) });
        }
    }

    // ローディング中
    if (campaignState.status === "loading") {
        return (
            <>
                <div className="watercolor-bg" />
                <div className="app">
                    <SiteTopbar active="claim" locale={locale} />
                    <main className="page claim-page">
                        <div className="claim-loading" role="status">
                            <LoadingIndicator label={t("detail.loading")} />
                        </div>
                    </main>
                </div>
            </>
        );
    }

    // 取得完了かつ campaignId 不一致（not found）
    if (selectedEvent === null) {
        return (
            <>
                <div className="watercolor-bg" />
                <div className="app">
                    <SiteTopbar active="claim" locale={locale} />
                    <main className="page claim-page">
                        <div className="claim-not-found">
                            <h1>{t("detail.notFoundTitle")}</h1>
                            <p>{t("detail.notFoundBody")}</p>
                            <a className="btn btn-secondary" href="/claim">
                                {t("event.viewEvents")}
                            </a>
                        </div>
                    </main>
                </div>
            </>
        );
    }

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="claim" locale={locale} />

                <main className="page claim-page">
                    <header className="claim-hero">
                        <div>
                            <div className="eyebrow">{t("hero.eyebrow")}</div>
                            <h1>{t("hero.title")}</h1>
                            <p className="muted claim-sub">{t("hero.sub")}</p>
                        </div>
                        <div className="claim-wallet-panel">
                            <span className="tag tag-neutral">{t("hero.walletTag")}</span>
                            <p>{t("hero.walletBody")}</p>
                            <WalletConnect />
                        </div>
                    </header>

                    {/* 選択キャンペーンの概要ヘッダ（ラジオ選択の代わり） */}
                    <section className="claim-event-panel" aria-labelledby="campaign-summary-title">
                        <div className="form-heading">
                            <div>
                                <div className="eyebrow">{t("event.eyebrow")}</div>
                                <h2 id="campaign-summary-title">{selectedEvent.title}</h2>
                            </div>
                            <a className="text-action" href="/claim">
                                {t("event.viewEvents")}
                            </a>
                        </div>
                        {renderNotice(configNotice)}
                        {renderNotice(campaignNotice, () =>
                            setCampaignReadNonce((value) => value + 1),
                        )}
                        <dl className="pass-grid">
                            <div>
                                <dt>{t("detail.summaryRegion")}</dt>
                                <dd>{selectedEvent.region}</dd>
                            </div>
                            <div>
                                <dt>{t("detail.summaryBand")}</dt>
                                <dd>Band {selectedEvent.severityBand}</dd>
                            </div>
                            <div>
                                <dt>{t("detail.summaryAffectedCells")}</dt>
                                <dd>{selectedEvent.affectedCellCount}</dd>
                            </div>
                            <div>
                                <dt>{t("detail.summaryDeadline")}</dt>
                                <dd>{formatClaimWindow(selectedEvent.claimEndMs)}</dd>
                            </div>
                        </dl>
                    </section>

                    {/* 被災エリア地図プレビュー（デモデータ・証明とは別経路） */}
                    {previewCellSource !== null && previewAffectedAreaArtifact !== null ? (
                        <section className="claim-map-section" aria-labelledby="map-section-title">
                            <div className="panel-header">
                                <div>
                                    <h2 id="map-section-title">{t("detail.mapTitle")}</h2>
                                </div>
                                <span className="tag tag-neutral">
                                    {t("detail.mapPreviewLabel")}
                                </span>
                            </div>
                            <AffectedAreaMap
                                affectedAreaArtifact={previewAffectedAreaArtifact}
                                cellSource={previewCellSource}
                                residenceCell={membershipPass?.homeCell ?? null}
                            />
                        </section>
                    ) : null}

                    <section className="claim-layout" aria-label={t("hero.eyebrow")}>
                        <div className="claim-main">
                            <section className="claim-pass-panel" aria-labelledby="pass-title">
                                <div className="panel-header">
                                    <div>
                                        <div className="eyebrow">{t("pass.eyebrow")}</div>
                                        <h2 id="pass-title">{t("pass.title")}</h2>
                                    </div>
                                    <span className="tag tag-ok tag-dot">
                                        {membershipPass === null
                                            ? t("checkStatus.pending")
                                            : t("pass.statusActive")}
                                    </span>
                                </div>
                                <dl className="pass-grid">
                                    <div>
                                        <dt>{t("pass.passId")}</dt>
                                        <dd>
                                            {membershipPass === null
                                                ? "-"
                                                : shortObjectId(membershipPass.objectId)}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>{t("pass.residenceCell")}</dt>
                                        <dd>{membershipPass?.homeCell ?? "-"}</dd>
                                    </div>
                                    <div>
                                        <dt>{t("pass.verification")}</dt>
                                        <dd>
                                            {membershipPass?.identityVerified === true
                                                ? t("pass.verificationValid")
                                                : t("checkStatus.pending")}
                                        </dd>
                                    </div>
                                </dl>
                                {renderNotice(passNotice, () =>
                                    setPassReadNonce((value) => value + 1),
                                )}
                            </section>

                            <section
                                className="claim-check-panel"
                                aria-labelledby="eligibility-title"
                            >
                                <div className="panel-header">
                                    <div>
                                        <div className="eyebrow">{t("eligibility.eyebrow")}</div>
                                        <h2 id="eligibility-title">{t("eligibility.title")}</h2>
                                    </div>
                                    <button
                                        className="btn btn-secondary"
                                        disabled={
                                            !proofRequired || proofState.status === "checking"
                                        }
                                        onClick={handleCheckEligibility}
                                        type="button"
                                    >
                                        {t("eligibility.checkButton")}
                                    </button>
                                </div>
                                {renderNotice(
                                    eligibilityState.status === "failed"
                                        ? {
                                              key: "status.eligibilityFailed",
                                              level: "error",
                                              retryable: true,
                                          }
                                        : null,
                                    () => setEligibilityReadNonce((value) => value + 1),
                                )}
                                <div className="check-list">
                                    {checks.map((check) => (
                                        <div className="check-row" key={check.key}>
                                            <span
                                                className={`check-indicator ${
                                                    check.status === "ready" ? "ready" : "pending"
                                                }`}
                                            />
                                            <div>
                                                <strong>{check.label}</strong>
                                                <small>{check.detail}</small>
                                            </div>
                                            <span className="tag tag-neutral">
                                                {t(`checkStatus.${check.status}`)}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                                <p className="muted claim-sub">{proofMessage()}</p>
                                <fieldset className="control-group">
                                    <legend>{t("worldId.title")}</legend>
                                    <WorldIdVerifyButton
                                        membershipId={membershipPass?.objectId ?? ""}
                                        onVerified={setWorldIdResponse}
                                        owner={account?.address ?? ""}
                                        signedStatementHash={signedStatementHash}
                                        statementsAccepted={true}
                                        verified={worldIdResponse !== null}
                                    />
                                    {renderNotice(worldIdNotice)}
                                </fieldset>
                            </section>
                        </div>

                        <aside className="claim-side" aria-label={t("preview.eyebrow")}>
                            <section className="claim-summary-panel">
                                <div className="panel-header compact">
                                    <div>
                                        <div className="eyebrow">{t("preview.eyebrow")}</div>
                                        <h2>{t("preview.title")}</h2>
                                    </div>
                                </div>
                                <div className="claim-preview-list">
                                    {claimPreviewItems.map((item) => (
                                        <div className="claim-preview-row" key={item.labelKey}>
                                            <span>{t(`preview.${item.labelKey}`)}</span>
                                            <strong>
                                                {item.valueKey
                                                    ? t(`preview.${item.valueKey}`)
                                                    : item.value}
                                            </strong>
                                        </div>
                                    ))}
                                </div>
                                <div className="claim-action-list">
                                    {claimActions.map((action) => (
                                        <button
                                            className="btn btn-primary btn-lg"
                                            disabled={action.disabled}
                                            key={action.action}
                                            onClick={() => void handleClaimAction(action.action)}
                                            type="button"
                                        >
                                            {isClaimInFlight && txAction === action.action
                                                ? t("claimButtonInFlight")
                                                : t("actions.claim")}
                                        </button>
                                    ))}
                                </div>
                            </section>

                            <section className="claim-note">
                                <h3>{t("note.title")}</h3>
                                <p>{t("note.body")}</p>
                            </section>

                            <section className="claim-result-panel">
                                <div className="eyebrow">{t("result.eyebrow")}</div>
                                <div className="result-placeholder">
                                    {resultView.loading ? (
                                        <LoadingIndicator label={txMessage()} />
                                    ) : (
                                        <strong>{txMessage()}</strong>
                                    )}
                                    <small>{txDetail()}</small>
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
                                    {resultView.showDashboardCta ? (
                                        <a className="btn btn-secondary" href="/mypage">
                                            {t("tx.submitted.cta")}
                                        </a>
                                    ) : null}
                                </div>
                            </section>
                        </aside>
                    </section>
                </main>
            </div>
        </>
    );
}

function buildClaimTransactionObjects(
    objects: MembershipDappGenesisObjects,
    pass: MembershipPassData,
    event: ClaimCampaignState,
): ClaimTransactionObjectConfig {
    return {
        pauseState: objects.pauseState,
        membershipRegistry: objects.membershipRegistry,
        campaign: event.campaignId,
        disasterEvent: event.disasterEventId,
        identityRegistry: objects.identityRegistry,
        pass: pass.objectId,
    };
}

function shortObjectId(value: string): string {
    return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function formatClaimWindow(claimEndMs: string): string {
    const value = Number(claimEndMs);
    if (!Number.isSafeInteger(value) || value < 0) {
        return claimEndMs;
    }
    return new Date(value).toISOString().slice(0, 10);
}
