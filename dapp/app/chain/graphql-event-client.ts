import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { readWalletNetwork, type WalletNetwork } from "../wallet/wallet-network";

const DEFAULT_PAGE_LIMIT = 50;

const EVENTS_QUERY = `
    query MoveEvents($type: String!, $last: Int!, $before: String) {
        events(filter: { type: $type }, last: $last, before: $before) {
            nodes {
                contents { json }
                timestamp
                transaction { digest }
                sequenceNumber
            }
            pageInfo {
                hasPreviousPage
                startCursor
            }
        }
    }
`;

export interface MoveEvent {
    readonly id: string;
    readonly timestampMs: number;
    readonly json: Record<string, unknown>;
}

export interface MoveEventPage {
    readonly data: readonly MoveEvent[];
    readonly hasNextPage?: boolean;
    readonly nextCursor?: string | null;
}

export interface MoveEventQueryClient {
    queryMoveEvents(input: {
        readonly type: string;
        readonly cursor?: string | null;
        readonly limit?: number;
    }): Promise<MoveEventPage>;
}

export interface GraphqlEventClientOptions {
    readonly network?: WalletNetwork;
    readonly graphqlUrl?: string;
    readonly fetch?: typeof fetch;
}

export function resolveGraphqlEventClientConfig(
    options: Omit<GraphqlEventClientOptions, "fetch"> = {},
): { readonly network: WalletNetwork; readonly url: string } {
    const network = options.network ?? readWalletNetwork();
    const override = (
        options.graphqlUrl ??
        process.env.NEXT_PUBLIC_SONARI_GRAPHQL_URL ??
        ""
    ).trim();
    return {
        network,
        url: override.length > 0 ? override : defaultGraphqlUrl(network),
    };
}

export function createGraphqlEventClient(
    options: GraphqlEventClientOptions = {},
): MoveEventQueryClient {
    const config = resolveGraphqlEventClientConfig(options);
    const client = new SuiGraphQLClient({
        network: config.network,
        url: config.url,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });

    return {
        async queryMoveEvents(input): Promise<MoveEventPage> {
            const requestedLimit = input.limit ?? DEFAULT_PAGE_LIMIT;
            if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
                throw new Error("GraphQL event query limit must be a positive integer.");
            }
            const result = await client.query({
                query: EVENTS_QUERY,
                variables: {
                    type: input.type,
                    last: Math.min(requestedLimit, DEFAULT_PAGE_LIMIT),
                    before: input.cursor ?? null,
                },
            });
            if (result.errors !== undefined && result.errors.length > 0) {
                throw new Error(
                    `GraphQL event query failed: ${result.errors.map((error) => error.message).join("; ")}`,
                );
            }
            return parseEventPage(result.data);
        },
    };
}

function defaultGraphqlUrl(network: WalletNetwork): string {
    switch (network) {
        case "mainnet":
            return "https://graphql.mainnet.sui.io/graphql";
        case "testnet":
            return "https://graphql.testnet.sui.io/graphql";
        case "localnet":
            return "http://127.0.0.1:9125/graphql";
    }
}

function parseEventPage(value: unknown): MoveEventPage {
    const events = isRecord(value) ? value.events : undefined;
    const nodes = isRecord(events) ? events.nodes : undefined;
    const pageInfo = isRecord(events) ? events.pageInfo : undefined;
    if (!Array.isArray(nodes) || !isRecord(pageInfo)) {
        throw malformedResponse();
    }

    const hasNextPage = pageInfo.hasPreviousPage;
    const nextCursor = pageInfo.startCursor;
    if (
        typeof hasNextPage !== "boolean" ||
        (nextCursor !== null && typeof nextCursor !== "string") ||
        (hasNextPage && (typeof nextCursor !== "string" || nextCursor.length === 0))
    ) {
        throw malformedResponse();
    }

    const data = nodes.map(parseEventNode).reverse();
    return { data, hasNextPage, nextCursor };
}

function parseEventNode(value: unknown): MoveEvent {
    if (!isRecord(value)) {
        throw malformedResponse();
    }
    const contents = value.contents;
    const transaction = value.transaction;
    const timestamp = value.timestamp;
    const sequenceNumber = value.sequenceNumber;
    if (
        !isRecord(contents) ||
        !isRecord(contents.json) ||
        !isRecord(transaction) ||
        typeof transaction.digest !== "string" ||
        transaction.digest.length === 0 ||
        typeof timestamp !== "string" ||
        !Number.isSafeInteger(sequenceNumber) ||
        (sequenceNumber as number) < 0
    ) {
        throw malformedResponse();
    }
    const timestampMs = Date.parse(timestamp);
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
        throw malformedResponse();
    }
    return {
        id: `${transaction.digest}:${sequenceNumber}`,
        timestampMs,
        json: contents.json,
    };
}

function malformedResponse(): Error {
    return new Error("Malformed GraphQL event response.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
