import { describe, expect, it } from "vitest";
import {
    ConfigurationAffectedCellsProofRegistrationError,
    HttpAffectedCellsProofRegistrar,
    IntegrityAffectedCellsProofRegistrationError,
    RetryableAffectedCellsProofRegistrationError,
    type AffectedCellsProofRegistrationInput,
    type AffectedCellsProofRegistrarSecretReader,
} from "../src/affected_cells_proof_registrar.js";

const input: AffectedCellsProofRegistrationInput = {
    event_uid: `0x${"12".repeat(32)}`,
    event_revision: 2,
    affected_cells_uri: "walrus://blob/cellsBlob_123456",
    affected_cells_hash: `0x${"34".repeat(32)}`,
    affected_cells_root: `0x${"56".repeat(32)}`,
    affected_cell_count: 18429,
    geo_resolution: 7,
};

describe("HttpAffectedCellsProofRegistrar", () => {
    it("posts the worker registration body with the runner-only token", async () => {
        const fetchCalls: Array<{ url: string; headers: Record<string, string>; body: unknown }> =
            [];
        const registrar = new HttpAffectedCellsProofRegistrar(
            "https://proof-worker.test/",
            {
                secretArn: "arn:aws:secretsmanager:affected-proof-token",
                secretReader: new RecordingSecretReader("registrar-token"),
            },
            30_000,
            (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
                fetchCalls.push({
                    url: String(url),
                    headers: normalizeHeaders(init?.headers),
                    body: JSON.parse(String(init?.body)) as unknown,
                });
                return new Response(
                    JSON.stringify({
                        event_uid: input.event_uid,
                        event_revision: input.event_revision,
                        affected_cells_root: input.affected_cells_root,
                        shard_count: 1,
                        stored: true,
                    }),
                    { status: 200 },
                );
            }) as typeof fetch,
        );

        await expect(registrar.register(input)).resolves.toEqual({
            stored: true,
            shardCount: 1,
        });

        expect(fetchCalls).toEqual([
            {
                url: `https://proof-worker.test/events/${encodeURIComponent(input.event_uid)}/revisions/2/affected-cells`,
                headers: {
                    "content-type": "application/json",
                    "x-sonari-affected-proof-register-token": "registrar-token",
                },
                body: input,
            },
        ]);
    });

    it("accepts idempotent stored false responses", async () => {
        const registrar = registrarWithResponse(
            new Response(
                JSON.stringify({
                    event_uid: input.event_uid,
                    event_revision: input.event_revision,
                    affected_cells_root: input.affected_cells_root,
                    shard_count: 1,
                    stored: false,
                }),
                { status: 200 },
            ),
        );

        await expect(registrar.register(input)).resolves.toEqual({
            stored: false,
            shardCount: 1,
        });
    });

    it("rejects empty Secrets Manager token values as configuration failures", async () => {
        const registrar = new HttpAffectedCellsProofRegistrar(
            "https://proof-worker.test",
            {
                secretArn: "arn:aws:secretsmanager:affected-proof-token",
                secretReader: new RecordingSecretReader("   "),
            },
            30_000,
            (async () => new Response("{}")) as typeof fetch,
        );

        await expect(registrar.register(input)).rejects.toBeInstanceOf(
            ConfigurationAffectedCellsProofRegistrationError,
        );
    });

    it("classifies timeout, 408, 429, and 5xx responses as retryable", async () => {
        for (const status of [408, 429, 503]) {
            await expect(registrarWithResponse(new Response("unavailable", { status })).register(
                input,
            )).rejects.toBeInstanceOf(RetryableAffectedCellsProofRegistrationError);
        }

        const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
        const registrar = new HttpAffectedCellsProofRegistrar(
            "https://proof-worker.test",
            {
                secretArn: "arn:aws:secretsmanager:affected-proof-token",
                secretReader: new RecordingSecretReader("registrar-token"),
            },
            1,
            (async () => {
                throw abortError;
            }) as typeof fetch,
        );
        await expect(registrar.register(input)).rejects.toBeInstanceOf(
            RetryableAffectedCellsProofRegistrationError,
        );
    });

    it("includes the failed response body in retryable error messages", async () => {
        await expect(
            registrarWithResponse(new Response("error code: 1102", { status: 503 })).register(
                input,
            ),
        ).rejects.toMatchObject({
            message:
                'affected cells proof registration failed: HTTP 503 body="error code: 1102"',
        });
    });

    it("truncates failed response bodies and removes control characters", async () => {
        await expect(
            registrarWithResponse(
                new Response(`first "quoted"\n\t\0${"a".repeat(220)}`, { status: 503 }),
            ).register(input),
        ).rejects.toSatisfy((error: unknown) => {
            expect(error).toBeInstanceOf(RetryableAffectedCellsProofRegistrationError);
            expect(error).toBeInstanceOf(Error);
            const message = (error as Error).message;
            expect(message).toContain(' body="first \\"quoted\\"');
            const bodyPrefix = ' body="';
            const bodyStart = message.indexOf(bodyPrefix) + bodyPrefix.length;
            const body = message.slice(bodyStart, -1);
            expect(body).toHaveLength(200);
            expect(body).not.toMatch(/[\u0000-\u001f\u007f]/u);
            return true;
        });
    });

    it("falls back to the status-only error message when response body reading fails", async () => {
        const registrar = new HttpAffectedCellsProofRegistrar(
            "https://proof-worker.test",
            {
                secretArn: "arn:aws:secretsmanager:affected-proof-token",
                secretReader: new RecordingSecretReader("registrar-token"),
            },
            30_000,
            (async () => unreadableResponse(503)) as typeof fetch,
        );

        await expect(registrar.register(input)).rejects.toMatchObject({
            message: "affected cells proof registration failed: HTTP 503",
        });
        await expect(registrar.register(input)).rejects.toBeInstanceOf(
            RetryableAffectedCellsProofRegistrationError,
        );
    });

    it("classifies 400 and 401 responses as configuration failures", async () => {
        for (const status of [400, 401]) {
            await expect(registrarWithResponse(new Response("bad request", { status })).register(
                input,
            )).rejects.toBeInstanceOf(ConfigurationAffectedCellsProofRegistrationError);
        }
    });

    it("classifies 409 and 422 responses as integrity failures", async () => {
        for (const status of [409, 422]) {
            await expect(registrarWithResponse(new Response("mismatch", { status })).register(
                input,
            )).rejects.toBeInstanceOf(IntegrityAffectedCellsProofRegistrationError);
        }
    });

    it("rejects malformed success responses as retryable and mismatched roots as integrity", async () => {
        await expect(registrarWithResponse(new Response("{", { status: 200 })).register(
            input,
        )).rejects.toBeInstanceOf(RetryableAffectedCellsProofRegistrationError);

        await expect(
            registrarWithResponse(
                new Response(
                    JSON.stringify({
                        event_uid: input.event_uid,
                        event_revision: input.event_revision,
                        affected_cells_root: `0x${"99".repeat(32)}`,
                        shard_count: 1,
                        stored: true,
                    }),
                    { status: 200 },
                ),
            ).register(input),
        ).rejects.toBeInstanceOf(IntegrityAffectedCellsProofRegistrationError);
    });
});

function registrarWithResponse(response: Response): HttpAffectedCellsProofRegistrar {
    return new HttpAffectedCellsProofRegistrar(
        "https://proof-worker.test",
        {
            secretArn: "arn:aws:secretsmanager:affected-proof-token",
            secretReader: new RecordingSecretReader("registrar-token"),
        },
        30_000,
        (async () => response.clone()) as typeof fetch,
    );
}

function unreadableResponse(status: number): Response {
    return {
        ok: false,
        status,
        clone: () => ({
            json: async () => {
                throw new Error("body read failed");
            },
            text: async () => {
                throw new Error("body read failed");
            },
        }),
    } as unknown as Response;
}

function normalizeHeaders(headers: RequestInit["headers"] | undefined): Record<string, string> {
    if (headers === undefined) {
        return {};
    }
    if (headers instanceof Headers) {
        return Object.fromEntries(headers.entries());
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }
    return Object.fromEntries(
        Object.entries(headers).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    );
}

class RecordingSecretReader implements AffectedCellsProofRegistrarSecretReader {
    readonly reads: string[] = [];

    constructor(private readonly value: string) {}

    async getSecretString(secretArn: string): Promise<string> {
        this.reads.push(secretArn);
        return this.value;
    }
}
