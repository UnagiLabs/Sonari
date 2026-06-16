const U32_MAX = 0xffff_ffff;

export type OnchainRevisionSourceName = "dynamic-field" | "graphql";

export interface OnchainLatestRevisionResult {
    latestRevision: number;
    sources: OnchainRevisionSourceName[];
}

export interface GraphqlLatestRevisionClient {
    query(query: string, variables: Record<string, unknown>): Promise<unknown>;
}

export interface DynamicFieldLatestRevisionClient {
    getLatestRevision(input: { eventUid: string }): Promise<unknown>;
}

export interface OnchainLatestRevisionInput {
    eventUid: string;
    graphql?: GraphqlLatestRevisionClient | undefined;
    dynamicField?: DynamicFieldLatestRevisionClient | undefined;
}

const DISASTER_EVENT_CREATED_QUERY = `
query SonariDisasterEventCreatedRevisions($eventType: String!) {
  events(filter: { eventType: $eventType }) {
    nodes {
      contents {
        json
      }
      parsedJson
    }
  }
}
`;

export async function getLatestOnchainEventRevision(
    input: OnchainLatestRevisionInput,
): Promise<OnchainLatestRevisionResult> {
    assertEventUid(input.eventUid);
    const revisions: number[] = [];
    const sources: OnchainRevisionSourceName[] = [];

    if (input.dynamicField !== undefined) {
        const response = await input.dynamicField.getLatestRevision({ eventUid: input.eventUid });
        const revision = decodeDynamicFieldRevision(response);
        revisions.push(revision);
        sources.push("dynamic-field");
    }

    if (input.graphql !== undefined) {
        const response = await input.graphql.query(DISASTER_EVENT_CREATED_QUERY, {
            eventType: "DisasterEventCreated",
        });
        revisions.push(parseGraphqlLatestRevision(response, input.eventUid));
        sources.push("graphql");
    }

    if (sources.length === 0) {
        throw new Error("on-chain latest revision reader requires at least one source");
    }

    return {
        latestRevision: Math.max(...revisions),
        sources,
    };
}

export function parseGraphqlLatestRevision(response: unknown, eventUid: string): number {
    const nodes = readGraphqlEventNodes(response);
    let latestRevision = 0;
    for (const node of nodes) {
        const revision = parseDisasterEventCreatedRevision(node, eventUid);
        if (revision !== undefined && revision > latestRevision) {
            latestRevision = revision;
        }
    }
    return latestRevision;
}

export function parseDisasterEventCreatedRevision(
    event: unknown,
    eventUid: string,
): number | undefined {
    assertEventUid(eventUid);
    const parsed = readEventJson(event);
    if (parsed === undefined) {
        throw new Error("DisasterEventCreated event is missing parsed JSON");
    }
    const eventRevision = readPositiveU32(parsed.event_revision, "event_revision");
    const actualEventUid = readEventUid(parsed.event_uid);
    if (actualEventUid === undefined) {
        throw new Error("DisasterEventCreated event_uid is missing or malformed");
    }
    if (normalizeHex(actualEventUid) !== normalizeHex(eventUid)) {
        return undefined;
    }
    return eventRevision;
}

export function decodeDynamicFieldRevision(response: unknown): number {
    if (isDynamicFieldNotFound(response)) {
        return 0;
    }
    const data = readRecordField(response, "data");
    if (data === null) {
        return 0;
    }
    const content = readRecordField(data, "content");
    const fields = readRecordField(content, "fields");
    const value = readUnknownField(fields, "value") ?? readUnknownField(fields, "contents");
    if (value === undefined) {
        throw new Error("latest event revision field is missing or malformed");
    }
    return readPositiveU32(value, "latest event revision");
}

function readGraphqlEventNodes(response: unknown): unknown[] {
    const data = readRecordField(response, "data");
    const events = readRecordField(data, "events");
    const nodes = readUnknownField(events, "nodes");
    if (!Array.isArray(nodes)) {
        throw new Error("GraphQL event nodes must be an array");
    }
    return nodes;
}

function readEventJson(event: unknown): Record<string, unknown> | undefined {
    const parsedJson = readRecordField(event, "parsedJson");
    if (parsedJson !== undefined && parsedJson !== null) {
        return parsedJson;
    }
    const contents = readRecordField(event, "contents");
    const json = readRecordField(contents, "json");
    return json === null ? undefined : json;
}

function readPositiveU32(input: unknown, fieldName: string): number {
    const value = readSafeInteger(input);
    if (value === undefined || value <= 0 || value > U32_MAX) {
        throw new Error(`${fieldName} must be a positive u32`);
    }
    return value;
}

function readEventUid(input: unknown): string | undefined {
    if (typeof input === "string") {
        return input;
    }
    if (
        Array.isArray(input) &&
        input.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
        return `0x${Buffer.from(input as number[]).toString("hex")}`;
    }
    return undefined;
}

function isDynamicFieldNotFound(response: unknown): boolean {
    const error = readRecordField(response, "error");
    const code = readStringField(error, "code")?.toLowerCase();
    const message = readStringField(error, "message")?.toLowerCase();
    return (
        code === "dynamicfieldnotfound" ||
        code === "notfound" ||
        message?.includes("dynamic field not found") === true ||
        message?.includes("not found") === true
    );
}

function assertEventUid(value: string): void {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("event_uid must be 0x-prefixed 32-byte hex");
    }
}

function readRecordField(
    input: unknown,
    field: string,
): Record<string, unknown> | null | undefined {
    const value = readUnknownField(input, field);
    if (value === null) {
        return null;
    }
    return typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function readUnknownField(input: unknown, field: string): unknown {
    return typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)[field]
        : undefined;
}

function readStringField(input: unknown, field: string): string | undefined {
    const value = readUnknownField(input, field);
    return typeof value === "string" ? value : undefined;
}

function readSafeInteger(input: unknown): number | undefined {
    if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0) {
        return input;
    }
    if (typeof input === "string" && /^(0|[1-9][0-9]*)$/.test(input)) {
        const value = Number(input);
        return Number.isSafeInteger(value) ? value : undefined;
    }
    return undefined;
}

function normalizeHex(value: string): string {
    return value.startsWith("0x") ? value.slice(2).toLowerCase() : value.toLowerCase();
}
