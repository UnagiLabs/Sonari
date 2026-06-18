"use client";

import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { useEffect, useMemo, useState } from "react";
import {
    type ClaimCampaignReadClient,
    type ClaimCampaignState,
    readClaimCampaigns,
} from "./claim/claim-campaigns";
import { readClaimConfig } from "./claim/claim-config";
import { createJsonRpcEventClient } from "./chain/json-rpc-event-client";
import { resolveMembershipDappGenesisObjects } from "./chain/genesis-objects";
import { type ClaimBannerCta, selectClaimBannerCta } from "./home-claim-banner-state";
import { type MembershipPassReadClient, readMembershipPass } from "./mypage/membership-pass-read";

// 受け取り判定に必要な読み取りは、campaign 取得（queryEvents/getObjects）と登録判定
// （listOwnedObjects/getObjects）の両方を使う。claim 画面と同じく、両者を満たす
// 1 つの read client にまとめて扱う。
type HomeBannerReadClient = ClaimCampaignReadClient & MembershipPassReadClient;

// 受け取り判定の入力になる「登録済みか」「キャンペーン一覧」をまとめて保持する。
interface ClaimBannerData {
    readonly registered: boolean;
    readonly campaigns: readonly ClaimCampaignState[];
}

const EMPTY_DATA: ClaimBannerData = { registered: false, campaigns: [] };

/**
 * Home 災害バナーに「受け取る」CTA を出すかを判定するフック。
 *
 * 見るのは「ウォレット接続済み」「MembershipPass 登録済み」「claim window が開いて
 * いるキャンペーンがある」の軽い 3 条件だけ。被災セル単位の可否（Merkle proof が
 * 必要な重い判定）は扱わず、最終判定は Claim 画面へ委ねる。
 *
 * 未接続・設定不備・読み込み中・読み取り失敗のときは fail-close で null を返し、
 * 受け取りボタンを出さない。寄付バナーの表示判定とは独立して動く。
 */
export function useClaimBannerCta(): ClaimBannerCta | null {
    const account = useCurrentAccount();
    const suiClient = useCurrentClient();
    const owner = account?.address ?? "";
    const connected = account !== null;
    // env 由来の設定は描画ごとに変わらないため 1 度だけ解決する。
    const configResult = useMemo(() => readClaimConfig(), []);
    const [data, setData] = useState<ClaimBannerData>(EMPTY_DATA);

    useEffect(() => {
        if (!connected || owner.length === 0 || configResult.kind !== "ok") {
            setData(EMPTY_DATA);
            return;
        }

        const config = configResult.config;
        let cancelled = false;

        void (async () => {
            try {
                const client = toHomeBannerReadClient(suiClient);
                const genesisObjects = await resolveMembershipDappGenesisObjects(client, {
                    packageId: config.packageId,
                });
                if (genesisObjects.kind !== "ok") {
                    if (!cancelled) {
                        setData(EMPTY_DATA);
                    }
                    return;
                }
                const [pass, campaigns] = await Promise.all([
                    readMembershipPass(
                        client,
                        owner,
                        config.packageId,
                        genesisObjects.objects.identityRegistry,
                    ),
                    readClaimCampaigns(client, {
                        packageId: config.packageId,
                        nowMs: Date.now(),
                    }),
                ]);
                if (cancelled) {
                    return;
                }
                setData({
                    registered: pass.kind === "ok",
                    campaigns: campaigns.kind === "ok" ? campaigns.campaigns : [],
                });
            } catch {
                // 受け取り判定は付加的な導線のため、失敗時は黙って非表示にする。
                if (!cancelled) {
                    setData(EMPTY_DATA);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [connected, owner, suiClient, configResult]);

    return selectClaimBannerCta({
        walletConnected: connected,
        registered: data.registered,
        campaigns: data.campaigns,
    });
}

// queryEvents は JSON-RPC event client へ回し、object 読み取りは dapp-kit の
// Sui client へ委譲する。dapp-kit メソッドの this を保つため call で束ねる。
function toHomeBannerReadClient(client: unknown): HomeBannerReadClient {
    if (typeof client !== "object" || client === null) {
        throw new Error("Sui client is not available.");
    }
    const record = client as Record<string, unknown>;
    const getObjects = record.getObjects;
    const listOwnedObjects = record.listOwnedObjects;
    if (typeof getObjects !== "function" || typeof listOwnedObjects !== "function") {
        throw new Error("Sui client does not support required claim reads.");
    }
    const eventClient = createJsonRpcEventClient();
    return {
        queryEvents: (input) => eventClient.queryEvents(input),
        getObjects: (input) => getObjects.call(client, input),
        listOwnedObjects: (input) => listOwnedObjects.call(client, input),
    };
}
