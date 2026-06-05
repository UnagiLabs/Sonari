export const U64_MAX = 18_446_744_073_709_551_615n;

export type PrefixedHex32 = `0x${string}`;

export function u64LittleEndianBytes(value: bigint): Uint8Array {
    if (value < 0n || value > U64_MAX) {
        throw new Error(`u64 value is outside range: ${value}`);
    }
    const bytes = new Uint8Array(8);
    for (let index = 0; index < 8; index += 1) {
        bytes[index] = Number((value >> BigInt(index * 8)) & 0xffn);
    }
    return bytes;
}

export function u64BigEndianBytes(value: bigint): Uint8Array {
    if (value < 0n || value > U64_MAX) {
        throw new Error(`u64 value is outside range: ${value}`);
    }
    const bytes = new Uint8Array(8);
    for (let index = 7; index >= 0; index -= 1) {
        bytes[index] = Number((value >> BigInt((7 - index) * 8)) & 0xffn);
    }
    return bytes;
}

export function bytesToBigEndianU64(bytes: Uint8Array): bigint {
    if (bytes.length !== 8) {
        throw new Error("u64 byte prefix must be 8 bytes");
    }
    let value = 0n;
    for (const byte of bytes) {
        value = (value << 8n) | BigInt(byte);
    }
    return value;
}

export function hexToBytes(value: PrefixedHex32): Uint8Array {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
    }
    return bytes;
}

export function bytesToPrefixedHex(bytes: Uint8Array): PrefixedHex32 {
    return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<PrefixedHex32> {
    return bytesToPrefixedHex(await sha256Bytes(bytes));
}

export async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return new Uint8Array(digest);
}
