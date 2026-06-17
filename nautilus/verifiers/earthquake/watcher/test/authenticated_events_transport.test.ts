import { fromBase64, toBase58, toHex } from "@mysten/sui/utils";
import { describe, expect, it } from "vitest";
import {
    type SuiCheckpointLedgerClient,
    SuiAlphaAuthenticatedEventsTransport,
    createGrpcCheckpointLedgerClient,
    encodeCheckpointSignatureBcs,
    encodeValidatorCommitteeBcs,
} from "../src/authenticated_events_transport.js";

const streamId = `0x${"12".repeat(32)}`;
const objectId = `0x${"34".repeat(32)}`;

// --- protobuf encoding helpers (mirror the on-wire format) ---------------------

function pbVarint(value: number | bigint): number[] {
    let remaining = BigInt(value);
    const out: number[] = [];
    do {
        let byte = Number(remaining & 0x7fn);
        remaining >>= 7n;
        if (remaining > 0n) {
            byte |= 0x80;
        }
        out.push(byte);
    } while (remaining > 0n);
    return out;
}

function pbVarintField(field: number, value: number | bigint): number[] {
    return [...pbVarint((field << 3) | 0), ...pbVarint(value)];
}

function pbLenField(field: number, bytes: number[]): number[] {
    return [...pbVarint((field << 3) | 2), ...pbVarint(bytes.length), ...bytes];
}

function pbStringField(field: number, value: string): number[] {
    return pbLenField(field, [...new TextEncoder().encode(value)]);
}

function grpcWebFrame(message: number[]): Uint8Array {
    const len = message.length;
    return Uint8Array.from([
        0,
        (len >>> 24) & 0xff,
        (len >>> 16) & 0xff,
        (len >>> 8) & 0xff,
        len & 0xff,
        ...message,
    ]);
}

function grpcWebTrailer(status: string): Uint8Array {
    const text = `grpc-status:${status}\r\n`;
    const bytes = [...new TextEncoder().encode(text)];
    const len = bytes.length;
    return Uint8Array.from([
        0x80,
        (len >>> 24) & 0xff,
        (len >>> 16) & 0xff,
        (len >>> 8) & 0xff,
        len & 0xff,
        ...bytes,
    ]);
}

function okResponse(messageBytes: number[]): Response {
    const body = new Uint8Array([...grpcWebFrame(messageBytes), ...grpcWebTrailer("0")]);
    return new Response(body, { status: 200, headers: { "content-type": "application/grpc-web+proto" } });
}

function errorResponse(status: string, message: string): Response {
    return new Response(new Uint8Array(0), {
        status: 200,
        headers: { "grpc-status": status, "grpc-message": encodeURIComponent(message) },
    });
}

function bcsMessage(value: number[]): number[] {
    // sui.rpc.v2.Bcs { value = 2: bytes }
    return pbLenField(2, value);
}

function v2Event(eventType: string, contents: number[]): number[] {
    // sui.rpc.v2.Event { event_type = 4, contents = 5 }
    return [...pbStringField(4, eventType), ...pbLenField(5, bcsMessage(contents))];
}

function authenticatedEvent(input: {
    checkpoint: number;
    transactionIndex: number;
    eventIndex: number;
    eventType: string;
    contents: number[];
}): number[] {
    return [
        ...pbVarintField(1, input.checkpoint),
        ...pbVarintField(3, input.transactionIndex),
        ...pbVarintField(4, input.eventIndex),
        ...pbLenField(5, v2Event(input.eventType, input.contents)),
    ];
}

const stubLedger: SuiCheckpointLedgerClient = {
    async getCheckpointSignature() {
        return {
            epoch: 9n,
            signature: new Uint8Array(48).fill(0xcd),
            bitmap: new Uint8Array([0x01, 0x02]),
        };
    },
    async getEpochCommittee() {
        return {
            epoch: 9n,
            members: [{ publicKey: new Uint8Array(96).fill(0xab), stake: 7n }],
        };
    },
};

describe("encodeValidatorCommitteeBcs", () => {
    it("matches the canonical sui_sdk_types ValidatorCommittee layout", () => {
        const bytes = encodeValidatorCommitteeBcs({
            epoch: 5n,
            members: [{ publicKey: new Uint8Array(96).fill(0xab), stake: 7n }],
        });
        const expected =
            "0500000000000000" + // u64 epoch
            "01" + // uleb members length
            "60" + // uleb public key length (96)
            "ab".repeat(96) + // bls public key
            "0700000000000000"; // u64 stake
        expect(toHex(bytes)).toBe(expected);
    });

    it("fails closed when a public key is not 96 bytes", () => {
        expect(() =>
            encodeValidatorCommitteeBcs({
                epoch: 1n,
                members: [{ publicKey: new Uint8Array(32), stake: 1n }],
            }),
        ).toThrow("public key must be 96 bytes");
    });
});

describe("encodeCheckpointSignatureBcs", () => {
    it("matches the canonical sui_sdk_types ValidatorAggregatedSignature layout", () => {
        const bytes = encodeCheckpointSignatureBcs({
            epoch: 5n,
            signature: new Uint8Array(48).fill(0xcd),
            bitmap: new Uint8Array([0x01, 0x02]),
        });
        const expected =
            "0500000000000000" + // u64 epoch
            "cd".repeat(48) + // bls signature, fixed array, no length prefix
            "02" + // uleb bitmap length
            "0102"; // roaring bitmap bytes
        expect(toHex(bytes)).toBe(expected);
    });

    it("fails closed when the signature is not 48 bytes", () => {
        expect(() =>
            encodeCheckpointSignatureBcs({
                epoch: 1n,
                signature: new Uint8Array(32),
                bitmap: new Uint8Array(1),
            }),
        ).toThrow("must be 48 bytes");
    });
});

describe("SuiAlphaAuthenticatedEventsTransport.listAuthenticatedEvents", () => {
    it("maps authenticated events and pagination metadata", async () => {
        const requests: { url: string; body: Uint8Array }[] = [];
        const response = [
            ...pbLenField(
                1,
                authenticatedEvent({
                    checkpoint: 11,
                    transactionIndex: 2,
                    eventIndex: 3,
                    eventType: `${streamId}::membership::HomeCellRegistered`,
                    contents: [0xaa, 0xbb],
                }),
            ),
            ...pbVarintField(2, 45),
            ...pbLenField(3, [0xde, 0xad]),
        ];
        const transport = new SuiAlphaAuthenticatedEventsTransport({
            grpcUrl: "https://fullnode.testnet.sui.io:443/",
            ledger: stubLedger,
            fetchImpl: async (url, init) => {
                requests.push({ url, body: init.body as Uint8Array });
                return okResponse(response);
            },
        });

        const page = await transport.listAuthenticatedEvents({
            streamId,
            startCheckpoint: 10,
            endCheckpoint: 42,
            pageSize: 100,
        });

        expect(requests[0]?.url).toBe(
            "https://fullnode.testnet.sui.io:443/sui.rpc.alpha.EventService/ListAuthenticatedEvents",
        );
        expect(page.highestIndexedCheckpoint).toBe(45);
        expect(page.nextPageToken).toBe(Buffer.from([0xde, 0xad]).toString("base64"));
        expect(page.events).toEqual([
            {
                checkpoint: 11,
                transactionIndex: 2,
                eventIndex: 3,
                type: `${streamId}::membership::HomeCellRegistered`,
                eventBcs: Buffer.from([0xaa, 0xbb]).toString("base64"),
            },
        ]);
    });

    it("fails closed on a gRPC error status", async () => {
        const transport = new SuiAlphaAuthenticatedEventsTransport({
            grpcUrl: "https://fullnode.testnet.sui.io:443",
            ledger: stubLedger,
            fetchImpl: async () => errorResponse("3", "stream not found"),
        });
        await expect(
            transport.listAuthenticatedEvents({
                streamId,
                startCheckpoint: 10,
                endCheckpoint: 42,
                pageSize: 100,
            }),
        ).rejects.toThrow("stream not found");
    });
});

describe("SuiAlphaAuthenticatedEventsTransport.getObjectInclusionProof", () => {
    it("recomposes the committee and signature BCS alongside the proof", async () => {
        const treeRoot = [...new Uint8Array(32).fill(0x42)];
        const merkleProof = [0x01, 0x20, ...new Array<number>(32).fill(0x99)]; // vector<vector<u8>> of 1 node
        const proofMessage = [
            ...pbLenField(1, [
                ...pbStringField(1, objectId),
                ...pbVarintField(2, 7),
                ...pbStringField(3, "11111111111111111111111111111111"),
            ]),
            ...pbLenField(2, [
                ...pbLenField(1, merkleProof),
                ...pbVarintField(2, 3),
                ...pbLenField(3, treeRoot),
            ]),
            ...pbLenField(3, [0x05, 0x06]), // object_data
            ...pbLenField(4, [0x07, 0x08]), // checkpoint_summary
        ];
        const transport = new SuiAlphaAuthenticatedEventsTransport({
            grpcUrl: "https://fullnode.testnet.sui.io:443",
            ledger: stubLedger,
            fetchImpl: async () => okResponse(proofMessage),
        });

        const proof = await transport.getObjectInclusionProof({ objectId, checkpoint: 42 });

        expect(proof.objectRef).toEqual({
            objectId,
            version: "7",
            digest: "11111111111111111111111111111111",
        });
        expect(proof.objectBcs).toBe(Buffer.from([0x05, 0x06]).toString("base64"));
        expect(proof.checkpointSummaryBcs).toBe(Buffer.from([0x07, 0x08]).toString("base64"));
        expect(proof.inclusionProof.leafIndex).toBe(3);
        expect(proof.inclusionProof.treeRoot).toBe(toBase58(new Uint8Array(32).fill(0x42)));
        expect(proof.inclusionProof.merkleProof).toEqual([
            Buffer.from(new Uint8Array(32).fill(0x99)).toString("base64"),
        ]);
        expect(toHex(fromBase64(proof.validatorCommitteeBcs))).toBe(
            `0900000000000000` + `01` + `60` + "ab".repeat(96) + `0700000000000000`,
        );
        expect(toHex(fromBase64(proof.checkpointSignatureBcs))).toBe(
            `0900000000000000${"cd".repeat(48)}020102`,
        );
    });

    it("retries on a retryable gRPC status before succeeding", async () => {
        const treeRoot = [...new Uint8Array(32).fill(0x42)];
        const proofMessage = [
            ...pbLenField(1, [
                ...pbStringField(1, objectId),
                ...pbVarintField(2, 1),
                ...pbStringField(3, "11111111111111111111111111111111"),
            ]),
            ...pbLenField(2, [
                ...pbLenField(1, []),
                ...pbVarintField(2, 0),
                ...pbLenField(3, treeRoot),
            ]),
            ...pbLenField(3, [0x05]),
            ...pbLenField(4, [0x07]),
        ];
        let calls = 0;
        const transport = new SuiAlphaAuthenticatedEventsTransport({
            grpcUrl: "https://fullnode.testnet.sui.io:443",
            ledger: stubLedger,
            sleepImpl: async () => {},
            fetchImpl: async () => {
                calls += 1;
                if (calls === 1) {
                    return errorResponse("14", "unavailable");
                }
                return okResponse(proofMessage);
            },
        });

        const proof = await transport.getObjectInclusionProof({ objectId, checkpoint: 1 });
        expect(calls).toBe(2);
        expect(proof.inclusionProof.merkleProof).toEqual([]);
    });
});

describe("createGrpcCheckpointLedgerClient", () => {
    it("reads the checkpoint signature and epoch committee from the v2 ledger service", async () => {
        const ledger = createGrpcCheckpointLedgerClient({
            getCheckpoint: () => ({
                response: Promise.resolve({
                    checkpoint: {
                        signature: {
                            epoch: 9n,
                            signature: new Uint8Array(48).fill(0x01),
                            bitmap: new Uint8Array([0x0a]),
                        },
                    },
                }),
            }),
            getEpoch: () => ({
                response: Promise.resolve({
                    epoch: {
                        committee: {
                            epoch: 9n,
                            members: [{ publicKey: new Uint8Array(96).fill(0x02), weight: 3n }],
                        },
                    },
                }),
            }),
        });

        const signature = await ledger.getCheckpointSignature(100);
        expect(signature.epoch).toBe(9n);
        expect(signature.signature.length).toBe(48);

        const committee = await ledger.getEpochCommittee(9n);
        expect(committee.members[0]?.stake).toBe(3n);
        expect(committee.members[0]?.publicKey.length).toBe(96);
    });

    it("fails closed when the checkpoint signature is missing", async () => {
        const ledger = createGrpcCheckpointLedgerClient({
            getCheckpoint: () => ({ response: Promise.resolve({ checkpoint: {} }) }),
            getEpoch: () => ({ response: Promise.resolve({ epoch: { committee: {} } }) }),
        });
        await expect(ledger.getCheckpointSignature(1)).rejects.toThrow("missing a validator signature");
    });
});
