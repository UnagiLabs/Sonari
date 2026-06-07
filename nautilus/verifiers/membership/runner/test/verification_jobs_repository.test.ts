import { describe, expect, it } from "vitest";
import { DynamoDbVerificationJobRepository } from "../src/index.js";
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
        expect(item.created_at_ms).toBe(1000);
    });
});
