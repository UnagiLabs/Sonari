const DEFAULT_PAGE_SIZE = 1_000;
const MAX_PAGE_SIZE = 1_000;
const DEFAULT_MAX_PAGES = 10_000;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface AuthenticatedEventProofBundle {
    protocol: "sui-authenticated-events-v1";
    stream_id: string;
    event_stream_head_object_id: string;
    start_checkpoint: number;
    end_checkpoint: number;
    highest_indexed_checkpoint: number;
    checkpoint_summary_bcs: string;
    checkpoint_signature_bcs: string;
    event_stream_head: {
        object_id: string;
        version: string;
        digest: string;
        object_bcs: string;
    };
    ocs_proof: {
        leaf_index: number;
        tree_root: string;
        merkle_proof: string[];
    };
    events: AuthenticatedStreamEvent[];
}

export interface AuthenticatedStreamEvent {
    checkpoint: number;
    transaction_index: number;
    event_index: number;
    type: string;
    event_bcs: string;
}

export interface SuiAuthenticatedEventsTransport {
    listAuthenticatedEvents(input: {
        streamId: string;
        startCheckpoint: number;
        endCheckpoint: number;
        pageSize: number;
        pageToken?: string | undefined;
    }): Promise<SuiAuthenticatedEventsPage>;
    getObjectInclusionProof(input: {
        objectId: string;
        checkpoint: number;
    }): Promise<SuiObjectInclusionProofResponse>;
}

export interface SuiAuthenticatedEventsPage {
    events: unknown[];
    highestIndexedCheckpoint: number;
    nextPageToken?: string | undefined;
}

export interface SuiObjectInclusionProofResponse {
    objectRef: {
        objectId: string;
        version: string;
        digest: string;
    };
    objectBcs: string;
    checkpointSummaryBcs: string;
    checkpointSignatureBcs: string;
    inclusionProof: {
        leafIndex: number;
        treeRoot: string;
        merkleProof: string[];
    };
}

export interface AuthenticatedEventProofCollectorOptions {
    pageSize?: number | undefined;
    maxPages?: number | undefined;
}

export class SuiAuthenticatedEventProofCollector {
    private readonly pageSize: number;
    private readonly maxPages: number;

    constructor(
        private readonly transport: SuiAuthenticatedEventsTransport,
        options: AuthenticatedEventProofCollectorOptions = {},
    ) {
        this.pageSize = validatePageSize(options.pageSize ?? DEFAULT_PAGE_SIZE);
        this.maxPages = validateMaxPages(options.maxPages ?? DEFAULT_MAX_PAGES);
    }

    async collect(input: {
        streamId: string;
        eventStreamHeadObjectId: string;
        startCheckpoint: number;
        endCheckpoint: number;
    }): Promise<AuthenticatedEventProofBundle> {
        const streamId = validateObjectId(input.streamId, "stream_id");
        const eventStreamHeadObjectId = validateObjectId(
            input.eventStreamHeadObjectId,
            "event_stream_head_object_id",
        );
        const startCheckpoint = validateSafeInteger(input.startCheckpoint, "start_checkpoint");
        const endCheckpoint = validateSafeInteger(input.endCheckpoint, "end_checkpoint");
        if (endCheckpoint < startCheckpoint) {
            throw new Error("end_checkpoint must be greater than or equal to start_checkpoint");
        }

        const events: AuthenticatedStreamEvent[] = [];
        let highestIndexedCheckpoint = -1;
        let pageToken: string | undefined;
        for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
            const page = await this.transport.listAuthenticatedEvents({
                streamId,
                startCheckpoint,
                endCheckpoint,
                pageSize: this.pageSize,
                pageToken,
            });
            highestIndexedCheckpoint = Math.max(
                highestIndexedCheckpoint,
                validateSafeInteger(page.highestIndexedCheckpoint, "highest_indexed_checkpoint"),
            );
            for (const event of page.events) {
                events.push(parseAuthenticatedEvent(event, startCheckpoint, endCheckpoint));
            }
            pageToken = validateOptionalPageToken(page.nextPageToken);
            if (pageToken === undefined) {
                break;
            }
            if (pageIndex + 1 >= this.maxPages) {
                throw new Error("authenticated event pagination exceeded max_pages");
            }
        }
        if (highestIndexedCheckpoint < endCheckpoint) {
            throw new Error("authenticated event index is behind requested checkpoint");
        }

        const proof = parseObjectInclusionProof(
            await this.transport.getObjectInclusionProof({
                objectId: eventStreamHeadObjectId,
                checkpoint: endCheckpoint,
            }),
            eventStreamHeadObjectId,
        );

        return {
            protocol: "sui-authenticated-events-v1",
            stream_id: streamId,
            event_stream_head_object_id: eventStreamHeadObjectId,
            start_checkpoint: startCheckpoint,
            end_checkpoint: endCheckpoint,
            highest_indexed_checkpoint: highestIndexedCheckpoint,
            checkpoint_summary_bcs: proof.checkpointSummaryBcs,
            checkpoint_signature_bcs: proof.checkpointSignatureBcs,
            event_stream_head: {
                object_id: proof.objectRef.objectId,
                version: proof.objectRef.version,
                digest: proof.objectRef.digest,
                object_bcs: proof.objectBcs,
            },
            ocs_proof: {
                leaf_index: proof.inclusionProof.leafIndex,
                tree_root: proof.inclusionProof.treeRoot,
                merkle_proof: proof.inclusionProof.merkleProof,
            },
            events,
        };
    }
}

function parseAuthenticatedEvent(
    input: unknown,
    startCheckpoint: number,
    endCheckpoint: number,
): AuthenticatedStreamEvent {
    if (!isRecord(input)) {
        throw new Error("authenticated event is malformed");
    }
    if (
        input.checkpoint === undefined ||
        input.transactionIndex === undefined ||
        input.eventIndex === undefined ||
        input.type === undefined ||
        input.eventBcs === undefined
    ) {
        throw new Error("authenticated event is malformed");
    }
    const checkpoint = validateSafeInteger(input.checkpoint, "authenticated event checkpoint");
    if (checkpoint < startCheckpoint || checkpoint > endCheckpoint) {
        throw new Error("authenticated event checkpoint is outside requested range");
    }
    const transactionIndex = validateSafeInteger(
        input.transactionIndex,
        "authenticated event transaction_index",
    );
    const eventIndex = validateSafeInteger(input.eventIndex, "authenticated event event_index");
    const type = readNonEmptyString(input.type, "authenticated event type");
    const eventBcs = validateBase64(input.eventBcs, "authenticated event event_bcs");
    return {
        checkpoint,
        transaction_index: transactionIndex,
        event_index: eventIndex,
        type,
        event_bcs: eventBcs,
    };
}

function parseObjectInclusionProof(
    input: SuiObjectInclusionProofResponse,
    expectedObjectId: string,
): SuiObjectInclusionProofResponse {
    const objectRef = input.objectRef;
    if (!isRecord(objectRef)) {
        throw new Error("EventStreamHead object reference is malformed");
    }
    const objectId = validateObjectId(objectRef.objectId, "EventStreamHead object_id");
    if (objectId !== expectedObjectId) {
        throw new Error("EventStreamHead proof object_id mismatch");
    }
    const version = readCanonicalU64String(objectRef.version, "EventStreamHead object version");
    const digest = validateObjectId(objectRef.digest, "EventStreamHead object digest");
    const objectBcs = validateBase64(input.objectBcs, "EventStreamHead object_bcs");
    const checkpointSummaryBcs = validateBase64(
        input.checkpointSummaryBcs,
        "checkpoint_summary_bcs",
    );
    const checkpointSignatureBcs = validateBase64(
        input.checkpointSignatureBcs,
        "checkpoint_signature_bcs",
    );
    const inclusionProof = input.inclusionProof;
    if (!isRecord(inclusionProof)) {
        throw new Error("EventStreamHead inclusion proof is malformed");
    }
    const leafIndex = validateSafeInteger(inclusionProof.leafIndex, "OCS proof leaf_index");
    const treeRoot = validateObjectId(inclusionProof.treeRoot, "OCS proof tree_root");
    const merkleProof = readBase64Array(inclusionProof.merkleProof, "OCS proof merkle_proof");

    return {
        objectRef: { objectId, version, digest },
        objectBcs,
        checkpointSummaryBcs,
        checkpointSignatureBcs,
        inclusionProof: { leafIndex, treeRoot, merkleProof },
    };
}

function validatePageSize(value: number): number {
    const pageSize = validateSafeInteger(value, "authenticated event page_size");
    if (pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        throw new Error(`authenticated event page_size must be in 1..${MAX_PAGE_SIZE}`);
    }
    return pageSize;
}

function validateMaxPages(value: number): number {
    const maxPages = validateSafeInteger(value, "authenticated event max_pages");
    if (maxPages < 1) {
        throw new Error("authenticated event max_pages must be positive");
    }
    return maxPages;
}

function validateOptionalPageToken(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    return readNonEmptyString(value, "authenticated event next_page_token");
}

function validateObjectId(value: unknown, field: string): string {
    const text = readNonEmptyString(value, field);
    if (!/^0x[0-9a-f]{64}$/.test(text)) {
        throw new Error(`${field} must be a 0x-prefixed 32-byte lowercase hex string`);
    }
    return text;
}

function readCanonicalU64String(value: unknown, field: string): string {
    const text = readNonEmptyString(value, field);
    if (!/^(0|[1-9][0-9]*)$/.test(text)) {
        throw new Error(`${field} must be a canonical decimal u64 string`);
    }
    const parsed = BigInt(text);
    if (parsed > 0xffff_ffff_ffff_ffffn) {
        throw new Error(`${field} must be a canonical decimal u64 string`);
    }
    return text;
}

function validateSafeInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`${field} must be a non-negative safe integer`);
    }
    return Number(value);
}

function validateBase64(value: unknown, field: string): string {
    const text = readNonEmptyString(value, field);
    if (text.length % 4 !== 0 || !BASE64_PATTERN.test(text)) {
        throw new Error(`${field} must be base64-encoded bytes`);
    }
    return text;
}

function readBase64Array(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`${field} must be an array`);
    }
    return value.map((item, index) => validateBase64(item, `${field}[${index}]`));
}

function readNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
