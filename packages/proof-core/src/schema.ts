export type JsonRecord = Record<string, unknown>;

export function expectRecord(name: string, value: unknown): JsonRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${name} must be an object`);
    }
    return value as JsonRecord;
}

export function expectKeys(name: string, record: JsonRecord, keys: readonly string[]): void {
    const expected = new Set(keys);
    for (const key of Object.keys(record)) {
        if (!expected.has(key)) {
            throw new Error(`${name} contains unexpected field: ${key}`);
        }
    }
    for (const key of keys) {
        if (!(key in record)) {
            throw new Error(`${name} is missing field: ${key}`);
        }
    }
}

export function expectString(name: string, value: unknown): string {
    if (typeof value !== "string") {
        throw new Error(`${name} must be a string`);
    }
    return value;
}

export function expectBoolean(name: string, value: unknown): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`${name} must be a boolean`);
    }
    return value;
}

export function expectArray(name: string, value: unknown): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${name} must be an array`);
    }
    return value;
}

export function expectLiteral<T extends string | number>(
    name: string,
    value: unknown,
    expected: T,
): T {
    if (value !== expected) {
        throw new Error(`${name} must be ${expected}`);
    }
    return expected;
}

export function expectNonNegativeSafeInteger(name: string, value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
    return value;
}

export function expectPositiveSafeInteger(name: string, value: unknown): number {
    const parsed = expectNonNegativeSafeInteger(name, value);
    if (parsed === 0) {
        throw new Error(`${name} must be greater than zero`);
    }
    return parsed;
}

export function assertNonNegativeSafeInteger(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
}

export function expectPrefixedHex32(name: string, value: unknown): `0x${string}` {
    if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
        throw new Error(`${name} must be a lowercase 0x-prefixed 32-byte hex string`);
    }
    return value as `0x${string}`;
}

export function assertMatches<T>(name: string, actual: T, expected: T): void {
    if (actual !== expected) {
        throw new Error(`${name} ${actual} does not match ${expected}`);
    }
}
