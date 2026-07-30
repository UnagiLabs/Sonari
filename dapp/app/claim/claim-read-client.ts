// ---------------------------------------------------------------------------
// claim-read-client: claim 系の読み取りクライアント（ハイブリッド）
//
// 背景:
//   アプリの dApp Kit クライアントは gRPC（SuiGrpcClient）。gRPC には
//   イベント検索と type 指定の object listing が無い。一方 claim のキャンペーン発見は
//   CampaignCreated イベント検索と Campaign object listing の移行口を必要としている。
//   そのため gRPC クライアントをそのまま渡すと読み取りが失敗する（描画時に throw していた）。
//
// 方針（A）:
//   - イベント検索と type 指定の object listing は GraphQL クライアントへ回す。
//   - getObjects / listOwnedObjects は gRPC クライアントをそのまま使う
//     （形は ClaimCampaignReadClient / MembershipPassReadClient と一致するため
//     変換不要・既存パーサに影響しない）。
//
// SSR 安全性:
//   構築時には throw しない。SSR ではクライアントが未準備のことがあるため、
//   実メソッドの存在チェックは「呼び出し時（effect・クライアント側）」に行う。
//   これにより未準備でも 500 にせず、ローディング表示のまま hydration できる。
//
// 将来（B）:
//   コントラクトにキャンペーン登録簿を追加できれば、gRPC の listDynamicFields 等で
//   発見できるようになり GraphQL の discovery query を外せる。その際の差し替え口はこの 1 ファイル。
// ---------------------------------------------------------------------------

import {
    createGraphqlEventClient,
    type ObjectListingQueryClient,
} from "../chain/graphql-event-client";
import type { MembershipPassReadClient } from "../mypage/membership-pass-read";
import type { ClaimCampaignReadClient } from "./claim-campaigns";

/** claim のビューが必要とする読み取りクライアント（campaign + membership pass）。 */
export type ClaimReadClient = ClaimCampaignReadClient &
    MembershipPassReadClient &
    ObjectListingQueryClient;

/** GraphQL discovery query を提供する最小クライアント（テストで差し替え可能にするため）。 */
export interface EventQueryClient extends ObjectListingQueryClient {
    readonly queryMoveEvents: ClaimCampaignReadClient["queryMoveEvents"];
}

const eventClient = createGraphqlEventClient();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * gRPC クライアントのメソッドを呼び出し時に解決する。
 * 構築時ではなく呼び出し時に検証することで、SSR 未準備でも描画を止めない。
 */
function callGrpcMethod(client: unknown, name: "getObjects" | "listOwnedObjects", input: unknown) {
    if (!isRecord(client)) {
        throw new Error("Sui client is not available.");
    }
    const fn = client[name];
    if (typeof fn !== "function") {
        throw new Error(`Sui client does not support ${name}.`);
    }
    // Function.prototype.call は any を返す。既存の read client adapter と同じ流儀で、
    // 呼び出し側のインターフェース型（Promise<...>）へそのまま委譲する。
    return fn.call(client, input);
}

/**
 * claim 読み取りクライアントを組み立てる。
 *
 * @param grpcClient dApp Kit の現在クライアント（gRPC）。`unknown` で受け、呼び出し時に検証する。
 * @param eventQueryClient discovery query クライアント（既定は GraphQL）。テストで差し替え可能。
 */
export function createClaimReadClient(
    grpcClient: unknown,
    eventQueryClient: EventQueryClient = eventClient,
): ClaimReadClient {
    return {
        queryMoveEvents: (input) => eventQueryClient.queryMoveEvents(input),
        queryObjectsByType: (input) => eventQueryClient.queryObjectsByType(input),
        // async にして、未準備 grpc の検証失敗を sync throw でなく reject にする
        // （呼び出し側は await + try/catch のため、どちらでも安全だが reject が素直）。
        getObjects: async (input) => callGrpcMethod(grpcClient, "getObjects", input),
        listOwnedObjects: async (input) => callGrpcMethod(grpcClient, "listOwnedObjects", input),
    };
}
