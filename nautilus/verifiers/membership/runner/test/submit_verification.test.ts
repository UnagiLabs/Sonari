import { describe, expect, it } from "vitest";
import {
    createSubmitVerificationHandler,
    InMemoryVerificationJobRepository,
} from "../src/index.js";
import { validRequest } from "./fixtures.js";

const baseNowMs = 1_800_000_000_000;

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
});
