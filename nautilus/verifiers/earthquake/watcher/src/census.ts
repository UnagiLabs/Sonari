import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import type { RelayerSigner, SuiNetwork } from "@sonari/earthquake-relayer";
import {
    type AffectedCellsArtifact,
    computeAffectedCellsRootHex,
    type EarthquakeOraclePayload,
    type EnclaveVerificationMetadata,
    type EvidenceManifest,
    type RelayerSubmitInput,
    type StoredSourceRef,
    type TeeCoreResult,
    validateRelayerSubmitInput,
} from "@sonari/earthquake-shared";

const CENSUS_INTENT = "SONARI_FLOOR_CENSUS_V1";
const CENSUS_VERIFIER_FAMILY = "census";
const CENSUS_VERIFIER_VERSION = 1n;
const BAND_COUNT = 3;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;
const U32_MAX = 0xffff_ffff;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
// Sui public fullnodes cap suix_queryEvents at QUERY_MAX_RESULT_LIMIT=50.
const QUERY_EVENTS_PAGE_LIMIT = 50;
const RPC_MAX_ATTEMPTS = 4;
const RPC_INITIAL_RETRY_DELAY_MS = 500;
const RPC_RETRY_BACKOFF_FACTOR = 2;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503]);
const HOME_CELL_REGISTERED_GRAPHQL_QUERY = `
query SonariHomeCellRegisteredEvents(
  $eventType: String!
  $beforeCheckpoint: UInt53
  $cursor: String
) {
  events(filter: { type: $eventType, beforeCheckpoint: $beforeCheckpoint }, after: $cursor) {
    nodes {
      contents {
        json
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;
const ACTIVE_LINEAGES_GRAPHQL_QUERY = `
query SonariMembershipActiveLineages(
  $membershipRegistryId: SuiAddress!
  $checkpoint: UInt53
  $keys: [DynamicFieldName!]!
) {
  object(address: $membershipRegistryId, atCheckpoint: $checkpoint) {
    multiGetDynamicFields(keys: $keys) {
      contents {
        json
      }
    }
  }
}
`;
const CAMPAIGN_TRANSACTION_GRAPHQL_QUERY = `
query SonariCampaignTransaction(
  $digest: String!
  $eventsCursor: String
  $objectChangesCursor: String
) {
  transaction(digest: $digest) {
    effects {
      checkpoint {
        sequenceNumber
      }
      events(after: $eventsCursor) {
        nodes {
          contents {
            json
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      objectChanges(after: $objectChangesCursor) {
        nodes {
          address
          outputState {
            address
            asMoveObject {
              contents {
                type {
                  repr
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

export interface HomeCellRegisteredEvent {
    lineage: string;
    homeCell: string;
    registeredAtMs: number;
}

export interface FloorCensusCountsInput {
    affectedCells: AffectedCellsArtifact;
    homeCellEvents: readonly HomeCellRegisteredEvent[];
    activeLineages: ReadonlySet<string>;
    cutoffMs: number;
    expectedAffectedCellsRoot: string;
    eventUid: string;
    eventRevision: number;
}

export interface FloorCensusResultFields {
    eventUid: string;
    eventRevision: number;
    affectedCellsRoot: string;
    registeredMembersByBand: readonly [bigint, bigint, bigint];
    issuedAtMs: number;
}

export interface SignedFloorCensusResult {
    censusBcs: Uint8Array;
    censusBcsHex: string;
    signature: Uint8Array;
    signatureHex: string;
    publicKey: Uint8Array;
    publicKeyHex: string;
}

export interface FloorCensusInputBundle {
    event_uid: string;
    event_revision: number;
    occurred_at_ms: number;
    affected_cells_root: string;
    issued_at_ms: number;
    campaign_id: string;
    disaster_event_id: string;
    census_checkpoint: number;
    affected_cells: AffectedCellsArtifact;
    home_cell_events: Array<{
        lineage: string;
        home_cell: string;
        registered_at_ms: number;
    }>;
    active_lineages: string[];
}

export interface FloorCensusAffectedCellsResolver {
    resolveAffectedCells(input: {
        affectedCellsRef?: StoredSourceRef | undefined;
        evidenceManifest?: EvidenceManifest | undefined;
    }): Promise<AffectedCellsArtifact>;
}

export interface ParsedFloorCensusTeeOutput extends SignedFloorCensusResult {
    counts: readonly [bigint, bigint, bigint];
}

export interface FloorCensusRunInput {
    sourceEventId: string;
    result: TeeCoreResult;
    relayerDigest?: string | undefined;
    disasterEventId?: string | undefined;
}

export type FloorCensusRunResult =
    | {
          status: "skipped";
          reason: string;
      }
    | {
          status: "succeeded";
          digest?: string | undefined;
          campaignId: string;
          disasterEventId: string;
          counts: readonly [bigint, bigint, bigint];
          censusBcsHex: string;
          signatureHex: string;
          publicKeyHex: string;
      };

export interface FloorCensusAdapter {
    run(input: FloorCensusRunInput): Promise<FloorCensusRunResult>;
}

export interface FloorCensusOnchainReader {
    listHomeCellRegisteredEvents(input: {
        packageId: string;
        checkpoint?: number | undefined;
    }): Promise<HomeCellRegisteredEvent[]>;
    listActiveLineages(input: {
        membershipRegistryId: string;
        lineages: readonly string[];
        checkpoint?: number | undefined;
    }): Promise<ReadonlySet<string>>;
    findCampaignId(input: {
        digest: string;
        eventUid: string;
        eventRevision: number;
    }): Promise<{ campaignId: string; checkpoint: number } | undefined>;
}

export interface FloorCensusSubmitClient {
    signAndExecuteTransaction(input: {
        transaction: Transaction;
        signer: RelayerSigner;
        include: { effects: true; events: true };
    }): Promise<FloorCensusExecutionResponse>;
}

export interface FloorCensusExecutionResponse {
    $kind?: string;
    Transaction?: {
        digest?: string;
        status?: { success: boolean; error?: { message?: string } | string | null };
        effects?: Record<string, unknown>;
        events?: unknown[];
    };
    FailedTransaction?: {
        digest?: string;
        status?: { success: boolean; error?: { message?: string } | string | null };
        effects?: Record<string, unknown>;
        events?: unknown[];
    };
}

export interface FloorCensusSubmitConfig {
    target: string;
    pauseState: string;
    verifierRegistry: string;
    categoryPool: string;
    mainPool: string;
    membershipRegistry: string;
    network?: SuiNetwork | undefined;
    grpcUrl?: string | undefined;
    signer?: RelayerSigner | undefined;
    loadSigner?: (() => Promise<RelayerSigner>) | undefined;
    client?: FloorCensusSubmitClient | undefined;
    reader?: FloorCensusOnchainReader | undefined;
    now?: (() => number) | undefined;
    configurationError?: string | undefined;
}

export interface FloorCensusTeeClient {
    processData(input: unknown): Promise<unknown>;
}

export function computeFloorCensusCounts(input: FloorCensusCountsInput): [bigint, bigint, bigint] {
    validateCensusBinding(input);
    const actualRoot = computeAffectedCellsRootHex(input.affectedCells);
    if (
        actualRoot === null ||
        normalizeHex(actualRoot) !== normalizeHex(input.expectedAffectedCellsRoot)
    ) {
        throw new Error("affected_cells artifact leaves do not match signed Merkle root");
    }

    const cellsByH3 = new Map<string, number>();
    for (const cell of input.affectedCells.affected_cells) {
        if (
            !Number.isSafeInteger(cell.cell_band) ||
            cell.cell_band < 1 ||
            cell.cell_band > BAND_COUNT
        ) {
            throw new Error(`affected cell band must be in range 1..${BAND_COUNT}`);
        }
        cellsByH3.set(canonicalU64Decimal(cell.h3_index), cell.cell_band);
    }

    const latestBeforeCutoff = new Map<string, HomeCellRegisteredEvent>();
    for (const event of input.homeCellEvents) {
        if (!Number.isSafeInteger(event.registeredAtMs) || event.registeredAtMs < 0) {
            throw new Error(
                `registered_at must be a non-negative safe integer: ${event.registeredAtMs}`,
            );
        }
        if (event.registeredAtMs >= input.cutoffMs) {
            continue;
        }
        const previous = latestBeforeCutoff.get(event.lineage);
        if (previous === undefined || previous.registeredAtMs <= event.registeredAtMs) {
            latestBeforeCutoff.set(event.lineage, event);
        }
    }

    const counts: [bigint, bigint, bigint] = [0n, 0n, 0n];
    for (const [lineage, event] of latestBeforeCutoff) {
        if (!input.activeLineages.has(lineage)) {
            continue;
        }
        const band = cellsByH3.get(canonicalU64Decimal(event.homeCell));
        if (band === undefined) {
            continue;
        }
        const index = band - 1;
        const current = counts[index];
        if (current === undefined) {
            throw new Error(`affected cell band must be in range 1..${BAND_COUNT}`);
        }
        counts[index] = current + 1n;
    }
    return counts;
}

export function encodeFloorCensusResultBcs(input: FloorCensusResultFields): Uint8Array {
    if (input.registeredMembersByBand.length !== BAND_COUNT) {
        throw new Error(`registered_members_by_band must contain ${BAND_COUNT} values`);
    }
    return concatBytes([
        utf8Vector(CENSUS_INTENT),
        utf8Vector(CENSUS_VERIFIER_FAMILY),
        u64(CENSUS_VERIFIER_VERSION),
        hexBytes32(input.eventUid),
        u32(input.eventRevision),
        hexBytes32(input.affectedCellsRoot),
        u64Vector(input.registeredMembersByBand),
        u64(BigInt(input.issuedAtMs)),
    ]);
}

export async function signFloorCensusResult(
    signer: RelayerSigner,
    input: FloorCensusResultFields,
): Promise<SignedFloorCensusResult> {
    const censusBcs = encodeFloorCensusResultBcs(input);
    const signature = await signer.sign(censusBcs);
    if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
        throw new Error(`census signature must be ${ED25519_SIGNATURE_BYTES} bytes`);
    }
    const publicKey = signer.getPublicKey().toRawBytes();
    if (publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
        throw new Error(`census public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`);
    }
    return {
        censusBcs,
        censusBcsHex: bytesToHex(censusBcs),
        signature,
        signatureHex: bytesToHex(signature),
        publicKey,
        publicKeyHex: bytesToHex(publicKey),
    };
}

export async function buildFloorCensusInputBundle(input: {
    result: TeeCoreResult;
    homeCellEvents: readonly HomeCellRegisteredEvent[];
    activeLineages: ReadonlySet<string> | readonly string[];
    campaignId: string;
    disasterEventId: string;
    censusCheckpoint: number;
    issuedAtMs: number;
    affectedCellsResolver?: FloorCensusAffectedCellsResolver | undefined;
}): Promise<FloorCensusInputBundle> {
    const validation = validateRelayerSubmitInput(input.result);
    if (!validation.ok) {
        throw new Error(validation.message);
    }
    validateObjectId(input.campaignId, "campaign_id");
    validateObjectId(input.disasterEventId, "disaster_event_id");
    validateSafeInteger(input.censusCheckpoint, "census_checkpoint");
    validateSafeInteger(input.issuedAtMs, "issued_at_ms");

    const parsed = validation.value;
    const payload = parsed.payload as EarthquakeOraclePayload;
    const affectedCells = await resolveAffectedCellsForCensus(parsed, input.affectedCellsResolver);
    validateCensusBinding({
        affectedCells,
        homeCellEvents: input.homeCellEvents,
        activeLineages: new Set(activeLineageArray(input.activeLineages)),
        cutoffMs: payload.occurred_at_ms,
        expectedAffectedCellsRoot: payload.affected_cells_root,
        eventUid: payload.event_uid,
        eventRevision: payload.event_revision,
    });

    return {
        event_uid: payload.event_uid,
        event_revision: payload.event_revision,
        occurred_at_ms: payload.occurred_at_ms,
        affected_cells_root: payload.affected_cells_root,
        issued_at_ms: input.issuedAtMs,
        campaign_id: input.campaignId,
        disaster_event_id: input.disasterEventId,
        census_checkpoint: input.censusCheckpoint,
        affected_cells: affectedCells,
        home_cell_events: input.homeCellEvents.map((event) => ({
            lineage: event.lineage,
            home_cell: canonicalU64Decimal(event.homeCell),
            registered_at_ms: event.registeredAtMs,
        })),
        active_lineages: activeLineageArray(input.activeLineages),
    };
}

export function parseFloorCensusTeeOutput(input: unknown): ParsedFloorCensusTeeOutput {
    const payload = readRecordField(input, "payload");
    const counts = readBandCounts(readUnknownField(payload, "registered_members_by_band"));
    const censusBcsHex = readHexField(input, "payload_bcs_hex", undefined);
    const signatureHex = readHexField(input, "signature", ED25519_SIGNATURE_BYTES);
    const publicKeyHex = readHexField(input, "public_key", ED25519_PUBLIC_KEY_BYTES);
    const censusBcs = hexToBytes(censusBcsHex);
    const signature = hexToBytes(signatureHex);
    const publicKey = hexToBytes(publicKeyHex);
    return {
        counts,
        censusBcs,
        censusBcsHex,
        signature,
        signatureHex,
        publicKey,
        publicKeyHex,
    };
}

export function createSetFloorCensusTransaction(input: {
    target: string;
    senderAddress: string;
    pauseState: string;
    campaignId: string;
    disasterEventId: string;
    verifierRegistry: string;
    categoryPool: string;
    mainPool: string;
    censusBcs: Uint8Array;
    signature: Uint8Array;
    publicKey: Uint8Array;
}): Transaction {
    const tx = new Transaction();
    tx.setSender(input.senderAddress);
    tx.moveCall({
        target: input.target,
        arguments: [
            tx.object(input.pauseState),
            tx.object(input.campaignId),
            tx.object(input.disasterEventId),
            tx.object(input.verifierRegistry),
            tx.object(input.categoryPool),
            tx.object(input.mainPool),
            tx.pure.vector("u8", Array.from(input.censusBcs)),
            tx.pure.vector("u8", Array.from(input.signature)),
            tx.pure.vector("u8", Array.from(input.publicKey)),
            tx.object(SUI_CLOCK_OBJECT_ID),
        ],
    });
    return tx;
}

export class DirectFloorCensusAdapter implements FloorCensusAdapter {
    constructor(private readonly config: FloorCensusSubmitConfig) {}

    async run(input: FloorCensusRunInput): Promise<FloorCensusRunResult> {
        if (this.config.configurationError !== undefined) {
            throw new Error(this.config.configurationError);
        }
        const validation = validateRelayerSubmitInput(input.result);
        if (!validation.ok) {
            return { status: "skipped", reason: validation.message };
        }
        if (input.relayerDigest === undefined || input.disasterEventId === undefined) {
            return {
                status: "skipped",
                reason: "relayer submit digest and disaster event id are required",
            };
        }
        const signer = this.config.signer ?? (await this.config.loadSigner?.());
        if (signer === undefined) {
            throw new Error("Floor census submit requires a signer");
        }
        const reader = this.config.reader;
        if (reader === undefined) {
            throw new Error("Floor census submit requires an on-chain reader");
        }
        const client = this.config.client;
        if (client === undefined) {
            throw new Error("Floor census submit requires a Sui client");
        }

        const parsed = validation.value;
        const payload = parsed.payload as EarthquakeOraclePayload;
        const affectedCells = requireAffectedCells(parsed);
        const campaign = await reader.findCampaignId({
            digest: input.relayerDigest,
            eventUid: payload.event_uid,
            eventRevision: payload.event_revision,
        });
        if (campaign === undefined) {
            throw new Error("relayer transaction did not include CampaignCreated for census");
        }
        const packageId = packageIdFromTarget(this.config.target);
        const homeCellEvents = await reader.listHomeCellRegisteredEvents({
            packageId,
            checkpoint: campaign.checkpoint,
        });
        const activeLineages = await reader.listActiveLineages({
            membershipRegistryId: this.config.membershipRegistry,
            lineages: unique(homeCellEvents.map((event) => event.lineage)),
            checkpoint: campaign.checkpoint,
        });
        const counts = computeFloorCensusCounts({
            affectedCells,
            homeCellEvents,
            activeLineages,
            cutoffMs: payload.occurred_at_ms,
            expectedAffectedCellsRoot: payload.affected_cells_root,
            eventUid: payload.event_uid,
            eventRevision: payload.event_revision,
        });
        const signed = await signFloorCensusResult(signer, {
            eventUid: payload.event_uid,
            eventRevision: payload.event_revision,
            affectedCellsRoot: payload.affected_cells_root,
            registeredMembersByBand: counts,
            issuedAtMs: this.config.now?.() ?? Date.now(),
        });
        const response = await client.signAndExecuteTransaction({
            transaction: createSetFloorCensusTransaction({
                target: this.config.target,
                senderAddress: signer.toSuiAddress(),
                pauseState: this.config.pauseState,
                campaignId: campaign.campaignId,
                disasterEventId: input.disasterEventId,
                verifierRegistry: this.config.verifierRegistry,
                categoryPool: this.config.categoryPool,
                mainPool: this.config.mainPool,
                censusBcs: signed.censusBcs,
                signature: signed.signature,
                publicKey: signed.publicKey,
            }),
            signer,
            include: { effects: true, events: true },
        });
        const digest = readSuccessfulDigest(response);
        return {
            status: "succeeded",
            digest,
            campaignId: campaign.campaignId,
            disasterEventId: input.disasterEventId,
            counts,
            censusBcsHex: signed.censusBcsHex,
            signatureHex: signed.signatureHex,
            publicKeyHex: signed.publicKeyHex,
        };
    }
}

export class TeeFloorCensusAdapter implements FloorCensusAdapter {
    constructor(
        private readonly config: FloorCensusSubmitConfig,
        private readonly tee: FloorCensusTeeClient,
        private readonly registrationMetadata: EnclaveVerificationMetadata,
    ) {}

    async run(input: FloorCensusRunInput): Promise<FloorCensusRunResult> {
        if (this.config.configurationError !== undefined) {
            throw new Error(this.config.configurationError);
        }
        const validation = validateRelayerSubmitInput(input.result);
        if (!validation.ok) {
            return { status: "skipped", reason: validation.message };
        }
        if (input.relayerDigest === undefined || input.disasterEventId === undefined) {
            return {
                status: "skipped",
                reason: "relayer submit digest and disaster event id are required",
            };
        }
        const signer = this.config.signer ?? (await this.config.loadSigner?.());
        if (signer === undefined) {
            throw new Error("Floor census submit requires a signer");
        }
        const reader = this.config.reader;
        if (reader === undefined) {
            throw new Error("Floor census submit requires an on-chain reader");
        }
        const client = this.config.client;
        if (client === undefined) {
            throw new Error("Floor census submit requires a Sui client");
        }

        const parsed = validation.value;
        const payload = parsed.payload as EarthquakeOraclePayload;
        const campaign = await reader.findCampaignId({
            digest: input.relayerDigest,
            eventUid: payload.event_uid,
            eventRevision: payload.event_revision,
        });
        if (campaign === undefined) {
            throw new Error("relayer transaction did not include CampaignCreated for census");
        }
        const packageId = packageIdFromTarget(this.config.target);
        const homeCellEvents = await reader.listHomeCellRegisteredEvents({
            packageId,
            checkpoint: campaign.checkpoint,
        });
        const activeLineages = await reader.listActiveLineages({
            membershipRegistryId: this.config.membershipRegistry,
            lineages: unique(homeCellEvents.map((event) => event.lineage)),
            checkpoint: campaign.checkpoint,
        });
        const bundle = await buildFloorCensusInputBundle({
            result: input.result,
            homeCellEvents,
            activeLineages,
            campaignId: campaign.campaignId,
            disasterEventId: input.disasterEventId,
            censusCheckpoint: campaign.checkpoint,
            issuedAtMs: this.config.now?.() ?? Date.now(),
        });
        const signed = parseFloorCensusTeeOutput(
            await this.tee.processData({
                action: "process_data",
                payload: bundle,
                registration_metadata: this.registrationMetadata,
            }),
        );
        if (
            normalizeHex(signed.publicKeyHex) !==
            normalizeHex(this.registrationMetadata.enclave_instance_public_key)
        ) {
            throw new Error("census TEE public key does not match registration metadata");
        }
        const response = await client.signAndExecuteTransaction({
            transaction: createSetFloorCensusTransaction({
                target: this.config.target,
                senderAddress: signer.toSuiAddress(),
                pauseState: this.config.pauseState,
                campaignId: campaign.campaignId,
                disasterEventId: input.disasterEventId,
                verifierRegistry: this.config.verifierRegistry,
                categoryPool: this.config.categoryPool,
                mainPool: this.config.mainPool,
                censusBcs: signed.censusBcs,
                signature: signed.signature,
                publicKey: signed.publicKey,
            }),
            signer,
            include: { effects: true, events: true },
        });
        const digest = readSuccessfulDigest(response);
        return {
            status: "succeeded",
            digest,
            campaignId: campaign.campaignId,
            disasterEventId: input.disasterEventId,
            counts: signed.counts,
            censusBcsHex: signed.censusBcsHex,
            signatureHex: signed.signatureHex,
            publicKeyHex: signed.publicKeyHex,
        };
    }
}

export class JsonRpcFloorCensusReader implements FloorCensusOnchainReader {
    constructor(private readonly endpoint: string) {}

    async listHomeCellRegisteredEvents(input: {
        packageId: string;
    }): Promise<HomeCellRegisteredEvent[]> {
        const eventType = `${input.packageId}::membership::HomeCellRegistered`;
        const events: HomeCellRegisteredEvent[] = [];
        let cursor: unknown = null;
        while (true) {
            const page = await this.call("suix_queryEvents", [
                { MoveEventType: eventType },
                cursor,
                QUERY_EVENTS_PAGE_LIMIT,
                false,
            ]);
            const records = readArrayField(page, "data");
            for (const record of records) {
                const parsedJson = readRecordField(record, "parsedJson");
                const lineage = readObjectId(parsedJson?.lineage);
                const homeCell = readU64Decimal(parsedJson?.home_cell);
                const registeredAtMs = readSafeInteger(parsedJson?.registered_at);
                if (
                    lineage === undefined ||
                    homeCell === undefined ||
                    registeredAtMs === undefined
                ) {
                    throw new Error("HomeCellRegistered event is malformed");
                }
                events.push({ lineage, homeCell, registeredAtMs });
            }
            cursor = readUnknownField(page, "nextCursor");
            if (!readBooleanField(page, "hasNextPage") || cursor === null) {
                break;
            }
        }
        return events;
    }

    async listActiveLineages(input: {
        membershipRegistryId: string;
        lineages: readonly string[];
    }): Promise<ReadonlySet<string>> {
        const active = new Set<string>();
        for (const lineage of input.lineages) {
            const response = await this.call("suix_getDynamicFieldObject", [
                input.membershipRegistryId,
                { type: "0x2::object::ID", value: lineage },
            ]);
            const content = readRecordField(readRecordField(response, "data"), "content");
            const fields = readRecordField(content, "fields");
            const valueFields =
                readRecordField(readRecordField(fields, "value"), "fields") ?? fields;
            if (readSafeInteger(valueFields?.status) === 1) {
                active.add(lineage);
            }
        }
        return active;
    }

    async findCampaignId(input: {
        digest: string;
        eventUid: string;
        eventRevision: number;
    }): Promise<{ campaignId: string; checkpoint: number } | undefined> {
        const response = await this.call("sui_getTransactionBlock", [
            input.digest,
            { showEvents: true, showObjectChanges: true },
        ]);
        const checkpoint = readSafeInteger(readUnknownField(response, "checkpoint"));
        if (checkpoint === undefined) {
            throw new Error("relayer transaction checkpoint is missing");
        }
        for (const event of readArrayField(response, "events")) {
            const type = readStringField(event, "type");
            if (type?.endsWith("::campaign::CampaignCreated") !== true) {
                continue;
            }
            const parsedJson = readRecordField(event, "parsedJson");
            const eventRevision = readSafeInteger(parsedJson?.event_revision);
            const eventUid = readBytesHex(parsedJson?.event_uid);
            if (
                eventRevision === input.eventRevision &&
                (eventUid === undefined || normalizeHex(eventUid) === normalizeHex(input.eventUid))
            ) {
                const campaignId = readObjectId(parsedJson?.campaign_id);
                return campaignId === undefined ? undefined : { campaignId, checkpoint };
            }
        }
        const candidates: string[] = [];
        for (const change of readArrayField(response, "objectChanges")) {
            const type = readStringField(change, "objectType");
            if (type?.endsWith("::campaign::Campaign") === true) {
                const objectId = readObjectId(readUnknownField(change, "objectId"));
                if (objectId !== undefined) {
                    candidates.push(objectId);
                }
            }
        }
        if (candidates.length > 1) {
            throw new Error("relayer transaction included multiple Campaign object changes");
        }
        const campaignId = candidates[0];
        return campaignId === undefined ? undefined : { campaignId, checkpoint };
    }

    private async call(method: string, params: unknown[]): Promise<unknown> {
        const request = {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                params,
            }),
        };
        for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt += 1) {
            let response: Response;
            try {
                response = await fetch(this.endpoint, request);
            } catch (error) {
                if (attempt + 1 >= RPC_MAX_ATTEMPTS) {
                    throw new Error(`Sui RPC ${method} failed with network error`, {
                        cause: error,
                    });
                }
                await sleep(rpcRetryDelayMs(attempt));
                continue;
            }
            if (!response.ok) {
                if (isRetryableHttpStatus(response.status) && attempt + 1 < RPC_MAX_ATTEMPTS) {
                    await sleep(rpcRetryDelayMs(attempt, response.headers.get("retry-after")));
                    continue;
                }
                throw new Error(`Sui RPC ${method} failed with HTTP ${response.status}`);
            }
            const body = (await response.json()) as unknown;
            const error = readRecordField(body, "error");
            if (error !== undefined) {
                const message = readStringField(error, "message") ?? JSON.stringify(error);
                throw new Error(`Sui RPC ${method} failed: ${message}`);
            }
            return readUnknownField(body, "result");
        }
        throw new Error(`Sui RPC ${method} retry attempts exhausted`);
    }
}

export class GraphqlFloorCensusReader implements FloorCensusOnchainReader {
    constructor(private readonly endpoint: string) {}

    async listHomeCellRegisteredEvents(input: {
        packageId: string;
        checkpoint?: number | undefined;
    }): Promise<HomeCellRegisteredEvent[]> {
        const eventType = `${input.packageId}::membership::HomeCellRegistered`;
        const beforeCheckpoint =
            input.checkpoint === undefined ? undefined : readBeforeCheckpoint(input.checkpoint);
        const events: HomeCellRegisteredEvent[] = [];
        let cursor: string | null = null;
        while (true) {
            const response = await this.query(HOME_CELL_REGISTERED_GRAPHQL_QUERY, {
                eventType,
                beforeCheckpoint,
                cursor,
            });
            const page = readGraphqlEventsPage(response);
            for (const node of page.nodes) {
                events.push(parseHomeCellRegisteredEvent(node));
            }
            cursor = page.endCursor;
            if (!page.hasNextPage) {
                break;
            }
        }
        return events;
    }

    async listActiveLineages(input: {
        membershipRegistryId: string;
        lineages: readonly string[];
        checkpoint?: number | undefined;
    }): Promise<ReadonlySet<string>> {
        const lineages = unique(input.lineages);
        if (lineages.length === 0) {
            return new Set();
        }
        const response = await this.query(ACTIVE_LINEAGES_GRAPHQL_QUERY, {
            membershipRegistryId: input.membershipRegistryId,
            checkpoint: input.checkpoint,
            keys: lineages.map(lineageDynamicFieldKey),
        });
        const fields = readGraphqlDynamicFields(response);
        if (fields.length !== lineages.length) {
            throw new Error("GraphQL membership dynamic fields response is malformed");
        }
        const active = new Set<string>();
        for (let index = 0; index < lineages.length; index += 1) {
            const field = fields[index];
            if (field === null || field === undefined) {
                continue;
            }
            const status = readMembershipStatus(field);
            if (status === 1) {
                const lineage = lineages[index];
                if (lineage === undefined) {
                    throw new Error("GraphQL membership dynamic fields response is malformed");
                }
                active.add(lineage);
            }
        }
        return active;
    }

    async findCampaignId(input: {
        digest: string;
        eventUid: string;
        eventRevision: number;
    }): Promise<{ campaignId: string; checkpoint: number } | undefined> {
        let checkpoint: number | undefined;
        let eventsCursor: string | null = null;
        let objectChangesCursor: string | null = null;
        let hasNextEventsPage = true;
        let hasNextObjectChangesPage = true;
        const campaignCandidates: string[] = [];

        while (hasNextEventsPage || hasNextObjectChangesPage) {
            const response = await this.query(CAMPAIGN_TRANSACTION_GRAPHQL_QUERY, {
                digest: input.digest,
                eventsCursor,
                objectChangesCursor,
            });
            const page = readGraphqlTransactionEffectsPage(response);
            checkpoint ??= page.checkpoint;

            if (hasNextEventsPage) {
                for (const event of page.events.nodes) {
                    const campaignId = parseCampaignCreatedEvent(event, input);
                    if (campaignId !== undefined) {
                        return { campaignId, checkpoint };
                    }
                }
                eventsCursor = page.events.endCursor;
                hasNextEventsPage = page.events.hasNextPage;
            }
            if (hasNextObjectChangesPage) {
                for (const change of page.objectChanges.nodes) {
                    const campaignId = readCampaignObjectChangeId(change);
                    if (campaignId !== undefined) {
                        campaignCandidates.push(campaignId);
                    }
                }
                objectChangesCursor = page.objectChanges.endCursor;
                hasNextObjectChangesPage = page.objectChanges.hasNextPage;
            }
        }

        if (checkpoint === undefined) {
            throw new Error("relayer transaction checkpoint is missing");
        }
        if (campaignCandidates.length > 1) {
            throw new Error("relayer transaction included multiple Campaign object changes");
        }
        const campaignId = campaignCandidates[0];
        return campaignId === undefined ? undefined : { campaignId, checkpoint };
    }

    private async query(query: string, variables: Record<string, unknown>): Promise<unknown> {
        const response = await fetch(this.endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query, variables }),
        });
        if (!response.ok) {
            throw new Error(`Sui GraphQL query failed with HTTP ${response.status}`);
        }
        const body = (await response.json()) as unknown;
        const errors = readUnknownField(body, "errors");
        if (Array.isArray(errors) && errors.length > 0) {
            const firstError = errors[0];
            const message = readStringField(firstError, "message") ?? JSON.stringify(firstError);
            throw new Error(`Sui GraphQL query failed: ${message}`);
        }
        return body;
    }
}

function isRetryableHttpStatus(status: number): boolean {
    return RETRYABLE_HTTP_STATUSES.has(status);
}

function rpcRetryDelayMs(attempt: number, retryAfterHeader?: string | null): number {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    if (retryAfterMs !== undefined) {
        return retryAfterMs;
    }
    return RPC_INITIAL_RETRY_DELAY_MS * RPC_RETRY_BACKOFF_FACTOR ** attempt;
}

function parseRetryAfterMs(header: string | null | undefined): number | undefined {
    if (header === null || header === undefined || header.length === 0) {
        return undefined;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.trunc(seconds * 1_000);
    }
    const timestamp = Date.parse(header);
    if (Number.isNaN(timestamp)) {
        return undefined;
    }
    return Math.max(0, timestamp - Date.now());
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateCensusBinding(input: FloorCensusCountsInput): void {
    if (normalizeHex(input.affectedCells.event_uid) !== normalizeHex(input.eventUid)) {
        throw new Error("affected_cells event_uid does not match census event_uid");
    }
    if (input.affectedCells.event_revision !== input.eventRevision) {
        throw new Error("affected_cells event_revision does not match census event_revision");
    }
}

function requireAffectedCells(input: RelayerSubmitInput): AffectedCellsArtifact {
    if (input.affected_cells === undefined) {
        throw new Error("finalized TEE result is missing affected_cells artifact");
    }
    return input.affected_cells;
}

async function resolveAffectedCellsForCensus(
    input: RelayerSubmitInput,
    resolver: FloorCensusAffectedCellsResolver | undefined,
): Promise<AffectedCellsArtifact> {
    if (input.affected_cells !== undefined) {
        return input.affected_cells;
    }
    if (resolver === undefined) {
        throw new Error("finalized TEE result is missing affected_cells artifact");
    }
    if (input.affected_cells_ref === undefined && input.evidence_manifest === undefined) {
        throw new Error("finalized TEE result is missing affected_cells artifact reference");
    }
    return await resolver.resolveAffectedCells({
        affectedCellsRef: input.affected_cells_ref,
        evidenceManifest: input.evidence_manifest,
    });
}

function packageIdFromTarget(target: string): string {
    const [packageId, moduleName, functionName] = target.split("::");
    if (
        packageId === undefined ||
        packageId.length === 0 ||
        moduleName !== "accessor" ||
        functionName !== "set_floor_census"
    ) {
        throw new Error("FLOOR_CENSUS_TARGET must be <PACKAGE_ID>::accessor::set_floor_census");
    }
    return packageId;
}

function readSuccessfulDigest(response: FloorCensusExecutionResponse): string | undefined {
    if (response.$kind === "FailedTransaction") {
        throw new Error(
            readExecutionError(response.FailedTransaction?.status) ??
                "floor census transaction failed",
        );
    }
    const status = response.Transaction?.status;
    if (status !== undefined && !status.success) {
        throw new Error(readExecutionError(status) ?? "floor census transaction failed");
    }
    return response.Transaction?.digest;
}

function readExecutionError(
    status: { error?: { message?: string } | string | null } | undefined,
): string | undefined {
    const error = status?.error;
    if (typeof error === "string" && error.length > 0) {
        return error;
    }
    if (error !== null && typeof error === "object" && typeof error.message === "string") {
        return error.message;
    }
    return undefined;
}

function parseHomeCellRegisteredEvent(event: unknown): HomeCellRegisteredEvent {
    const parsedJson = readEventJson(event);
    let lineage: string | undefined;
    let homeCell: string | undefined;
    let registeredAtMs: number | undefined;
    try {
        lineage = readObjectId(parsedJson?.lineage);
        homeCell = readU64Decimal(parsedJson?.home_cell);
        registeredAtMs = readSafeInteger(parsedJson?.registered_at);
    } catch {
        throw new Error("HomeCellRegistered event is malformed");
    }
    if (lineage === undefined || homeCell === undefined || registeredAtMs === undefined) {
        throw new Error("HomeCellRegistered event is malformed");
    }
    return { lineage, homeCell, registeredAtMs };
}

function readGraphqlEventsPage(response: unknown): {
    nodes: unknown[];
    hasNextPage: boolean;
    endCursor: string | null;
} {
    const data = readRecordField(response, "data");
    const events = readRecordField(data, "events");
    if (events === undefined) {
        throw new Error("GraphQL events page is missing or malformed");
    }
    const nodes = readUnknownField(events, "nodes");
    if (!Array.isArray(nodes)) {
        throw new Error("GraphQL event nodes must be an array");
    }
    const pageInfo = readRecordField(events, "pageInfo");
    if (pageInfo === undefined) {
        throw new Error("GraphQL events pageInfo is malformed");
    }
    const hasNextPageValue = readUnknownField(pageInfo, "hasNextPage");
    if (typeof hasNextPageValue !== "boolean") {
        throw new Error("GraphQL events pageInfo is malformed");
    }
    const endCursorValue = readUnknownField(pageInfo, "endCursor");
    const endCursor =
        typeof endCursorValue === "string" && endCursorValue.length > 0 ? endCursorValue : null;
    if (hasNextPageValue && endCursor === null) {
        throw new Error("GraphQL events pageInfo is malformed");
    }
    return { nodes, hasNextPage: hasNextPageValue, endCursor };
}

function readGraphqlTransactionEffectsPage(response: unknown): {
    checkpoint: number;
    events: { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null };
    objectChanges: { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null };
} {
    const data = readRecordField(response, "data");
    const transaction = readRecordField(data, "transaction");
    const effects = readRecordField(transaction, "effects");
    if (effects === undefined) {
        throw new Error("GraphQL transaction effects are missing or malformed");
    }
    const checkpoint = readSafeInteger(
        readUnknownField(readRecordField(effects, "checkpoint"), "sequenceNumber"),
    );
    if (checkpoint === undefined) {
        throw new Error("relayer transaction checkpoint is missing");
    }
    return {
        checkpoint,
        events: readGraphqlConnectionPage(effects, "events", "GraphQL transaction events pageInfo"),
        objectChanges: readGraphqlConnectionPage(
            effects,
            "objectChanges",
            "GraphQL transaction objectChanges pageInfo",
        ),
    };
}

function readGraphqlConnectionPage(
    input: unknown,
    field: string,
    pageInfoError: string,
): {
    nodes: unknown[];
    hasNextPage: boolean;
    endCursor: string | null;
} {
    const page = readRecordField(input, field);
    if (page === undefined) {
        throw new Error(`${pageInfoError} is malformed`);
    }
    const nodes = readUnknownField(page, "nodes");
    if (!Array.isArray(nodes)) {
        throw new Error(`${pageInfoError} is malformed`);
    }
    const pageInfo = readRecordField(page, "pageInfo");
    const hasNextPageValue = readUnknownField(pageInfo, "hasNextPage");
    if (typeof hasNextPageValue !== "boolean") {
        throw new Error(`${pageInfoError} is malformed`);
    }
    const endCursorValue = readUnknownField(pageInfo, "endCursor");
    const endCursor =
        typeof endCursorValue === "string" && endCursorValue.length > 0 ? endCursorValue : null;
    if (hasNextPageValue && endCursor === null) {
        throw new Error(`${pageInfoError} is malformed`);
    }
    return { nodes, hasNextPage: hasNextPageValue, endCursor };
}

function parseCampaignCreatedEvent(
    event: unknown,
    expected: { eventUid: string; eventRevision: number },
): string | undefined {
    const parsedJson = readEventJson(event);
    const campaignId = readObjectId(parsedJson?.campaign_id);
    if (campaignId === undefined) {
        return undefined;
    }
    const eventRevision = readSafeInteger(parsedJson?.event_revision);
    const eventUid = readBytesHex(parsedJson?.event_uid);
    if (
        eventRevision === expected.eventRevision &&
        eventUid !== undefined &&
        normalizeHex(eventUid) === normalizeHex(expected.eventUid)
    ) {
        return campaignId;
    }
    return undefined;
}

function readCampaignObjectChangeId(change: unknown): string | undefined {
    const outputState = readRecordField(change, "outputState");
    const type = readMoveObjectTypeRepr(outputState) ?? readStringField(change, "objectType");
    if (type?.endsWith("::campaign::Campaign") !== true) {
        return undefined;
    }
    return (
        readObjectId(readUnknownField(outputState, "address")) ??
        readObjectId(readUnknownField(change, "address")) ??
        readObjectId(readUnknownField(change, "objectId"))
    );
}

function readMoveObjectTypeRepr(input: unknown): string | undefined {
    return readStringField(
        readRecordField(
            readRecordField(readRecordField(input, "asMoveObject"), "contents"),
            "type",
        ),
        "repr",
    );
}

function readGraphqlDynamicFields(response: unknown): unknown[] {
    const data = readRecordField(response, "data");
    const object = readRecordField(data, "object");
    if (object === undefined) {
        throw new Error("GraphQL membership registry object is missing or malformed");
    }
    const fields = readUnknownField(object, "multiGetDynamicFields");
    if (!Array.isArray(fields)) {
        throw new Error("GraphQL membership dynamic fields response is malformed");
    }
    return fields;
}

function readMembershipStatus(field: unknown): number {
    const contents = readRecordField(field, "contents");
    const json = readRecordField(contents, "json");
    const value = readRecordField(json, "value");
    const status = readSafeInteger(json?.status) ?? readSafeInteger(value?.status);
    if (status === undefined) {
        throw new Error("membership dynamic field status is malformed");
    }
    return status;
}

function readEventJson(event: unknown): Record<string, unknown> | undefined {
    const parsedJson = readRecordField(event, "parsedJson");
    if (parsedJson !== undefined) {
        return parsedJson;
    }
    const contents = readRecordField(event, "contents");
    return readRecordField(contents, "json");
}

function readBeforeCheckpoint(checkpoint: number): number {
    if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) {
        throw new Error("checkpoint must be a non-negative safe integer");
    }
    if (checkpoint >= Number.MAX_SAFE_INTEGER) {
        throw new Error("beforeCheckpoint must be a safe integer");
    }
    return checkpoint + 1;
}

function lineageDynamicFieldKey(lineage: string): { type: "0x2::object::ID"; bcs: string } {
    return {
        type: "0x2::object::ID",
        bcs: Buffer.from(objectIdBytes(lineage)).toString("base64"),
    };
}

function objectIdBytes(value: string): Uint8Array {
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`object ID must be 32 bytes: ${value}`);
    }
    return Uint8Array.from(Buffer.from(hex, "hex"));
}

function readRecordField(input: unknown, field: string): Record<string, unknown> | undefined {
    const value = readUnknownField(input, field);
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function readArrayField(input: unknown, field: string): unknown[] {
    const value = readUnknownField(input, field);
    return Array.isArray(value) ? value : [];
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

function readHexField(input: unknown, field: string, expectedBytes: number | undefined): string {
    const value = readStringField(input, field);
    if (value === undefined) {
        throw new Error(`Census TEE output ${field} is missing`);
    }
    const normalized = value.startsWith("0x") ? value.slice(2) : value;
    if (
        normalized.length === 0 ||
        normalized.length % 2 !== 0 ||
        !/^[0-9a-fA-F]+$/.test(normalized) ||
        (expectedBytes !== undefined && normalized.length !== expectedBytes * 2)
    ) {
        throw new Error(`Census TEE output ${field} is malformed`);
    }
    return `0x${normalized.toLowerCase()}`;
}

function readBooleanField(input: unknown, field: string): boolean {
    return readUnknownField(input, field) === true;
}

function readObjectId(input: unknown): string | undefined {
    if (typeof input === "string" && input.length > 0) {
        return input;
    }
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
        const id = (input as Record<string, unknown>).id;
        return typeof id === "string" && id.length > 0 ? id : undefined;
    }
    return undefined;
}

function readU64Decimal(input: unknown): string | undefined {
    if (typeof input === "string") {
        return canonicalU64Decimal(input);
    }
    if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0) {
        return input.toString(10);
    }
    return undefined;
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

function readBandCounts(input: unknown): [bigint, bigint, bigint] {
    if (!Array.isArray(input) || input.length !== BAND_COUNT) {
        throw new Error(
            `Census TEE output registered_members_by_band must contain ${BAND_COUNT} values`,
        );
    }
    return input.map(readCountValue) as [bigint, bigint, bigint];
}

function readCountValue(input: unknown): bigint {
    if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0) {
        return BigInt(input);
    }
    if (typeof input === "string" && /^(0|[1-9][0-9]*)$/.test(input)) {
        return BigInt(input);
    }
    throw new Error("Census TEE output registered_members_by_band is malformed");
}

function readBytesHex(input: unknown): string | undefined {
    if (typeof input === "string") {
        if (/^0x[0-9a-fA-F]{64}$/.test(input)) {
            return input;
        }
        try {
            const decoded = Buffer.from(input, "base64");
            if (decoded.byteLength === 32 && decoded.toString("base64") === input) {
                return bytesToHex(decoded);
            }
        } catch {
            return undefined;
        }
        return input;
    }
    if (
        Array.isArray(input) &&
        input.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
        return bytesToHex(Uint8Array.from(input as number[]));
    }
    return undefined;
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)];
}

function activeLineageArray(input: ReadonlySet<string> | readonly string[]): string[] {
    return Array.isArray(input) ? unique(input) : [...input];
}

function canonicalU64Decimal(value: string): string {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`u64 decimal is not canonical: ${value}`);
    }
    const parsed = BigInt(value);
    if (parsed > U64_MAX) {
        throw new Error(`u64 decimal is out of range: ${value}`);
    }
    return parsed.toString(10);
}

function utf8Vector(value: string): Uint8Array {
    const bytes = new TextEncoder().encode(value);
    return concatBytes([uleb128(bytes.byteLength), bytes]);
}

function u64Vector(values: readonly bigint[]): Uint8Array {
    return concatBytes([uleb128(values.length), ...values.map(u64)]);
}

function u32(value: number): Uint8Array {
    if (!Number.isSafeInteger(value) || value < 0 || value > U32_MAX) {
        throw new Error(`u32 out of range: ${value}`);
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
}

function u64(value: bigint): Uint8Array {
    if (value < 0n || value > U64_MAX) {
        throw new Error(`u64 out of range: ${value.toString()}`);
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}

function uleb128(value: number): Uint8Array {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`ULEB128 value must be a non-negative safe integer: ${value}`);
    }
    const bytes: number[] = [];
    let remaining = value;
    do {
        let byte = remaining & 0x7f;
        remaining = Math.floor(remaining / 128);
        if (remaining > 0) {
            byte |= 0x80;
        }
        bytes.push(byte);
    } while (remaining > 0);
    return Uint8Array.from(bytes);
}

function hexBytes32(value: string): Uint8Array {
    const normalized = normalizeHex(value);
    if (normalized.length !== 64 || !/^[0-9a-f]+$/.test(normalized)) {
        throw new Error("expected 32-byte hex string");
    }
    return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function hexToBytes(value: string): Uint8Array {
    const normalized = normalizeHex(value);
    if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
        throw new Error("hex bytes are malformed");
    }
    return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function validateObjectId(value: string, field: string): void {
    try {
        objectIdBytes(value);
    } catch {
        throw new Error(`${field} must be a 32-byte object ID`);
    }
}

function validateSafeInteger(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`);
    }
}

function normalizeHex(value: string): string {
    return value.startsWith("0x") ? value.slice(2).toLowerCase() : value.toLowerCase();
}

function bytesToHex(bytes: Uint8Array): string {
    return `0x${Buffer.from(bytes).toString("hex")}`;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
}
