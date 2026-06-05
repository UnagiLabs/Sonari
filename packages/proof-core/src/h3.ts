import { U64_MAX } from "./bytes.js";

export const H3_MAX_RESOLUTION = 15;
export const H3_MODE_CELL = 1n;
export const H3_PENTAGON_BASE_CELLS = new Set([4, 14, 24, 38, 49, 58, 63, 72, 83, 97, 107, 117]);

export interface ParsedH3Index {
    decimal: string;
    value: bigint;
}

export function parseH3Index(value: string, expectedResolution: number): ParsedH3Index {
    if (
        !Number.isInteger(expectedResolution) ||
        expectedResolution < 0 ||
        expectedResolution > 15
    ) {
        throw new Error(`expected resolution must be between 0 and 15: ${expectedResolution}`);
    }
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`h3_index must be a canonical decimal u64 string: ${value}`);
    }

    const parsed = BigInt(value);
    if (parsed > U64_MAX) {
        throw new Error(`h3_index is outside the u64 range: ${value}`);
    }

    validateH3CellLayout(parsed, expectedResolution, value);
    return { decimal: value, value: parsed };
}

export function validateH3CellLayout(
    h3Index: bigint,
    expectedResolution: number,
    rawValue: string,
): void {
    if (((h3Index >> 63n) & 1n) !== 0n) {
        throw new Error(`h3_index reserved bit must be zero: ${rawValue}`);
    }
    const mode = (h3Index >> 59n) & 0xfn;
    if (mode !== H3_MODE_CELL) {
        throw new Error(`h3_index mode must be an H3 cell: ${rawValue}`);
    }
    if (((h3Index >> 56n) & 0x7n) !== 0n) {
        throw new Error(`h3_index reserved bits must be zero: ${rawValue}`);
    }
    const resolution = Number((h3Index >> 52n) & 0xfn);
    if (resolution !== expectedResolution) {
        throw new Error(`h3_index resolution must be ${expectedResolution}: ${rawValue}`);
    }
    const baseCell = Number((h3Index >> 45n) & 0x7fn);
    if (baseCell > 121) {
        throw new Error(`h3_index base cell is outside the H3 range: ${rawValue}`);
    }

    let leadingNonZeroDigit = 0;
    for (let digit = 1; digit <= H3_MAX_RESOLUTION; digit += 1) {
        const digitValue = Number((h3Index >> BigInt((H3_MAX_RESOLUTION - digit) * 3)) & 0x7n);
        if (digit <= expectedResolution && digitValue === 7) {
            throw new Error(`h3_index active digit must be 0..6: ${rawValue}`);
        }
        if (digit <= expectedResolution && leadingNonZeroDigit === 0 && digitValue !== 0) {
            leadingNonZeroDigit = digitValue;
        }
        if (digit > expectedResolution && digitValue !== 7) {
            throw new Error(`h3_index unused digit must be 7: ${rawValue}`);
        }
    }
    if (H3_PENTAGON_BASE_CELLS.has(baseCell) && leadingNonZeroDigit === 1) {
        throw new Error(`h3_index uses the deleted pentagon subsequence: ${rawValue}`);
    }
}
