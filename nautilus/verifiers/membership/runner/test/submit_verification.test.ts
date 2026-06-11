import { describe, expect, it } from "vitest";
import {
    createIdentityStatusHandler,
    createSubmitVerificationHandler,
    identityStatusMessage,
    InMemoryVerificationJobRepository,
    verificationJobStatusResponse,
    type VerificationJobRow,
} from "../src/index.js";
import { validRequest } from "./fixtures.js";

const baseNowMs = 1_800_000_000_000;

function row(overrides: Partial<VerificationJobRow> = {}): VerificationJobRow {
    return {
        job_id: "membership-identity-test",
        request_hash: "hash",
        owner_membership_key: `${validRequest().owner}#${validRequest().membership_id}`,
        request_json: JSON.stringify(validRequest()),
        status: "queued",
        retry_count: 0,
        next_retry_at_ms: null,
        error_code: null,
        error_message: null,
        workflow_execution_name: null,
        workflow_started_at_ms: null,
        tx_digest: null,
        sui_dry_run_result_json: null,
        sui_dry_run_completed_at_ms: null,
        created_at_ms: baseNowMs,
        updated_at_ms: baseNowMs + 1,
        completed_at_ms: null,
        ...overrides,
    };
}

describe("verificationJobStatusResponse", () => {
    it.each([
        ["queued", "queued"],
        ["retry", "queued"],
        ["processing", "processing"],
        ["completed", "completed"],
    ] as const)("maps %s to display status %s", (stored, display) => {
        expect(verificationJobStatusResponse(row({ status: stored })).status).toBe(display);
    });

    it("maps allowlisted failed error codes to rejected", () => {
        expect(
            verificationJobStatusResponse(
                row({ status: "failed", error_code: "WORLD_ID_VERIFICATION_FAILED" }),
            ).status,
        ).toBe("rejected");
    });

    it("keeps unknown failed error codes as failed", () => {
        expect(
            verificationJobStatusResponse(
                row({ status: "failed", error_code: "AWS_MEMBERSHIP_RUNNER_TIMEOUT" }),
            ).status,
        ).toBe("failed");
    });

    it("does not expose raw request_json or internal error fields", () => {
        const response = verificationJobStatusResponse(
            row({
                status: "completed",
                error_code: "SECRET",
                error_message: "internal detail",
                tx_digest: "A1B2C3",
                completed_at_ms: baseNowMs + 100,
            }),
        );

        expect(response).toEqual({
            status: "completed",
            updated_at_ms: baseNowMs + 1,
            completed_at_ms: baseNowMs + 100,
            tx_digest: "A1B2C3",
        });
        expect("request_json" in response).toBe(false);
        expect("error_code" in response).toBe(false);
        expect("error_message" in response).toBe(false);
    });
});

describe("IdentityStatus Lambda", () => {
    function statusRequest(overrides: Record<string, unknown> = {}) {
        const base = {
            owner: validRequest().owner,
            membership_id: validRequest().membership_id,
            issued_at_ms: baseNowMs,
            signature: "signed",
        };
        return { ...base, ...overrides };
    }

    it("rejects unsigned requests", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createIdentityStatusHandler({
            repository,
            now: () => baseNowMs,
            verifySignature: async () => true,
        });
        const { signature: _signature, ...request } = statusRequest();

        const response = await handler({ body: JSON.stringify(request) });

        expect(response.statusCode).toBe(400);
    });

    it("rejects requests when the signature does not match the owner", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createIdentityStatusHandler({
            repository,
            now: () => baseNowMs,
            verifySignature: async () => false,
        });

        const response = await handler({ body: JSON.stringify(statusRequest()) });

        expect(response.statusCode).toBe(401);
        expect(JSON.parse(response.body)).toEqual({
            ok: false,
            message: "status signature is invalid",
        });
    });

    it("rejects expired status signatures", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createIdentityStatusHandler({
            repository,
            now: () => baseNowMs + 10_001,
            maxAgeMs: 10_000,
            verifySignature: async () => true,
        });

        const response = await handler({ body: JSON.stringify(statusRequest()) });

        expect(response.statusCode).toBe(401);
        expect(JSON.parse(response.body)).toEqual({
            ok: false,
            message: "status signature is expired",
        });
    });

    it("returns none when no subject job exists", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createIdentityStatusHandler({
            repository,
            now: () => baseNowMs,
            verifySignature: async () => true,
        });

        const response = await handler({ body: JSON.stringify(statusRequest()) });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ ok: true, status: "none" });
    });

    it("returns only sanitized status for the latest subject job", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const created = await repository.upsertRequest(validRequest(), baseNowMs);
        await repository.markFailed(
            created.row.job_id,
            baseNowMs + 10,
            "WORLD_ID_VERIFICATION_FAILED",
            "internal detail",
        );
        const handler = createIdentityStatusHandler({
            repository,
            now: () => baseNowMs + 20,
            verifySignature: async ({ message, owner }) =>
                owner === validRequest().owner &&
                message === identityStatusMessage(statusRequest()),
        });

        const response = await handler({ body: JSON.stringify(statusRequest()) });
        const body = JSON.parse(response.body) as Record<string, unknown>;

        expect(response.statusCode).toBe(200);
        expect(body).toEqual({
            ok: true,
            status: "rejected",
            updated_at_ms: baseNowMs + 10,
        });
        expect(body.request_json).toBeUndefined();
        expect(body.error_message).toBeUndefined();
    });
});

describe("SubmitVerification Lambda", () => {
    it("rejects malformed requests without storing a job", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
        });

        const response = await handler({
            body: JSON.stringify({
                ...validRequest(),
                membership_id: "0x1234",
            }),
        });

        expect(response.statusCode).toBe(400);
        await expect(repository.all()).resolves.toEqual([]);
    });

    it("stores a valid verification request as a queued job", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
            expectedRegistryId: validRequest().registry_id,
        });

        const response = await handler({ body: JSON.stringify(validRequest()) });
        const body = JSON.parse(response.body) as {
            ok: boolean;
            job_id: string;
            status: string;
            duplicate: boolean;
            tx_digest?: string;
        };

        expect(response.statusCode).toBe(202);
        expect(body).toMatchObject({
            ok: true,
            status: "queued",
            duplicate: false,
        });
        expect(body.tx_digest).toBeUndefined();
        await expect(repository.all()).resolves.toMatchObject([
            {
                job_id: body.job_id,
                status: "queued",
                retry_count: 0,
                tx_digest: null,
            },
        ]);
    });

    it("rejects requests for a registry that does not match AWS configuration", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
            expectedRegistryId: `0x${"aa".repeat(32)}`,
        });

        const response = await handler({ body: JSON.stringify(validRequest()) });
        const body = JSON.parse(response.body) as { ok: boolean; message: string };

        expect(response.statusCode).toBe(400);
        expect(body).toEqual({
            ok: false,
            message: "registry_id does not match configured identity registry",
        });
        await expect(repository.all()).resolves.toEqual([]);
    });

    it("returns the existing job on duplicate submit without replacing tx digest", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
        });

        const first = await handler({ body: JSON.stringify(validRequest()) });
        const firstBody = JSON.parse(first.body) as { job_id: string };
        await repository.markCompleted(firstBody.job_id, baseNowMs + 10, "A1B2C3");

        const duplicate = await handler({ body: JSON.stringify(validRequest()) });
        const duplicateBody = JSON.parse(duplicate.body) as {
            ok: boolean;
            job_id: string;
            status: string;
            duplicate: boolean;
            tx_digest: string;
        };

        expect(duplicate.statusCode).toBe(200);
        expect(duplicateBody).toEqual({
            ok: true,
            job_id: firstBody.job_id,
            status: "completed",
            duplicate: true,
            tx_digest: "A1B2C3",
        });
        await expect(repository.get(firstBody.job_id)).resolves.toMatchObject({
            status: "completed",
            tx_digest: "A1B2C3",
        });
    });

    it("rejects unknown fields so raw personal data is not accepted into the job row", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
        });

        const response = await handler({
            body: JSON.stringify({
                ...validRequest(),
                passport_image: "s3://raw-pii",
            }),
        });

        expect(response.statusCode).toBe(400);
        await expect(repository.all()).resolves.toEqual([]);
    });

    it("rejects old v2 world_id fields (world_app_id, nullifier_hash, etc.) with 400", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
        });

        const response = await handler({
            body: JSON.stringify({
                ...validRequest(),
                world_id: {
                    world_app_id: "app_staging_123",
                    nullifier_hash: "12345678901234567890",
                    merkle_root: "0xabc",
                    proof: "0xproof",
                    verification_level: "orb",
                    action: "sonari_membership_register_v1",
                    signal_hash: `0x${"55".repeat(32)}`,
                },
            }),
        });

        expect(response.statusCode).toBe(400);
        await expect(repository.all()).resolves.toEqual([]);
    });

    it("rejects world_id with unexpected extra fields (not idkit_response) with 400", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
        });

        const response = await handler({
            body: JSON.stringify({
                ...validRequest(),
                world_id: {
                    idkit_response: { protocol_version: "4.0" },
                    extra_field: "should-be-rejected",
                },
            }),
        });

        expect(response.statusCode).toBe(400);
        await expect(repository.all()).resolves.toEqual([]);
    });

    it("rejects world_id without idkit_response with 400", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
        });

        const response = await handler({
            body: JSON.stringify({
                ...validRequest(),
                world_id: {},
            }),
        });

        expect(response.statusCode).toBe(400);
        await expect(repository.all()).resolves.toEqual([]);
    });

    it("rejects world_id.idkit_response that is an array with 400", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
        });

        const response = await handler({
            body: JSON.stringify({
                ...validRequest(),
                world_id: { idkit_response: [] },
            }),
        });

        expect(response.statusCode).toBe(400);
        await expect(repository.all()).resolves.toEqual([]);
    });

    it("rejects world_id.idkit_response that is a string with 400", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
        });

        const response = await handler({
            body: JSON.stringify({
                ...validRequest(),
                world_id: { idkit_response: "not-an-object" },
            }),
        });

        expect(response.statusCode).toBe(400);
        await expect(repository.all()).resolves.toEqual([]);
    });

    it("returns the same job_id for idempotent v4 duplicate submit", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
        });

        const first = await handler({ body: JSON.stringify(validRequest()) });
        const firstBody = JSON.parse(first.body) as { job_id: string; duplicate: boolean };
        expect(first.statusCode).toBe(202);
        expect(firstBody.duplicate).toBe(false);

        const second = await handler({ body: JSON.stringify(validRequest()) });
        const secondBody = JSON.parse(second.body) as { job_id: string; duplicate: boolean };
        expect(second.statusCode).toBe(200);
        expect(secondBody.job_id).toBe(firstBody.job_id);
        expect(secondBody.duplicate).toBe(true);
    });

    it("produces the same job_id regardless of idkit_response key order (nested idempotency)", async () => {
        const repository = new InMemoryVerificationJobRepository();

        const req1 = {
            ...validRequest(),
            world_id: {
                idkit_response: {
                    protocol_version: "4.0",
                    nonce: "nonce-123",
                    action: "sonari_membership_register_v1",
                },
            },
        };
        // Same content, different key order
        const req2 = {
            ...validRequest(),
            world_id: {
                idkit_response: {
                    action: "sonari_membership_register_v1",
                    nonce: "nonce-123",
                    protocol_version: "4.0",
                },
            },
        };

        const result1 = await repository.upsertRequest(req1, baseNowMs);
        const result2 = await repository.upsertRequest(req2, baseNowMs);

        expect(result1.row.job_id).toBe(result2.row.job_id);
        expect(result2.duplicate).toBe(true);
    });

    it("accepts idkit_response with unknown future fields and preserves them in request_json", async () => {
        const repository = new InMemoryVerificationJobRepository();
        const handler = createSubmitVerificationHandler({
            repository,
            now: () => baseNowMs,
        });

        const requestWithExtraFields = {
            ...validRequest(),
            world_id: {
                idkit_response: {
                    protocol_version: "4.0",
                    nonce: "nonce-123",
                    action: "sonari_membership_register_v1",
                    extra_meta: "future-field",
                    responses: [
                        {
                            identifier: "orb",
                            signal_hash:
                                "0x004c584cd5e136507a762e7bc3bdd3f2e2535f5d32a7c6f343e17377886cca47",
                            proof: "0xproof",
                            merkle_root: "987654321",
                            nullifier: "12345678901234567890",
                            future_field: "allowed-passthrough",
                        },
                    ],
                },
            },
        };

        const response = await handler({ body: JSON.stringify(requestWithExtraFields) });
        expect(response.statusCode).toBe(202);

        const rows = await repository.all();
        expect(rows).toHaveLength(1);
        // biome-ignore lint/style/noNonNullAssertion: asserted by toHaveLength(1) above
        const storedRequest = JSON.parse(rows[0]!.request_json) as {
            world_id?: {
                idkit_response?: {
                    extra_meta?: string;
                    responses?: Array<{ future_field?: string }>;
                };
            };
        };
        expect(storedRequest.world_id?.idkit_response?.extra_meta).toBe("future-field");
        expect(storedRequest.world_id?.idkit_response?.responses?.[0]?.future_field).toBe(
            "allowed-passthrough",
        );
    });
});
