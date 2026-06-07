export type ResidenceCellClass = "land" | "water" | "unknown";

export interface ResidenceClassification {
    readonly cellDecimal: string;
    readonly classification: ResidenceCellClass;
    readonly reason?: string;
}

export interface ClassifyResidenceCellInput {
    readonly cellDecimal: string;
    readonly workerUrl: string;
    readonly fetchImpl?: typeof fetch;
    readonly signal?: AbortSignal;
}

export type ResidenceClassifierErrorCode = "invalid_h3_index";

export class ResidenceClassifierError extends Error {
    readonly code: ResidenceClassifierErrorCode;
    constructor(code: ResidenceClassifierErrorCode, message: string) {
        super(message);
        this.name = "ResidenceClassifierError";
        this.code = code;
    }
}

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u;

export async function classifyResidenceCell(
    input: ClassifyResidenceCellInput,
): Promise<ResidenceClassification> {
    const { cellDecimal, signal } = input;

    if (!DECIMAL_PATTERN.test(cellDecimal)) {
        throw new ResidenceClassifierError(
            "invalid_h3_index",
            `cellDecimal must be a decimal u64 string, got: ${JSON.stringify(cellDecimal)}`,
        );
    }

    const workerUrl = input.workerUrl.trim();
    if (workerUrl.length === 0) {
        return {
            cellDecimal,
            classification: "unknown",
            reason: "residence proof worker URL is not configured",
        };
    }

    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    const base = workerUrl.replace(/\/+$/u, "");
    const url = `${base}/api/residence-proof?h3_index=${encodeURIComponent(cellDecimal)}`;

    // exactOptionalPropertyTypes 環境では signal: undefined を直接渡せないため条件付きで組み立てる。
    const init: RequestInit = signal === undefined ? { method: "GET" } : { method: "GET", signal };

    let response: Response;
    try {
        response = await fetchImpl(url, init);
    } catch (error) {
        const reason =
            error instanceof Error ? error.message : "Residence proof request failed (network).";
        return { cellDecimal, classification: "unknown", reason };
    }

    if (response.status === 200) {
        return { cellDecimal, classification: "land" };
    }

    if (response.status === 400) {
        let message = `Residence proof worker returned HTTP 400 for cell ${cellDecimal}.`;
        try {
            const body = await response.json() as { error?: { message?: string } };
            if (typeof body?.error?.message === "string") {
                message = body.error.message;
            }
        } catch {
            // body parse failure: use fallback message
        }
        throw new ResidenceClassifierError("invalid_h3_index", message);
    }

    if (response.status === 404) {
        let errorCode: string | undefined;
        let errorMessage: string | undefined;
        try {
            const body = await response.json() as { error?: { code?: string; message?: string } };
            errorCode = body?.error?.code;
            errorMessage = body?.error?.message;
        } catch {
            // body parse failure: treat as unknown
        }

        if (errorCode === "residence_cell_not_allowed") {
            return {
                cellDecimal,
                classification: "water",
                reason:
                    errorMessage ??
                    "Cell is outside the residence allowlist (likely sea or unsupported area)",
            };
        }

        return {
            cellDecimal,
            classification: "unknown",
            reason: `Unexpected 404 from residence proof worker (code: ${errorCode ?? "unknown"}).`,
        };
    }

    return {
        cellDecimal,
        classification: "unknown",
        reason: `Residence proof worker returned HTTP ${response.status}.`,
    };
}
