"use client";

// ---------------------------------------------------------------------------
// ClaimDetailView – /claim/[eventId] 詳細ビュー
//
// 現行 claim-view.tsx（一覧ページ用）の請求フローを disasterEventId 駆動で移植。
// 選択の置換:
//   - 旧: selectedEventId state + ラジオ選択 UI
//   - 新: URL の disasterEventId から selectCampaignByEventId で1件を特定
// 地図: AffectedAreaMap を affectedAreaArtifactFromBaseUrl 経由で表示する。
//       地図データは請求の被災セル証明（fetchAffectedCellsProof）とは別経路。
// ロジック: 引数・分岐・トランザクション構築は claim-view.tsx の意味を保つ。
// ---------------------------------------------------------------------------

import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    type MembershipDappGenesisObjects,
    resolveMembershipDappGenesisObjects,
} from "../../chain/genesis-objects";
import { LoadingIndicator } from "../../components/loading-indicator";
import { formatDate } from "../../i18n/format";
import { SiteTopbar } from "../../i18n/site-topbar";
import { type MembershipPassData, readMembershipPass } from "../../mypage/membership-pass-read";
import { buildDisasterPoolViews } from "../../pools/disaster-pool-view-model";
import type { SonariLocale } from "../../register/wizard/locale";
import { dAppKit } from "../../wallet/dapp-kit";
import { readWalletNetwork } from "../../wallet/wallet-network";
import { executeWalletTransaction } from "../../wallet/wallet-transaction-adapter";
import { affectedAreaArtifactFromBaseUrl } from "../affected-area/affected-area-artifact";
import { AffectedAreaMap } from "../affected-area/affected-area-map";
import {
    type AffectedCellsProof,
    assertProofMatchesClaimContext,
    buildClaimTransaction,
    ClaimProofError,
    type ClaimProofErrorCode,
    type ClaimTransactionObjectConfig,
    fetchAffectedCellsProof,
} from "../affected-cells-proof";
import { bandAmount, parseCellBand } from "../catalog/cell-band-rules";
import {
    type ClaimCampaignState,
    type ClaimEligibility,
    readClaimCampaigns,
    readClaimEligibility,
} from "../claim-campaigns";
import { readClaimConfig } from "../claim-config";
import { buildClaimFlowActions, type ClaimFlowAction } from "../claim-flow";
import { type ClaimMessage, resolveClaimProofError, resolveClaimTxError } from "../claim-messages";
import {
    buildCampaignNotice,
    buildConfigNotice,
    buildPassNotice,
    type ClaimNotice,
} from "../claim-notices";
import { createClaimReadClient } from "../claim-read-client";
import { buildClaimResultView, type TxState } from "../claim-result";
import { selectCampaignByEventId } from "../select-campaign";

const affectedProofWorkerUrl = process.env.NEXT_PUBLIC_SONARI_AFFECTED_PROOF_WORKER_URL ?? "";

type ProofState =
    | { readonly status: "idle" }
    | { readonly status: "checking" }
    | { readonly status: "ready"; readonly proof: AffectedCellsProof }
    | {
          readonly status: "blocked";
          readonly message: ClaimMessage;
          readonly code: ClaimProofErrorCode | null;
      };

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
    eventId,
}: {
    readonly locale: SonariLocale;
    readonly eventId: string;
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
        setEligibilityState({ status: "idle" });
    }, []);

    const network = readWalletNetwork();
    const resultView = buildClaimResultView(txState, network);

    // URL の disasterEventId から1件を特定する。
    const selectedEvent =
        campaignState.status === "loading"
            ? null
            : selectCampaignByEventId(campaignState.campaigns, eventId);
    const selectedPoolView =
        selectedEvent === null
            ? null
            : (buildDisasterPoolViews([selectedEvent], Date.now())[0] ?? null);

    const isWalletConnected = account !== null;
    const membershipPass = passState.status === "ready" ? passState.pass : null;
    const genesisObjects =
        genesisObjectsState.status === "ready" ? genesisObjectsState.objects : null;
    const txObjects =
        genesisObjects !== null && membershipPass !== null && selectedEvent !== null
            ? buildClaimTransactionObjects(genesisObjects, membershipPass, selectedEvent)
            : null;
    const isClaimInFlight = txState.status === "building" || txState.status === "submitting";
    const claimEligibility =
        eligibilityState.status === "ready" ? eligibilityState.eligibility : null;
    const accountVerified = membershipPass?.identityVerified === true;
    const claimable = claimEligibility?.kind === "claimable";
    const claimActions = buildClaimFlowActions({
        proofReady: proofState.status === "ready",
        walletConnected: isWalletConnected,
        accountVerified,
        txObjectsReady: txObjects !== null,
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

    const affectedAreaArtifact =
        selectedEvent === null
            ? null
            : affectedAreaArtifactFromBaseUrl(
                  process.env.NEXT_PUBLIC_SONARI_AFFECTED_AREA_BASE_URL,
                  {
                      eventUid: selectedEvent.eventUid,
                      eventRevision: selectedEvent.eventRevision,
                  },
              );

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

    // 居住セルが被災セルに含まれるかを画面側で自動取得する。
    // proofState.status はここでは再実行トリガーにしない。idle から checking にした瞬間に
    // effect cleanup で取得処理をキャンセルしないため。
    // biome-ignore lint/correctness/useExhaustiveDependencies: proofState.status is intentionally read without retriggering this effect.
    useEffect(() => {
        if (selectedEvent === null || membershipPass === null || proofState.status !== "idle") {
            return;
        }

        void handleCheckEligibility();
    }, [selectedEvent, membershipPass]);

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

    async function handleCheckEligibility() {
        if (selectedEvent === null || membershipPass === null) {
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
            setProofState({
                status: "blocked",
                message: resolveClaimProofError(error),
                code: error instanceof ClaimProofError ? error.code : null,
            });
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

        setTxState({ status: "building" });
        setTxAction(action);
        try {
            const transaction = buildClaimTransaction({
                senderAddress: account.address,
                packageId: claimConfig.packageId,
                objects: txObjects,
                identityProvider: 0,
                duplicateKeyHash: EMPTY_DUPLICATE_KEY_HASH,
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

    // 取得完了かつ disasterEventId 不一致（not found）
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

    const claimEndLabel =
        selectedPoolView === null
            ? formatClaimWindow(selectedEvent.claimEndMs)
            : (formatDate(selectedPoolView.claimEndMs, locale) ??
              formatClaimWindow(selectedEvent.claimEndMs));
    const affectedCellCountLabel =
        selectedPoolView?.affectedCellCount.toLocaleString() ?? selectedEvent.affectedCellCount;
    const poolBalanceLabel = selectedPoolView?.balanceLabel ?? "-";
    const estimatedReliefLabel =
        proofState.status === "ready"
            ? (() => {
                  const band = parseCellBand(proofState.proof.leaf.cell_band);
                  return band === null
                      ? t("preview.unavailable")
                      : t("preview.amount", { amount: bandAmount(band) });
              })()
            : proofState.status === "blocked" && proofState.code === "outside_affected_area"
              ? t("preview.outsideArea")
              : proofState.status === "checking"
                ? t("preview.checking")
                : t("preview.unavailable");

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <SiteTopbar active="claim" locale={locale} />

                <main className="page claim-page disaster-donate-page claim-detail-page">
                    <header className="claim-hero disaster-hero">
                        <div>
                            <Link className="text-action disaster-breadcrumb" href="/claim">
                                <span aria-hidden="true">‹</span>
                                {t("event.viewEvents")}
                            </Link>
                            {selectedPoolView === null ? null : (
                                <div
                                    className={`disaster-status-badge${
                                        selectedPoolView.status === "active" ? " is-active" : ""
                                    }`}
                                >
                                    <span className="dot" aria-hidden="true" />
                                    <span className="text">
                                        {t(`detail.status.${selectedPoolView.status}`)}
                                    </span>
                                </div>
                            )}
                            <h1>{selectedEvent.title}</h1>
                            <p className="muted">{selectedEvent.region}</p>
                        </div>
                    </header>

                    {renderNotice(configNotice)}
                    {renderNotice(campaignNotice, () => setCampaignReadNonce((value) => value + 1))}

                    <div className="disaster-split">
                        <div className="disaster-split-main">
                            <section
                                className="metrics-strip disaster-metrics-strip"
                                aria-label={selectedEvent.title}
                            >
                                <article className="metric-item">
                                    <div className="label">{t("detail.summaryAffectedCells")}</div>
                                    <div className="value">{affectedCellCountLabel}</div>
                                </article>
                                <article className="metric-item">
                                    <div className="label">{t("detail.summaryDeadline")}</div>
                                    <div className="value">{claimEndLabel}</div>
                                </article>
                                <article className="metric-item">
                                    <div className="label">{t("detail.balanceLabel")}</div>
                                    <div className="value">{poolBalanceLabel}</div>
                                </article>
                            </section>

                            <section
                                className="claim-map-section"
                                aria-labelledby="map-section-title"
                            >
                                <div className="panel-header">
                                    <h2 id="map-section-title">{t("detail.mapTitle")}</h2>
                                </div>
                                {affectedAreaArtifact !== null ? (
                                    <AffectedAreaMap
                                        affectedAreaArtifact={affectedAreaArtifact}
                                        cellSource={{ kind: "deferred" }}
                                        residenceCell={null}
                                    />
                                ) : (
                                    <p className="muted claim-sub">{t("detail.mapUnavailable")}</p>
                                )}
                            </section>
                        </div>

                        <div className="disaster-split-aside claim-detail-aside">
                            <section className="claim-summary-panel">
                                <div className="panel-header compact">
                                    <div>
                                        <div className="eyebrow">{t("preview.eyebrow")}</div>
                                        <h2>{t("preview.title")}</h2>
                                    </div>
                                </div>
                                <div className="claim-preview-list">
                                    <div className="claim-preview-row">
                                        <span>{t("preview.estimatedRelief")}</span>
                                        <strong>{estimatedReliefLabel}</strong>
                                    </div>
                                </div>
                                {renderNotice(passNotice, () =>
                                    setPassReadNonce((value) => value + 1),
                                )}
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
                                {membershipPass !== null && !accountVerified ? (
                                    <div className="claim-inline-notice info" role="status">
                                        <span>{t("status.accountUnverified")}</span>
                                    </div>
                                ) : null}
                                {eligibilityState.status === "loading" ? (
                                    <div className="claim-inline-notice info" role="status">
                                        <span>{t("status.eligibilityLoading")}</span>
                                    </div>
                                ) : null}
                                {eligibilityState.status === "ready" &&
                                claimEligibility?.kind === "none" ? (
                                    <div className="claim-inline-notice info" role="status">
                                        <span>{t("status.notClaimable")}</span>
                                    </div>
                                ) : null}
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
                                {txState.status !== "idle" ? (
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
                                ) : null}
                            </section>
                        </div>
                    </div>
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

function formatClaimWindow(claimEndMs: string): string {
    const value = Number(claimEndMs);
    if (!Number.isSafeInteger(value) || value < 0) {
        return claimEndMs;
    }
    return new Date(value).toISOString().slice(0, 10);
}
