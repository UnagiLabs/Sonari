import { describe, expect, it } from "vitest";
import {
    DynamoDbVerificationJobRepository,
    InMemoryVerificationJobRepository,
} from "../src/index.js";
import { validRequest } from "./fixtures.js";

type CapturedCommand = { input: Record<string, unknown> };

/**
 * Minimal DynamoDB document client stub that records the commands the
 * repository sends and answers the existence `GetCommand` with "no row yet".
 */
function recordingClient(captured: CapturedCommand[]) {
    return {
        send: async (command: unknown) => {
            const typed = command as CapturedCommand;
            captured.push(typed);
            if ("Item" in typed.input) {
                // PutCommand
                return {};
            }
            // GetCommand existence check → no existing row
            return { Item: undefined };
        },
    };
}

describe("DynamoDbVerificationJobRepository.upsertRequest", () => {
    it("does not persist NULL tx_digest / completed_at_ms so markCompleted's if_not_exists can later record them", async () => {
        // Regression guard: DynamoDB `if_not_exists(attr, value)` treats an
        // attribute that exists as NULL as "already set" and never overwrites it.
        // markCompleted / recordSuiSubmitDigest rely on if_not_exists, so the
        // initial row must NOT pre-create tx_digest / completed_at_ms as NULL.
        const captured: CapturedCommand[] = [];
        const repo = new DynamoDbVerificationJobRepository("jobs", recordingClient(captured));

        await repo.upsertRequest(validRequest(), 1000);

        const put = captured.find((command) => "Item" in command.input);
        expect(put).toBeDefined();
        const item = put?.input.Item as Record<string, unknown>;

        expect(item).not.toHaveProperty("tx_digest");
        expect(item).not.toHaveProperty("completed_at_ms");

        // Core attributes are still written.
        expect(item.status).toBe("queued");
        expect(typeof item.job_id).toBe("string");
        expect(item.owner_membership_key).toBe(
            `${validRequest().owner}#${validRequest().membership_id}`,
        );
        expect(item.created_at_ms).toBe(1000);
    });

    it("queries the owner-membership index for the latest subject job without Scan", async () => {
        const captured: CapturedCommand[] = [];
        const repo = new DynamoDbVerificationJobRepository("jobs", recordingClient(captured));

        await repo.getLatestForSubject(validRequest().owner, validRequest().membership_id);

        expect(captured).toHaveLength(1);
        expect(captured[0]?.input).toMatchObject({
            TableName: "jobs",
            IndexName: "OwnerMembershipUpdatedAtIndex",
            KeyConditionExpression: "owner_membership_key = :owner_membership_key",
            ScanIndexForward: false,
            Limit: 1,
        });
        expect(captured[0]?.input).not.toHaveProperty("FilterExpression");
    });
});

describe("InMemoryVerificationJobRepository.getLatestForSubject", () => {
    it("returns the newest job for the same owner and membership", async () => {
        const repo = new InMemoryVerificationJobRepository();
        const older = await repo.upsertRequest(validRequest(), 1000);
        const newerRequest = { ...validRequest(), terms_version: 2 };
        const newer = await repo.upsertRequest(newerRequest, 2000);

        await expect(
            repo.getLatestForSubject(validRequest().owner, validRequest().membership_id),
        ).resolves.toMatchObject({
            job_id: newer.row.job_id,
            updated_at_ms: 2000,
        });
        expect(older.row.job_id).not.toBe(newer.row.job_id);
    });

    it("does not return another wallet's job", async () => {
        const repo = new InMemoryVerificationJobRepository();
        const otherOwnerRequest = { ...validRequest(), owner: `0x${"aa".repeat(32)}` };
        await repo.upsertRequest(otherOwnerRequest, 1000);

        await expect(
            repo.getLatestForSubject(validRequest().owner, validRequest().membership_id),
        ).resolves.toBeNull();
    });
});
