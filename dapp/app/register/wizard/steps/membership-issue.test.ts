import type { ClientWithCoreApi } from "@mysten/sui/client";
import { describe, expect, it } from "vitest";
import { MEMBERSHIP_TERMS_VERSION } from "../../terms-version";
import {
    buildRegisterMemberTransaction,
    fetchResidenceProof,
    issueMembershipPass,
    MembershipIssueError,
    type ResidenceProofResponse,
} from "./membership-issue";

const PACKAGE_ID = `0x${"aa".repeat(32)}`;
const SENDER = `0x${"11".repeat(32)}`;
const PAUSE_STATE = `0x${"12".repeat(32)}`;
const MEMBERSHIP_REGISTRY = `0x${"13".repeat(32)}`;
const ALLOWED_RESIDENCE_CELL_REGISTRY = `0x${"14".repeat(32)}`;
const HOME_CELL = "608819013681676287";
const WRONG_HOME_CELL = "608819013597790207";
const RESIDENCE_PROOF: ResidenceProofResponse = {
    h3_index: HOME_CELL,
    allowlist_version: 1,
    geo_resolution: 7,
    merkle_root: `0x${"22".repeat(32)}`,
    proof: [
        {
            sibling_on_left: true,
            sibling_hash: `0x${"33".repeat(32)}`,
        },
    ],
};

describe("membership issue helpers", () => {
    it("fetches residence proof from the worker endpoint", async () => {
        const calls: string[] = [];
        const fetchImpl = async (url: string | URL) => {
            calls.push(String(url));
            return {
                status: 200,
                ok: true,
                json: async () => RESIDENCE_PROOF,
            } as Response;
        };

        await expect(
            fetchResidenceProof({
                workerUrl: "https://worker.example/",
                homeCell: HOME_CELL,
                fetchImpl,
            }),
        ).resolves.toEqual(RESIDENCE_PROOF);
        expect(calls).toEqual([
            "https://worker.example/api/residence-proof?h3_index=608819013681676287",
        ]);
    });

    it("treats missing worker URL as a configured error", async () => {
        await expect(
            fetchResidenceProof({
                workerUrl: "   ",
                homeCell: HOME_CELL,
            }),
        ).rejects.toSatisfy((error: unknown) => {
            return error instanceof MembershipIssueError && error.code === "worker_url_missing";
        });
    });

    it("treats 404 as residence_cell_not_allowed", async () => {
        const fetchImpl = async () =>
            ({
                status: 404,
                ok: false,
                json: async () => ({}),
            }) as Response;

        await expect(
            fetchResidenceProof({
                workerUrl: "https://worker.example",
                homeCell: HOME_CELL,
                fetchImpl,
            }),
        ).rejects.toSatisfy((error: unknown) => {
            return (
                error instanceof MembershipIssueError &&
                error.code === "residence_cell_not_allowed"
            );
        });
    });

    it("treats invalid JSON as invalid_proof_response", async () => {
        const fetchImpl = async () =>
            ({
                status: 200,
                ok: true,
                json: async () => {
                    throw new Error("bad json");
                },
            }) as Response;

        await expect(
            fetchResidenceProof({
                workerUrl: "https://worker.example",
                homeCell: HOME_CELL,
                fetchImpl,
            }),
        ).rejects.toSatisfy((error: unknown) => {
            return (
                error instanceof MembershipIssueError &&
                error.code === "invalid_proof_response"
            );
        });
    });

    it("rejects a proof response for a different residence cell", async () => {
        const fetchImpl = async () =>
            ({
                status: 200,
                ok: true,
                json: async () => ({ ...RESIDENCE_PROOF, h3_index: WRONG_HOME_CELL }),
            }) as Response;

        await expect(
            fetchResidenceProof({
                workerUrl: "https://worker.example",
                homeCell: HOME_CELL,
                fetchImpl,
            }),
        ).rejects.toSatisfy((error: unknown) => {
            return (
                error instanceof MembershipIssueError &&
                error.code === "invalid_proof_response"
            );
        });
    });

    it("builds the register_member transaction with the expected call order", () => {
        const { transaction } = buildRegisterMemberTransaction({
            senderAddress: SENDER,
            packageId: PACKAGE_ID,
            objects: {
                pauseState: PAUSE_STATE,
                membershipRegistry: MEMBERSHIP_REGISTRY,
                allowedResidenceCellRegistry: ALLOWED_RESIDENCE_CELL_REGISTRY,
            },
            homeCell: HOME_CELL,
            residenceProof: RESIDENCE_PROOF,
            termsVersion: MEMBERSHIP_TERMS_VERSION,
        });

        const data = transaction.getData();
        const commandNames = data.commands.map((command) =>
            command.$kind === "MoveCall" ? command.MoveCall.function : command.$kind,
        );

        expect(data.sender).toBe(SENDER);
        expect(commandNames).toEqual([
            "new_residence_proof_step_left",
            "MakeMoveVec",
            "register_member",
        ]);

        const proofVector = data.commands[1];
        expect(proofVector?.$kind).toBe("MakeMoveVec");
        if (proofVector?.$kind !== "MakeMoveVec") {
            throw new Error("second command must be MakeMoveVec");
        }
        expect(proofVector.MakeMoveVec.type).toBe(
            `${PACKAGE_ID}::allowed_residence_cell::ProofStep`,
        );

        const register = data.commands.at(-1);
        expect(register?.$kind).toBe("MoveCall");
        if (register?.$kind !== "MoveCall") {
            throw new Error("last command must be MoveCall");
        }
        expect(register.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "register_member",
        });
        expect(register.MoveCall.arguments).toHaveLength(7);
    });

    it("issues membership through the existing wallet executor by default", async () => {
        const walletCalls: unknown[] = [];
        const sponsoredCalls: unknown[] = [];

        const result = await issueMembershipPass({
            client: {} as ClientWithCoreApi,
            senderAddress: SENDER,
            homeCell: HOME_CELL,
            residenceProofWorkerUrl: "https://worker.example",
            packageId: PACKAGE_ID,
            objects: {
                pauseState: PAUSE_STATE,
                membershipRegistry: MEMBERSHIP_REGISTRY,
                allowedResidenceCellRegistry: ALLOWED_RESIDENCE_CELL_REGISTRY,
            },
            fetchImpl: async () =>
                ({
                    status: 200,
                    ok: true,
                    json: async () => RESIDENCE_PROOF,
                }) as Response,
            walletExecutor: async (input) => {
                walletCalls.push(input);
                return { digest: "wallet-digest" };
            },
            sponsoredExecutor: async (input) => {
                sponsoredCalls.push(input);
                return { digest: "sponsored-digest" };
            },
            executionMode: "wallet",
        });

        expect(result).toEqual({ digest: "wallet-digest" });
        expect(walletCalls).toHaveLength(1);
        expect(sponsoredCalls).toHaveLength(0);
    });

    it("issues membership through the sponsored executor when requested", async () => {
        const client = {} as ClientWithCoreApi;
        const walletCalls: unknown[] = [];
        const sponsoredCalls: Array<{ client: ClientWithCoreApi; sender: string }> = [];

        const result = await issueMembershipPass({
            client,
            senderAddress: SENDER,
            homeCell: HOME_CELL,
            residenceProofWorkerUrl: "https://worker.example",
            packageId: PACKAGE_ID,
            objects: {
                pauseState: PAUSE_STATE,
                membershipRegistry: MEMBERSHIP_REGISTRY,
                allowedResidenceCellRegistry: ALLOWED_RESIDENCE_CELL_REGISTRY,
            },
            fetchImpl: async () =>
                ({
                    status: 200,
                    ok: true,
                    json: async () => RESIDENCE_PROOF,
                }) as Response,
            walletExecutor: async (input) => {
                walletCalls.push(input);
                return { digest: "wallet-digest" };
            },
            sponsoredExecutor: async (input) => {
                sponsoredCalls.push({ client: input.client, sender: input.sender });
                return { digest: "sponsored-digest" };
            },
            executionMode: "sponsored",
        });

        expect(result).toEqual({ digest: "sponsored-digest" });
        expect(walletCalls).toHaveLength(0);
        expect(sponsoredCalls).toEqual([{ client, sender: SENDER }]);
    });
});
