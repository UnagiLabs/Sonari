import { createHash } from "node:crypto";

export interface EventUidInput {
    hazard_type: number;
    primary_source: string;
    source_event_id: string;
    occurred_at_ms: number;
}

const EVENT_UID_PREFIX = "sonari:event_uid:v1";

export function computeEventUid(input: EventUidInput): string {
    assertU8(input.hazard_type, "hazard_type");
    assertUtf8U32Length(input.primary_source, "primary_source");
    assertUtf8U32Length(input.source_event_id, "source_event_id");
    assertUnixMs(input.occurred_at_ms, "occurred_at_ms");

    const primarySource = Buffer.from(input.primary_source, "utf8");
    const sourceEventId = Buffer.from(input.source_event_id, "utf8");
    const occurredAtMs = BigInt(input.occurred_at_ms);
    const data = Buffer.concat([
        Buffer.from(EVENT_UID_PREFIX, "utf8"),
        Buffer.from([input.hazard_type]),
        u32Le(primarySource.length),
        primarySource,
        u32Le(sourceEventId.length),
        sourceEventId,
        u64Le(occurredAtMs),
    ]);
    return `0x${createHash("sha256").update(data).digest("hex")}`;
}

function assertU8(input: number, field: string): void {
    if (!Number.isSafeInteger(input) || input < 0 || input > 255) {
        throw new Error(`${field} must be a u8`);
    }
}

function assertUtf8U32Length(input: string, field: string): void {
    if (input.length === 0) {
        throw new Error(`${field} must be non-empty`);
    }
    const byteLength = Buffer.byteLength(input, "utf8");
    if (byteLength > 0xffffffff) {
        throw new Error(`${field} length exceeds u32`);
    }
}

function assertUnixMs(input: number, field: string): void {
    if (!Number.isSafeInteger(input) || input < 0) {
        throw new Error(`${field} must be a non-negative safe integer`);
    }
}

function u32Le(input: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(input, 0);
    return bytes;
}

function u64Le(input: bigint): Buffer {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(input, 0);
    return bytes;
}
