export type DonationAmountErrorCode =
    | "empty"
    | "invalid_format"
    | "negative"
    | "zero"
    | "too_many_decimals"
    | "overflow";

export type DonationAmountValidationResult =
    | { readonly ok: true; readonly microUsdc: bigint }
    | { readonly ok: false; readonly errorCode: DonationAmountErrorCode };

const USDC_DECIMALS = 6;
const MICRO_USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);
const MAX_U64 = (1n << 64n) - 1n;

export function parseDonationAmountToMicroUsdc(input: string): bigint {
    const result = validateDonationAmount(input);
    if (!result.ok) {
        throw new Error(result.errorCode);
    }
    return result.microUsdc;
}

export function validateDonationAmount(input: string): DonationAmountValidationResult {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return { ok: false, errorCode: "empty" };
    }

    const withoutCurrency = trimmed.replace(/^\$/u, "").trim();
    if (withoutCurrency.length === 0) {
        return { ok: false, errorCode: "invalid_format" };
    }

    if (withoutCurrency.startsWith("-")) {
        return { ok: false, errorCode: "negative" };
    }

    const amountParts = withoutCurrency.split(".");
    if (amountParts.length > 2) {
        return { ok: false, errorCode: "invalid_format" };
    }
    const integerPartRaw = amountParts[0] ?? "";
    const fractionalPartRaw = amountParts[1];

    if (integerPartRaw.length === 0 && (fractionalPartRaw ?? "").length === 0) {
        return { ok: false, errorCode: "invalid_format" };
    }

    if (fractionalPartRaw !== undefined && fractionalPartRaw.length > USDC_DECIMALS) {
        return { ok: false, errorCode: "too_many_decimals" };
    }

    if (!isValidIntegerPart(integerPartRaw)) {
        return { ok: false, errorCode: "invalid_format" };
    }
    if (fractionalPartRaw !== undefined && !isValidFractionalPart(fractionalPartRaw)) {
        return { ok: false, errorCode: "invalid_format" };
    }

    const integerDigits = integerPartRaw === "" ? "0" : integerPartRaw.replace(/,/gu, "");
    const fractionalDigits = (fractionalPartRaw ?? "").padEnd(USDC_DECIMALS, "0");

    let microUsdc: bigint;
    try {
        microUsdc =
            BigInt(integerDigits) * MICRO_USDC_SCALE +
            (fractionalDigits.length === 0 ? 0n : BigInt(fractionalDigits));
    } catch {
        return { ok: false, errorCode: "invalid_format" };
    }

    if (microUsdc === 0n) {
        return { ok: false, errorCode: "zero" };
    }
    if (microUsdc > MAX_U64) {
        return { ok: false, errorCode: "overflow" };
    }

    return { ok: true, microUsdc };
}

function isValidIntegerPart(value: string): boolean {
    if (value.length === 0) {
        return true;
    }
    if (value.includes(",")) {
        return /^(?:\d{1,3})(?:,\d{3})*$/u.test(value);
    }
    return /^\d+$/u.test(value);
}

function isValidFractionalPart(value: string): boolean {
    return /^\d*$/u.test(value);
}
