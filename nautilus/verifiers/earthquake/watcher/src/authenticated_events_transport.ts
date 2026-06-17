import { fromBase64, toBase58, toBase64 } from "@mysten/sui/utils";
import type {
    SuiAuthenticatedEventsPage,
    SuiAuthenticatedEventsTransport,
    SuiObjectInclusionProofResponse,
} from "./authenticated_events.js";

/**
 * Production transport for Sui authenticated event stream proofs.
 *
 * Trust boundary note: this watcher-side transport only *collects* unverified
 * candidate proof material. The Census TEE re-validates every byte (validator
 * committee trust root, checkpoint signature, OCS commitment, EventStreamHead
 * object identity, authenticated event replay). The transport therefore favours
 * faithful, deterministic mapping over any interpretation of the data.
 *
 * The alpha `EventService` / `ProofService` RPCs are not exposed by the
 * generated `@mysten/sui` gRPC client, so they are called over gRPC-web with a
 * minimal hand-rolled protobuf codec scoped to exactly the request/response
 * messages we need. The committee and checkpoint signature are not part of the
 * inclusion-proof response, so they are recomposed from the v2 `LedgerService`
 * (`GetCheckpoint` / `GetEpoch`) into the canonical `sui_sdk_types` BCS that the
 * TEE deserializes. The BCS layouts are pinned by golden cross-language tests.
 */

const ALPHA_EVENT_SERVICE_PATH = "sui.rpc.alpha.EventService/ListAuthenticatedEvents";
const ALPHA_PROOF_SERVICE_PATH = "sui.rpc.alpha.ProofService/GetObjectInclusionProof";
const GRPC_WEB_CONTENT_TYPE = "application/grpc-web+proto";
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;
const BLS_PUBLIC_KEY_LENGTH = 96;
const BLS_SIGNATURE_LENGTH = 48;
const OCS_TREE_ROOT_LENGTH = 32;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

/** Fetched validator committee for a single epoch. */
export interface SuiEpochCommittee {
    epoch: bigint;
    members: ReadonlyArray<{ publicKey: Uint8Array; stake: bigint }>;
}

/** Fetched aggregated checkpoint signature. */
export interface SuiCheckpointSignature {
    epoch: bigint;
    signature: Uint8Array;
    bitmap: Uint8Array;
}

/**
 * Source of v2 ledger data needed to recompose the committee and checkpoint
 * signature BCS. Injected so the transport can be unit tested without a live
 * gRPC endpoint.
 */
export interface SuiCheckpointLedgerClient {
    getCheckpointSignature(sequenceNumber: number): Promise<SuiCheckpointSignature>;
    getEpochCommittee(epoch: bigint): Promise<SuiEpochCommittee>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SuiAlphaAuthenticatedEventsTransportOptions {
    grpcUrl: string;
    ledger: SuiCheckpointLedgerClient;
    fetchImpl?: FetchLike | undefined;
    sleepImpl?: ((ms: number) => Promise<void>) | undefined;
    maxAttempts?: number | undefined;
}

export class SuiAlphaAuthenticatedEventsTransport implements SuiAuthenticatedEventsTransport {
    private readonly baseUrl: string;
    private readonly ledger: SuiCheckpointLedgerClient;
    private readonly fetchImpl: FetchLike;
    private readonly sleepImpl: (ms: number) => Promise<void>;
    private readonly maxAttempts: number;

    constructor(options: SuiAlphaAuthenticatedEventsTransportOptions) {
        this.baseUrl = normalizeGrpcBaseUrl(options.grpcUrl);
        this.ledger = options.ledger;
        this.fetchImpl = options.fetchImpl ?? defaultFetch;
        this.sleepImpl = options.sleepImpl ?? defaultSleep;
        this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    }

    async listAuthenticatedEvents(input: {
        streamId: string;
        startCheckpoint: number;
        endCheckpoint: number;
        pageSize: number;
        pageToken?: string | undefined;
    }): Promise<SuiAuthenticatedEventsPage> {
        const request = encodeListAuthenticatedEventsRequest({
            streamId: input.streamId,
            startCheckpoint: input.startCheckpoint,
            pageSize: input.pageSize,
            pageToken: input.pageToken,
        });
        const response = await this.unary(ALPHA_EVENT_SERVICE_PATH, request);
        return decodeListAuthenticatedEventsResponse(response);
    }

    async getObjectInclusionProof(input: {
        objectId: string;
        checkpoint: number;
    }): Promise<SuiObjectInclusionProofResponse> {
        const request = encodeGetObjectInclusionProofRequest(input);
        const response = await this.unary(ALPHA_PROOF_SERVICE_PATH, request);
        const proof = decodeGetObjectInclusionProofResponse(response);

        const signature = await this.ledger.getCheckpointSignature(input.checkpoint);
        const committee = await this.ledger.getEpochCommittee(signature.epoch);

        return {
            objectRef: proof.objectRef,
            objectBcs: toBase64(proof.objectData),
            validatorCommitteeBcs: toBase64(encodeValidatorCommitteeBcs(committee)),
            checkpointSummaryBcs: toBase64(proof.checkpointSummary),
            checkpointSignatureBcs: toBase64(encodeCheckpointSignatureBcs(signature)),
            inclusionProof: {
                leafIndex: proof.inclusionProof.leafIndex,
                treeRoot: toBase58(proof.inclusionProof.treeRoot),
                merkleProof: decodeMerkleProofNodes(proof.inclusionProof.merkleProof),
            },
        };
    }

    private async unary(path: string, requestMessage: Uint8Array): Promise<Uint8Array> {
        const url = `${this.baseUrl}/${path}`;
        const body = frameGrpcWebMessage(requestMessage);
        let lastError: Error | undefined;
        for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
            try {
                return await this.unaryOnce(url, path, body);
            } catch (error) {
                const normalized = error instanceof Error ? error : new Error(String(error));
                if (!isRetryableTransportError(normalized) || attempt + 1 >= this.maxAttempts) {
                    throw normalized;
                }
                lastError = normalized;
                await this.sleepImpl(RETRY_BASE_DELAY_MS * 2 ** attempt);
            }
        }
        throw lastError ?? new Error(`gRPC ${path} retry attempts exhausted`);
    }

    private async unaryOnce(url: string, path: string, body: Uint8Array): Promise<Uint8Array> {
        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                method: "POST",
                headers: {
                    "content-type": GRPC_WEB_CONTENT_TYPE,
                    accept: GRPC_WEB_CONTENT_TYPE,
                    "x-grpc-web": "1",
                },
                body,
            });
        } catch (error) {
            throw new RetryableTransportError(`gRPC ${path} failed with network error`, {
                cause: error,
            });
        }
        if (!response.ok) {
            const message = `gRPC ${path} failed with HTTP ${response.status}`;
            if (isRetryableHttpStatus(response.status)) {
                throw new RetryableTransportError(message);
            }
            throw new Error(message);
        }
        const headerStatus = response.headers.get("grpc-status");
        const headerMessage = response.headers.get("grpc-message");
        const payload = new Uint8Array(await response.arrayBuffer());
        const frames = parseGrpcWebFrames(payload);
        const status = frames.trailerStatus ?? headerStatus ?? (frames.message ? "0" : null);
        if (status !== "0" && status !== null) {
            const detail = decodeGrpcMessage(frames.trailerMessage ?? headerMessage);
            const message = `gRPC ${path} failed: status ${status}${detail ? ` ${detail}` : ""}`;
            if (isRetryableGrpcStatus(status)) {
                throw new RetryableTransportError(message);
            }
            throw new Error(message);
        }
        if (frames.message === undefined) {
            throw new Error(`gRPC ${path} returned an empty response`);
        }
        return frames.message;
    }
}

/**
 * Adapter that backs {@link SuiCheckpointLedgerClient} with the v2 gRPC
 * `LedgerService` already used elsewhere in the runner.
 */
export interface LedgerServiceLike {
    getCheckpoint(input: {
        checkpointId: { oneofKind: "sequenceNumber"; sequenceNumber: bigint };
        readMask?: { paths: string[] } | undefined;
    }): { response: Promise<unknown> };
    getEpoch(input: { epoch: bigint; readMask?: { paths: string[] } | undefined }): {
        response: Promise<unknown>;
    };
}

export function createGrpcCheckpointLedgerClient(
    ledgerService: LedgerServiceLike,
): SuiCheckpointLedgerClient {
    return {
        async getCheckpointSignature(sequenceNumber: number): Promise<SuiCheckpointSignature> {
            const response = await ledgerService.getCheckpoint({
                checkpointId: {
                    oneofKind: "sequenceNumber",
                    sequenceNumber: BigInt(sequenceNumber),
                },
                readMask: { paths: ["signature"] },
            }).response;
            const checkpoint = readRecord(response, "checkpoint");
            const signature = readRecord(checkpoint, "signature");
            if (signature === undefined) {
                throw new Error("GetCheckpoint response is missing a validator signature");
            }
            return {
                epoch: readBigintField(signature, "epoch", "checkpoint signature epoch"),
                signature: readBytesField(signature, "signature", "checkpoint signature bytes"),
                bitmap: readBytesField(signature, "bitmap", "checkpoint signature bitmap"),
            };
        },
        async getEpochCommittee(epoch: bigint): Promise<SuiEpochCommittee> {
            const response = await ledgerService.getEpoch({
                epoch,
                readMask: { paths: ["committee"] },
            }).response;
            const epochRecord = readRecord(response, "epoch");
            const committee = readRecord(epochRecord, "committee");
            if (committee === undefined) {
                throw new Error("GetEpoch response is missing a validator committee");
            }
            const membersValue = (committee as Record<string, unknown>).members;
            if (!Array.isArray(membersValue)) {
                throw new Error("GetEpoch validator committee is missing members");
            }
            const members = membersValue.map((member) => ({
                publicKey: readBytesField(member, "publicKey", "committee member public key"),
                stake: readBigintField(member, "weight", "committee member voting weight"),
            }));
            return {
                epoch: readBigintField(committee, "epoch", "committee epoch"),
                members,
            };
        },
    };
}

// --- canonical sui_sdk_types BCS reconstruction --------------------------------

/**
 * BCS of `sui_sdk_types::ValidatorCommittee`:
 *   u64 epoch | uleb(len) members | member: bytes(bls-pk-96) u64 stake
 * Each Bls12381 public key serializes through `serde_with::Bytes`, i.e. with a
 * uleb length prefix; the stake/weight is a plain u64.
 */
export function encodeValidatorCommitteeBcs(committee: SuiEpochCommittee): Uint8Array {
    const writer = new ByteWriter();
    writer.writeU64(checkedU64(committee.epoch, "validator committee epoch"));
    writer.writeUleb(committee.members.length);
    for (const member of committee.members) {
        if (member.publicKey.length !== BLS_PUBLIC_KEY_LENGTH) {
            throw new Error(
                `validator committee member public key must be ${BLS_PUBLIC_KEY_LENGTH} bytes`,
            );
        }
        writer.writeUleb(member.publicKey.length);
        writer.writeBytes(member.publicKey);
        writer.writeU64(checkedU64(member.stake, "validator committee member stake"));
    }
    return writer.toBytes();
}

/**
 * BCS of `sui_sdk_types::ValidatorAggregatedSignature`:
 *   u64 epoch | bls-signature-48 (fixed, no length prefix) | bytes(roaring bitmap)
 * The 48-byte signature serializes as a fixed array (`[Same; 48]`, no prefix);
 * the roaring bitmap serializes through `serde_with::Bytes` (uleb length prefix).
 */
export function encodeCheckpointSignatureBcs(signature: SuiCheckpointSignature): Uint8Array {
    if (signature.signature.length !== BLS_SIGNATURE_LENGTH) {
        throw new Error(`checkpoint signature must be ${BLS_SIGNATURE_LENGTH} bytes`);
    }
    const writer = new ByteWriter();
    writer.writeU64(checkedU64(signature.epoch, "checkpoint signature epoch"));
    writer.writeBytes(signature.signature);
    writer.writeUleb(signature.bitmap.length);
    writer.writeBytes(signature.bitmap);
    return writer.toBytes();
}

/**
 * The OCS inclusion proof arrives as a single BCS-encoded `vector<vector<u8>>`
 * of merkle nodes. The Census TEE does not currently verify the OCS merkle path
 * (it relies on the checkpoint commitment of the tree root plus authenticated
 * event replay), so this only needs to faithfully surface well-formed base64
 * nodes. A blob that does not decode cleanly is passed through as a single node.
 */
function decodeMerkleProofNodes(merkleProof: Uint8Array): string[] {
    if (merkleProof.length === 0) {
        return [];
    }
    const nodes = tryDecodeBcsByteVectors(merkleProof);
    if (nodes === undefined) {
        return [toBase64(merkleProof)];
    }
    return nodes.map((node) => toBase64(node));
}

function tryDecodeBcsByteVectors(bytes: Uint8Array): Uint8Array[] | undefined {
    try {
        const reader = new ByteReader(bytes);
        const count = reader.readUleb();
        const nodes: Uint8Array[] = [];
        for (let i = 0; i < count; i += 1) {
            const length = reader.readUleb();
            nodes.push(reader.readBytes(length));
        }
        if (!reader.isExhausted()) {
            return undefined;
        }
        return nodes;
    } catch {
        return undefined;
    }
}

// --- alpha request encoders ----------------------------------------------------

function encodeListAuthenticatedEventsRequest(input: {
    streamId: string;
    startCheckpoint: number;
    pageSize: number;
    pageToken?: string | undefined;
}): Uint8Array {
    const writer = new ByteWriter();
    writeStringField(writer, 1, input.streamId);
    writeVarintField(writer, 2, BigInt(input.startCheckpoint));
    writeVarintField(writer, 3, BigInt(input.pageSize));
    if (input.pageToken !== undefined && input.pageToken.length > 0) {
        writeBytesField(writer, 4, fromBase64(input.pageToken));
    }
    return writer.toBytes();
}

function encodeGetObjectInclusionProofRequest(input: {
    objectId: string;
    checkpoint: number;
}): Uint8Array {
    const writer = new ByteWriter();
    writeStringField(writer, 1, input.objectId);
    writeVarintField(writer, 2, BigInt(input.checkpoint));
    return writer.toBytes();
}

// --- alpha response decoders ---------------------------------------------------

function decodeListAuthenticatedEventsResponse(bytes: Uint8Array): SuiAuthenticatedEventsPage {
    const reader = new ByteReader(bytes);
    const events: unknown[] = [];
    let highestIndexedCheckpoint = 0;
    let nextPageToken: string | undefined;
    while (!reader.isExhausted()) {
        const tag = reader.readTag();
        if (tag.field === 1 && tag.wireType === 2) {
            events.push(decodeAuthenticatedEvent(reader.readLengthDelimited()));
        } else if (tag.field === 2 && tag.wireType === 0) {
            highestIndexedCheckpoint = bigintToSafeNumber(
                reader.readVarint(),
                "highest_indexed_checkpoint",
            );
        } else if (tag.field === 3 && tag.wireType === 2) {
            const token = reader.readLengthDelimited();
            nextPageToken = token.length === 0 ? undefined : toBase64(token);
        } else {
            reader.skipField(tag.wireType);
        }
    }
    return { events, highestIndexedCheckpoint, nextPageToken };
}

function decodeAuthenticatedEvent(bytes: Uint8Array): {
    checkpoint: number;
    transactionIndex: number;
    eventIndex: number;
    type: string;
    eventBcs: string;
} {
    const reader = new ByteReader(bytes);
    let checkpoint = 0;
    let transactionIndex = 0;
    let eventIndex = 0;
    let eventType = "";
    let eventBcs = "";
    while (!reader.isExhausted()) {
        const tag = reader.readTag();
        if (tag.field === 1 && tag.wireType === 0) {
            checkpoint = bigintToSafeNumber(reader.readVarint(), "authenticated event checkpoint");
        } else if (tag.field === 3 && tag.wireType === 0) {
            transactionIndex = bigintToSafeNumber(
                reader.readVarint(),
                "authenticated event transaction_idx",
            );
        } else if (tag.field === 4 && tag.wireType === 0) {
            eventIndex = bigintToSafeNumber(reader.readVarint(), "authenticated event event_idx");
        } else if (tag.field === 5 && tag.wireType === 2) {
            const decoded = decodeV2Event(reader.readLengthDelimited());
            eventType = decoded.eventType;
            eventBcs = decoded.contentsBase64;
        } else {
            reader.skipField(tag.wireType);
        }
    }
    return { checkpoint, transactionIndex, eventIndex, type: eventType, eventBcs };
}

function decodeV2Event(bytes: Uint8Array): { eventType: string; contentsBase64: string } {
    const reader = new ByteReader(bytes);
    let eventType = "";
    let contentsBase64 = "";
    while (!reader.isExhausted()) {
        const tag = reader.readTag();
        if (tag.field === 4 && tag.wireType === 2) {
            eventType = decodeUtf8(reader.readLengthDelimited());
        } else if (tag.field === 5 && tag.wireType === 2) {
            contentsBase64 = toBase64(decodeBcsMessageValue(reader.readLengthDelimited()));
        } else {
            reader.skipField(tag.wireType);
        }
    }
    return { eventType, contentsBase64 };
}

function decodeBcsMessageValue(bytes: Uint8Array): Uint8Array {
    const reader = new ByteReader(bytes);
    let value = new Uint8Array(0);
    while (!reader.isExhausted()) {
        const tag = reader.readTag();
        if (tag.field === 2 && tag.wireType === 2) {
            value = reader.readLengthDelimited();
        } else {
            reader.skipField(tag.wireType);
        }
    }
    return value;
}

function decodeGetObjectInclusionProofResponse(bytes: Uint8Array): {
    objectRef: { objectId: string; version: string; digest: string };
    objectData: Uint8Array;
    checkpointSummary: Uint8Array;
    inclusionProof: { leafIndex: number; treeRoot: Uint8Array; merkleProof: Uint8Array };
} {
    const reader = new ByteReader(bytes);
    let objectRef: { objectId: string; version: string; digest: string } | undefined;
    let inclusionProof:
        | { leafIndex: number; treeRoot: Uint8Array; merkleProof: Uint8Array }
        | undefined;
    let objectData = new Uint8Array(0);
    let checkpointSummary = new Uint8Array(0);
    while (!reader.isExhausted()) {
        const tag = reader.readTag();
        if (tag.field === 1 && tag.wireType === 2) {
            objectRef = decodeObjectReference(reader.readLengthDelimited());
        } else if (tag.field === 2 && tag.wireType === 2) {
            inclusionProof = decodeOcsInclusionProof(reader.readLengthDelimited());
        } else if (tag.field === 3 && tag.wireType === 2) {
            objectData = reader.readLengthDelimited();
        } else if (tag.field === 4 && tag.wireType === 2) {
            checkpointSummary = reader.readLengthDelimited();
        } else {
            reader.skipField(tag.wireType);
        }
    }
    if (objectRef === undefined) {
        throw new Error("object inclusion proof is missing an object reference");
    }
    if (inclusionProof === undefined) {
        throw new Error("object inclusion proof is missing an OCS inclusion proof");
    }
    if (objectData.length === 0) {
        throw new Error("object inclusion proof is missing object data");
    }
    if (checkpointSummary.length === 0) {
        throw new Error("object inclusion proof is missing a checkpoint summary");
    }
    return { objectRef, objectData, checkpointSummary, inclusionProof };
}

function decodeObjectReference(bytes: Uint8Array): {
    objectId: string;
    version: string;
    digest: string;
} {
    const reader = new ByteReader(bytes);
    let objectId = "";
    let version = "0";
    let digest = "";
    while (!reader.isExhausted()) {
        const tag = reader.readTag();
        if (tag.field === 1 && tag.wireType === 2) {
            objectId = decodeUtf8(reader.readLengthDelimited());
        } else if (tag.field === 2 && tag.wireType === 0) {
            version = reader.readVarint().toString();
        } else if (tag.field === 3 && tag.wireType === 2) {
            digest = decodeUtf8(reader.readLengthDelimited());
        } else {
            reader.skipField(tag.wireType);
        }
    }
    return { objectId, version, digest };
}

function decodeOcsInclusionProof(bytes: Uint8Array): {
    leafIndex: number;
    treeRoot: Uint8Array;
    merkleProof: Uint8Array;
} {
    const reader = new ByteReader(bytes);
    let merkleProof = new Uint8Array(0);
    let leafIndex = 0;
    let treeRoot = new Uint8Array(0);
    while (!reader.isExhausted()) {
        const tag = reader.readTag();
        if (tag.field === 1 && tag.wireType === 2) {
            merkleProof = reader.readLengthDelimited();
        } else if (tag.field === 2 && tag.wireType === 0) {
            leafIndex = bigintToSafeNumber(reader.readVarint(), "OCS proof leaf_index");
        } else if (tag.field === 3 && tag.wireType === 2) {
            treeRoot = reader.readLengthDelimited();
        } else {
            reader.skipField(tag.wireType);
        }
    }
    if (treeRoot.length !== OCS_TREE_ROOT_LENGTH) {
        throw new Error(`OCS proof tree_root must be ${OCS_TREE_ROOT_LENGTH} bytes`);
    }
    return { leafIndex, treeRoot, merkleProof };
}

// --- gRPC-web framing ----------------------------------------------------------

function frameGrpcWebMessage(message: Uint8Array): Uint8Array {
    const framed = new Uint8Array(5 + message.length);
    framed[0] = 0;
    framed[1] = (message.length >>> 24) & 0xff;
    framed[2] = (message.length >>> 16) & 0xff;
    framed[3] = (message.length >>> 8) & 0xff;
    framed[4] = message.length & 0xff;
    framed.set(message, 5);
    return framed;
}

function parseGrpcWebFrames(payload: Uint8Array): {
    message: Uint8Array | undefined;
    trailerStatus: string | null;
    trailerMessage: string | null;
} {
    let message: Uint8Array | undefined;
    let trailerStatus: string | null = null;
    let trailerMessage: string | null = null;
    let offset = 0;
    while (offset + 5 <= payload.length) {
        const flag = payload[offset] ?? 0;
        const length =
            ((payload[offset + 1] ?? 0) << 24) |
            ((payload[offset + 2] ?? 0) << 16) |
            ((payload[offset + 3] ?? 0) << 8) |
            (payload[offset + 4] ?? 0);
        const start = offset + 5;
        const end = start + length;
        if (end > payload.length) {
            break;
        }
        const frame = payload.subarray(start, end);
        if ((flag & 0x80) !== 0) {
            const trailer = parseGrpcTrailer(decodeUtf8(frame));
            trailerStatus = trailer.status ?? trailerStatus;
            trailerMessage = trailer.message ?? trailerMessage;
        } else {
            message = message === undefined ? frame : concatBytes(message, frame);
        }
        offset = end;
    }
    return { message, trailerStatus, trailerMessage };
}

function parseGrpcTrailer(text: string): { status: string | null; message: string | null } {
    let status: string | null = null;
    let message: string | null = null;
    for (const line of text.split(/\r?\n/)) {
        const separator = line.indexOf(":");
        if (separator === -1) {
            continue;
        }
        const key = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (key === "grpc-status") {
            status = value;
        } else if (key === "grpc-message") {
            message = value;
        }
    }
    return { status, message };
}

function decodeGrpcMessage(message: string | null): string {
    if (message === null) {
        return "";
    }
    try {
        return decodeURIComponent(message);
    } catch {
        return message;
    }
}

// --- minimal protobuf primitives ----------------------------------------------

class ByteWriter {
    private readonly chunks: number[] = [];

    writeUleb(value: number): void {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error("uleb value must be a non-negative safe integer");
        }
        let remaining = value;
        do {
            let byte = remaining & 0x7f;
            remaining = Math.floor(remaining / 128);
            if (remaining > 0) {
                byte |= 0x80;
            }
            this.chunks.push(byte);
        } while (remaining > 0);
    }

    writeVarintBigint(value: bigint): void {
        if (value < 0n) {
            throw new Error("varint value must be non-negative");
        }
        let remaining = value;
        do {
            let byte = Number(remaining & 0x7fn);
            remaining >>= 7n;
            if (remaining > 0n) {
                byte |= 0x80;
            }
            this.chunks.push(byte);
        } while (remaining > 0n);
    }

    writeU64(value: bigint): void {
        let remaining = value;
        for (let i = 0; i < 8; i += 1) {
            this.chunks.push(Number(remaining & 0xffn));
            remaining >>= 8n;
        }
    }

    writeBytes(bytes: Uint8Array): void {
        for (const byte of bytes) {
            this.chunks.push(byte);
        }
    }

    toBytes(): Uint8Array {
        return Uint8Array.from(this.chunks);
    }
}

class ByteReader {
    private offset = 0;

    constructor(private readonly bytes: Uint8Array) {}

    isExhausted(): boolean {
        return this.offset >= this.bytes.length;
    }

    readVarint(): bigint {
        let result = 0n;
        let shift = 0n;
        for (;;) {
            if (this.offset >= this.bytes.length) {
                throw new Error("unexpected end of protobuf varint");
            }
            const byte = this.bytes[this.offset] ?? 0;
            this.offset += 1;
            result |= BigInt(byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) {
                return result;
            }
            shift += 7n;
            if (shift > 70n) {
                throw new Error("protobuf varint is too long");
            }
        }
    }

    readUleb(): number {
        return bigintToSafeNumber(this.readVarint(), "uleb length");
    }

    readTag(): { field: number; wireType: number } {
        const tag = this.readVarint();
        return { field: Number(tag >> 3n), wireType: Number(tag & 0x7n) };
    }

    readLengthDelimited(): Uint8Array<ArrayBuffer> {
        const length = bigintToSafeNumber(this.readVarint(), "protobuf length");
        return this.readBytes(length);
    }

    readBytes(length: number): Uint8Array<ArrayBuffer> {
        const end = this.offset + length;
        if (end > this.bytes.length) {
            throw new Error("unexpected end of protobuf message");
        }
        const slice = this.bytes.slice(this.offset, end);
        this.offset = end;
        return slice;
    }

    skipField(wireType: number): void {
        switch (wireType) {
            case 0:
                this.readVarint();
                return;
            case 1:
                this.readBytes(8);
                return;
            case 2:
                this.readLengthDelimited();
                return;
            case 5:
                this.readBytes(4);
                return;
            default:
                throw new Error(`unsupported protobuf wire type ${wireType}`);
        }
    }
}

function writeStringField(writer: ByteWriter, field: number, value: string): void {
    writeBytesField(writer, field, new TextEncoder().encode(value));
}

function writeBytesField(writer: ByteWriter, field: number, value: Uint8Array): void {
    writer.writeVarintBigint(BigInt((field << 3) | 2));
    writer.writeUleb(value.length);
    writer.writeBytes(value);
}

function writeVarintField(writer: ByteWriter, field: number, value: bigint): void {
    writer.writeVarintBigint(BigInt((field << 3) | 0));
    writer.writeVarintBigint(value);
}

// --- shared helpers ------------------------------------------------------------

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

class RetryableTransportError extends Error {}

function isRetryableTransportError(error: Error): boolean {
    return error instanceof RetryableTransportError;
}

function isRetryableHttpStatus(status: number): boolean {
    return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

function isRetryableGrpcStatus(status: string): boolean {
    // 14 UNAVAILABLE, 4 DEADLINE_EXCEEDED, 8 RESOURCE_EXHAUSTED.
    return status === "14" || status === "4" || status === "8";
}

function normalizeGrpcBaseUrl(grpcUrl: string): string {
    return grpcUrl.endsWith("/") ? grpcUrl.slice(0, -1) : grpcUrl;
}

function checkedU64(value: bigint, field: string): bigint {
    if (value < 0n || value > MAX_U64) {
        throw new Error(`${field} must fit in a u64`);
    }
    return value;
}

function bigintToSafeNumber(value: bigint, field: string): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${field} must be a non-negative safe integer`);
    }
    return Number(value);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
    const combined = new Uint8Array(left.length + right.length);
    combined.set(left, 0);
    combined.set(right, left.length);
    return combined;
}

function decodeUtf8(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

function readRecord(value: unknown, field: string): unknown {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    return (value as Record<string, unknown>)[field];
}

function readBigintField(value: unknown, field: string, label: string): bigint {
    const raw = readRecord(value, field);
    if (typeof raw === "bigint") {
        return raw;
    }
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
        return BigInt(raw);
    }
    if (typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw)) {
        return BigInt(raw);
    }
    throw new Error(`${label} is missing or malformed`);
}

function readBytesField(value: unknown, field: string, label: string): Uint8Array {
    const raw = readRecord(value, field);
    if (raw instanceof Uint8Array) {
        return raw;
    }
    throw new Error(`${label} is missing or malformed`);
}
