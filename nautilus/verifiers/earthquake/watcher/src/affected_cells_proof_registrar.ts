export interface AffectedCellsProofRegistrationInput {
    event_uid: string;
    event_revision: number;
    affected_cells_uri: string;
    affected_cells_hash: string;
    affected_cells_root: string;
    affected_cell_count: number;
    geo_resolution: number;
}

export interface AffectedCellsProofRegistrationResult {
    stored: boolean;
    shardCount: number;
}

export interface AffectedCellsProofRegistrarSecretReader {
    getSecretString(secretArn: string): Promise<string>;
}

export type AffectedCellsProofRegistrationErrorKind = "configuration" | "integrity" | "retryable";

export class AffectedCellsProofRegistrationError extends Error {
    constructor(
        message: string,
        readonly kind: AffectedCellsProofRegistrationErrorKind,
    ) {
        super(message);
        this.name = new.target.name;
    }
}

export class RetryableAffectedCellsProofRegistrationError extends AffectedCellsProofRegistrationError {
    constructor(message: string) {
        super(message, "retryable");
    }
}

export class ConfigurationAffectedCellsProofRegistrationError extends AffectedCellsProofRegistrationError {
    constructor(message: string) {
        super(message, "configuration");
    }
}

export class IntegrityAffectedCellsProofRegistrationError extends AffectedCellsProofRegistrationError {
    constructor(message: string) {
        super(message, "integrity");
    }
}

export class HttpAffectedCellsProofRegistrar {
    constructor(
        private readonly endpoint: string,
        private readonly auth: {
            secretArn: string;
            secretReader: AffectedCellsProofRegistrarSecretReader;
        },
        private readonly timeoutMs = 30_000,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    async register(
        input: AffectedCellsProofRegistrationInput,
    ): Promise<AffectedCellsProofRegistrationResult> {
        const response = await fetchWithTimeout(
            registrationUrl(this.endpoint, input),
            {
                method: "POST",
                headers: await this.headers(),
                body: JSON.stringify(input),
            },
            this.timeoutMs,
            this.fetchImpl,
        );
        if (!response.ok) {
            throw await registrationErrorForResponse(response);
        }
        const body = (await readJson(response)) as unknown;
        return validateRegistrationResponse(body, input);
    }

    private async headers(): Promise<Record<string, string>> {
        return {
            "content-type": "application/json",
            "x-sonari-affected-proof-register-token": await this.token(),
        };
    }

    private async token(): Promise<string> {
        const token = (await this.auth.secretReader.getSecretString(this.auth.secretArn)).trim();
        if (token.length === 0) {
            throw new ConfigurationAffectedCellsProofRegistrationError(
                `${this.auth.secretArn} did not contain SecretString`,
            );
        }
        return token;
    }

    static classify(error: unknown): AffectedCellsProofRegistrationErrorKind {
        return error instanceof AffectedCellsProofRegistrationError ? error.kind : "retryable";
    }
}

function registrationUrl(endpoint: string, input: AffectedCellsProofRegistrationInput): string {
    const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
    return `${base}/events/${encodeURIComponent(input.event_uid)}/revisions/${input.event_revision}/affected-cells`;
}

async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    fetchImpl: typeof fetch,
): Promise<Response>;
async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
): Promise<Response>;
async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    fetchImpl: typeof fetch = fetch,
): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
        if (isAbortError(error)) {
            throw new RetryableAffectedCellsProofRegistrationError(
                "affected cells proof registration request timed out",
            );
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function registrationErrorForResponse(
    response: Response,
): Promise<AffectedCellsProofRegistrationError> {
    const message = `affected cells proof registration failed: HTTP ${response.status}`;
    const errorKind = await readWorkerErrorKind(response);
    if (errorKind === "configuration") {
        return new ConfigurationAffectedCellsProofRegistrationError(message);
    }
    if (errorKind === "integrity") {
        return new IntegrityAffectedCellsProofRegistrationError(message);
    }
    if (response.status >= 500 || errorKind === "retryable") {
        return new RetryableAffectedCellsProofRegistrationError(message);
    }
    if (response.status === 409 || response.status === 422) {
        return new IntegrityAffectedCellsProofRegistrationError(message);
    }
    return new ConfigurationAffectedCellsProofRegistrationError(message);
}

async function readWorkerErrorKind(
    response: Response,
): Promise<AffectedCellsProofRegistrationErrorKind | undefined> {
    try {
        const body = (await response.clone().json()) as unknown;
        if (!isRecord(body)) {
            return undefined;
        }
        const error = body.error;
        if (error === "configuration" || error === "integrity" || error === "retryable") {
            return error;
        }
        if (isRecord(error)) {
            const kind = error.kind;
            if (kind === "configuration" || kind === "integrity" || kind === "retryable") {
                return kind;
            }
        }
        return undefined;
    } catch {
        return undefined;
    }
}

async function readJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        throw new RetryableAffectedCellsProofRegistrationError(
            "affected cells proof registration returned invalid JSON",
        );
    }
}

function validateRegistrationResponse(
    body: unknown,
    input: AffectedCellsProofRegistrationInput,
): AffectedCellsProofRegistrationResult {
    if (!isRecord(body)) {
        throw new RetryableAffectedCellsProofRegistrationError(
            "affected cells proof registration response must be an object",
        );
    }
    if (body.event_uid !== input.event_uid) {
        throw new IntegrityAffectedCellsProofRegistrationError(
            "affected cells proof registration event_uid mismatch",
        );
    }
    if (body.event_revision !== input.event_revision) {
        throw new IntegrityAffectedCellsProofRegistrationError(
            "affected cells proof registration event_revision mismatch",
        );
    }
    if (body.affected_cells_root !== input.affected_cells_root) {
        throw new IntegrityAffectedCellsProofRegistrationError(
            "affected cells proof registration root mismatch",
        );
    }
    if (typeof body.stored !== "boolean") {
        throw new RetryableAffectedCellsProofRegistrationError(
            "affected cells proof registration response stored must be boolean",
        );
    }
    if (
        typeof body.shard_count !== "number" ||
        !Number.isSafeInteger(body.shard_count) ||
        body.shard_count < 1
    ) {
        throw new RetryableAffectedCellsProofRegistrationError(
            "affected cells proof registration response shard_count is invalid",
        );
    }
    return {
        stored: body.stored,
        shardCount: body.shard_count,
    };
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
