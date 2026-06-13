import { describe, expect, it } from "vitest";
import {
    assertProofMatchesClaimContext,
    buildAffectedCellLeafMoveArgs,
    buildAffectedCellProofMoveArgs,
    buildClaimTransaction,
    buildClaimFloorTransaction,
    buildClaimPayoutTransaction,
    buildSubmitClaimV2Transaction,
    buildVerifyClaimV2Transaction,
    ClaimProofError,
    fetchAffectedCellsProof,
    parseAffectedCellsProofResponse,
} from "./affected-cells-proof";

const EVENT_UID =
    "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";
const EVENT_REVISION = 1;
const HOME_CELL = "608819013597790207";
const AFFECTED_CELLS_ROOT =
    "0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f";
const PACKAGE_ID = "0x00000000000000000000000000000000000000000000000000000000000000aa";
const SENDER = "0x00000000000000000000000000000000000000000000000000000000000000ff";
const MOVE_STD_PACKAGE_ID = "0x0000000000000000000000000000000000000000000000000000000000000001";

const workerProofResponse = {
    event_uid: EVENT_UID,
    event_revision: EVENT_REVISION,
    h3_index: HOME_CELL,
    affected_cells_root: AFFECTED_CELLS_ROOT,
    leaf: {
        event_uid: EVENT_UID,
        event_revision: EVENT_REVISION,
        h3_index: HOME_CELL,
        geo_resolution: 7,
        cell_band: 1,
        intensity_value: 723,
        cell_metric: "USGS_MMI",
        intensity_scale: "MMI_X100",
        cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
        oracle_version: "1",
    },
    proof: [
        {
            sibling_on_left: true,
            sibling_hash:
                "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
        },
    ],
};

describe("parseAffectedCellsProofResponse", () => {
    it("accepts the affected-cells-proof-worker response shape and verifies the proof root", async () => {
        const proof = await parseAffectedCellsProofResponse(workerProofResponse);

        expect(proof.event_uid).toBe(EVENT_UID);
        expect(proof.event_revision).toBe(EVENT_REVISION);
        expect(proof.h3_index).toBe(HOME_CELL);
        expect(proof.affected_cells_root).toBe(AFFECTED_CELLS_ROOT);
        expect(proof.leaf.h3_index).toBe(608819013597790207n);
        expect(proof.leaf.oracle_version).toBe(1n);
        expect(proof.proof).toEqual([
            {
                sibling_on_left: true,
                sibling_hash:
                    "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
            },
        ]);
    });

    it("rejects malformed response fields before claim can proceed", async () => {
        await expect(
            parseAffectedCellsProofResponse({
                ...workerProofResponse,
                leaf: { ...workerProofResponse.leaf, event_uid: "0xBAD" },
            }),
        ).rejects.toMatchObject({ code: "invalid_proof_response" });
    });

    it("rejects a proof that does not replay to affected_cells_root", async () => {
        await expect(
            parseAffectedCellsProofResponse({
                ...workerProofResponse,
                proof: [
                    {
                        sibling_on_left: true,
                        sibling_hash:
                            "0x0000000000000000000000000000000000000000000000000000000000000000",
                    },
                ],
            }),
        ).rejects.toMatchObject({ code: "proof_verification_failed" });
    });
});

describe("fetchAffectedCellsProof", () => {
    it("fails closed without fetching when the worker URL is missing", async () => {
        let fetchCalls = 0;
        await expect(
            fetchAffectedCellsProof({
                workerUrl: " ",
                eventUid: EVENT_UID,
                eventRevision: EVENT_REVISION,
                homeCell: HOME_CELL,
                fetchImpl: async () => {
                    fetchCalls += 1;
                    return new Response(JSON.stringify(workerProofResponse));
                },
            }),
        ).rejects.toMatchObject({ code: "worker_url_missing" });
        expect(fetchCalls).toBe(0);
    });

    it("fetches proof with home_cell as h3_index", async () => {
        const requestedUrls: string[] = [];
        const proof = await fetchAffectedCellsProof({
            workerUrl: "https://proof-worker.example/base/",
            eventUid: EVENT_UID,
            eventRevision: EVENT_REVISION,
            homeCell: HOME_CELL,
            fetchImpl: async (input) => {
                requestedUrls.push(String(input));
                return Response.json(workerProofResponse);
            },
        });

        expect(proof.h3_index).toBe(HOME_CELL);
        expect(requestedUrls).toEqual([
            `https://proof-worker.example/base/events/${EVENT_UID}/revisions/${EVENT_REVISION}/proof?h3_index=${HOME_CELL}`,
        ]);
    });

    it("maps worker 404 to outside affected area", async () => {
        await expect(
            fetchAffectedCellsProof({
                workerUrl: "https://proof-worker.example",
                eventUid: EVENT_UID,
                eventRevision: EVENT_REVISION,
                homeCell: HOME_CELL,
                fetchImpl: async () =>
                    Response.json(
                        { error: { code: "affected_cell_not_in_event" } },
                        { status: 404 },
                    ),
            }),
        ).rejects.toMatchObject({ code: "outside_affected_area" });
    });

    it("maps non-404 worker errors to proof fetch failure", async () => {
        await expect(
            fetchAffectedCellsProof({
                workerUrl: "https://proof-worker.example",
                eventUid: EVENT_UID,
                eventRevision: EVENT_REVISION,
                homeCell: HOME_CELL,
                fetchImpl: async () =>
                    Response.json({ error: { code: "proof_shard_invalid" } }, { status: 500 }),
            }),
        ).rejects.toMatchObject({ code: "proof_fetch_failed" });
    });

    it("normalizes fetch exceptions to proof fetch failure", async () => {
        await expect(
            fetchAffectedCellsProof({
                workerUrl: "https://proof-worker.example",
                eventUid: EVENT_UID,
                eventRevision: EVENT_REVISION,
                homeCell: HOME_CELL,
                fetchImpl: async () => {
                    throw new Error("network down");
                },
            }),
        ).rejects.toMatchObject({ code: "proof_fetch_failed" });
    });
});

describe("ClaimProofError", () => {
    it("carries stable fail-closed codes", () => {
        const error = new ClaimProofError("outside_affected_area", "Outside area");

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("outside_affected_area");
        expect(error.message).toBe("Outside area");
    });
});

describe("claim transaction arguments", () => {
    it("builds affected cell leaf arguments in accessor order with Move enum values", async () => {
        const proof = await parseAffectedCellsProofResponse(workerProofResponse);
        const args = buildAffectedCellLeafMoveArgs(proof.leaf);

        expect(args).toEqual({
            eventUidBytes: [
                171, 19, 29, 212, 138, 216, 182, 126, 139, 162, 46, 212, 97, 168, 133, 240,
                200, 170, 249, 55, 182, 101, 208, 73, 49, 1, 140, 49, 213, 207, 105, 189,
            ],
            eventRevision: 1,
            h3Index: "608819013597790207",
            geoResolution: 7,
            cellMetric: 1,
            intensityValue: 723,
            intensityScale: 1,
            cellBand: 1,
            cellsGenerationMethod: 1,
            oracleVersion: "1",
        });
    });

    it("maps proof step directions to accessor constructors", async () => {
        expect(
            buildAffectedCellProofMoveArgs([
                {
                    sibling_on_left: true,
                    sibling_hash:
                        "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
                },
                {
                    sibling_on_left: false,
                    sibling_hash:
                        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                },
            ]),
        ).toEqual([
            {
                constructor: "new_affected_cell_proof_step_left",
                siblingHashBytes: [
                    131, 188, 41, 156, 84, 78, 220, 91, 255, 48, 23, 108, 136, 64, 174, 43,
                    60, 0, 31, 138, 16, 234, 40, 193, 88, 118, 26, 87, 147, 199, 155, 47,
                ],
            },
            {
                constructor: "new_affected_cell_proof_step_right",
                siblingHashBytes: [
                    170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170,
                    170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170,
                    170, 170,
                ],
            },
        ]);
    });

    it("fails closed when proof context does not match the selected event or home cell", async () => {
        const proof = await parseAffectedCellsProofResponse(workerProofResponse);

        expect(() =>
            assertProofMatchesClaimContext(proof, {
                eventUid: EVENT_UID,
                eventRevision: EVENT_REVISION,
                homeCell: "608819013513904127",
                affectedCellsRoot: AFFECTED_CELLS_ROOT,
            }),
        ).toThrow(/home_cell/);

        expect(() =>
            assertProofMatchesClaimContext(proof, {
                eventUid: EVENT_UID,
                eventRevision: 2,
                homeCell: HOME_CELL,
                affectedCellsRoot: AFFECTED_CELLS_ROOT,
            }),
        ).toThrow(/event_revision/);

        expect(() =>
            assertProofMatchesClaimContext(proof, {
                eventUid: EVENT_UID,
                eventRevision: EVENT_REVISION,
                homeCell: HOME_CELL,
                affectedCellsRoot:
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
            }),
        ).toThrow(/affected_cells_root/);
    });

    it("builds initial claim with leaf option and proof inputs", async () => {
        const proof = await parseAffectedCellsProofResponse(workerProofResponse);
        const { transaction } = buildClaimTransaction({
            senderAddress: SENDER,
            packageId: PACKAGE_ID,
            objects: buildObjectConfig(),
            identityProvider: 2,
            duplicateKeyHash:
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            claimProof: {
                kind: "initial",
                proof,
                context: {
                    eventUid: EVENT_UID,
                    eventRevision: EVENT_REVISION,
                    homeCell: HOME_CELL,
                    affectedCellsRoot: AFFECTED_CELLS_ROOT,
                },
            },
        });

        const data = transaction.getData();
        const commandNames = data.commands.map((command) =>
            command.$kind === "MoveCall" ? command.MoveCall.function : command.$kind,
        );

        expect(data.sender).toBe(SENDER);
        expect(commandNames).toEqual([
            "new_affected_cell_leaf",
            "new_affected_cell_proof_step_left",
            "MakeMoveVec",
            "some",
            "claim",
        ]);

        const some = data.commands[3];
        expect(some?.$kind).toBe("MoveCall");
        if (some?.$kind !== "MoveCall") {
            throw new Error("fourth command must be option::some");
        }
        expect(some.MoveCall).toMatchObject({
            package: MOVE_STD_PACKAGE_ID,
            module: "option",
            function: "some",
            typeArguments: [`${PACKAGE_ID}::affected_cell::AffectedCellLeaf`],
        });

        const claim = data.commands.at(-1);
        expect(claim?.$kind).toBe("MoveCall");
        if (claim?.$kind !== "MoveCall") {
            throw new Error("last command must be MoveCall");
        }
        expect(claim.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "claim",
        });
        expect(claim.MoveCall.arguments).toHaveLength(11);
        expect(claim.MoveCall.arguments[8]).toEqual({ Result: 3, $kind: "Result" });
        expect(claim.MoveCall.arguments[9]).toEqual({ Result: 2, $kind: "Result" });
    });

    it("builds continuing claim with empty leaf option and proof vector", () => {
        const { transaction } = buildClaimTransaction({
            senderAddress: SENDER,
            packageId: PACKAGE_ID,
            objects: buildObjectConfig(),
            identityProvider: 0,
            duplicateKeyHash:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            claimProof: { kind: "continuing" },
        });

        const data = transaction.getData();
        const commandNames = data.commands.map((command) =>
            command.$kind === "MoveCall" ? command.MoveCall.function : command.$kind,
        );

        expect(data.sender).toBe(SENDER);
        expect(commandNames).toEqual(["none", "MakeMoveVec", "claim"]);

        const none = data.commands[0];
        expect(none?.$kind).toBe("MoveCall");
        if (none?.$kind !== "MoveCall") {
            throw new Error("first command must be option::none");
        }
        expect(none.MoveCall).toMatchObject({
            package: MOVE_STD_PACKAGE_ID,
            module: "option",
            function: "none",
            typeArguments: [`${PACKAGE_ID}::affected_cell::AffectedCellLeaf`],
        });

        const proofVector = data.commands[1];
        expect(proofVector?.$kind).toBe("MakeMoveVec");
        if (proofVector?.$kind !== "MakeMoveVec") {
            throw new Error("second command must be MakeMoveVec");
        }
        expect(proofVector.MakeMoveVec.type).toBe(`${PACKAGE_ID}::affected_cell::ProofStep`);
        expect(proofVector.MakeMoveVec.elements).toEqual([]);

        const claim = data.commands.at(-1);
        expect(claim?.$kind).toBe("MoveCall");
        if (claim?.$kind !== "MoveCall") {
            throw new Error("last command must be MoveCall");
        }
        expect(claim.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "claim",
        });
        expect(claim.MoveCall.arguments).toHaveLength(11);
        expect(claim.MoveCall.arguments[2]).toMatchObject({ $kind: "Input" });
        expect(claim.MoveCall.arguments[3]).toMatchObject({ $kind: "Input" });
        expect(claim.MoveCall.arguments[8]).toEqual({ Result: 0, $kind: "Result" });
        expect(claim.MoveCall.arguments[9]).toEqual({ Result: 1, $kind: "Result" });
    });

    it("builds claim_floor with ordered object and value inputs", () => {
        const { transaction } = buildClaimFloorTransaction({
            senderAddress: SENDER,
            packageId: PACKAGE_ID,
            objects: buildObjectConfig(),
            identityProvider: 2,
            duplicateKeyHash:
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });

        const data = transaction.getData();
        const claim = data.commands.at(-1);
        expect(data.sender).toBe(SENDER);
        expect(data.commands).toHaveLength(1);
        expect(claim?.$kind).toBe("MoveCall");
        if (claim?.$kind !== "MoveCall") {
            throw new Error("last command must be MoveCall");
        }
        expect(claim.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "claim_floor",
        });
        expect(claim.MoveCall.arguments).toHaveLength(8);
    });

    it("builds submit_claim_v2 with affected cell leaf and proof inputs", async () => {
        const proof = await parseAffectedCellsProofResponse(workerProofResponse);
        const { transaction } = buildSubmitClaimV2Transaction({
            senderAddress: SENDER,
            packageId: PACKAGE_ID,
            proof,
            context: {
                eventUid: EVENT_UID,
                eventRevision: EVENT_REVISION,
                homeCell: HOME_CELL,
                affectedCellsRoot: AFFECTED_CELLS_ROOT,
            },
            objects: buildObjectConfig(),
        });

        const data = transaction.getData();
        const commandNames = data.commands.map((command) =>
            command.$kind === "MoveCall" ? command.MoveCall.function : command.$kind,
        );

        expect(data.sender).toBe(SENDER);
        expect(commandNames).toEqual([
            "new_affected_cell_leaf",
            "new_affected_cell_proof_step_left",
            "MakeMoveVec",
            "submit_claim_v2",
        ]);

        const proofVector = data.commands[2];
        expect(proofVector?.$kind).toBe("MakeMoveVec");
        if (proofVector?.$kind !== "MakeMoveVec") {
            throw new Error("third command must be MakeMoveVec");
        }
        expect(proofVector.MakeMoveVec.type).toBe(`${PACKAGE_ID}::affected_cell::ProofStep`);

        const claim = data.commands.at(-1);
        expect(claim?.$kind).toBe("MoveCall");
        if (claim?.$kind !== "MoveCall") {
            throw new Error("last command must be MoveCall");
        }
        expect(claim.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "submit_claim_v2",
        });
        expect(claim.MoveCall.arguments).toHaveLength(8);
        expect(claim.MoveCall.arguments[5]).toEqual({ Result: 0, $kind: "Result" });
        expect(claim.MoveCall.arguments[6]).toEqual({ Result: 2, $kind: "Result" });
    });

    it("builds verify_claim_v2 with ordered object and value inputs", () => {
        const { transaction } = buildVerifyClaimV2Transaction({
            senderAddress: SENDER,
            packageId: PACKAGE_ID,
            objects: buildObjectConfig(),
            identityProvider: 2,
            duplicateKeyHash:
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });

        const data = transaction.getData();
        const verify = data.commands.at(-1);
        expect(data.sender).toBe(SENDER);
        expect(data.commands).toHaveLength(1);
        expect(verify?.$kind).toBe("MoveCall");
        if (verify?.$kind !== "MoveCall") {
            throw new Error("last command must be MoveCall");
        }
        expect(verify.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "verify_claim_v2",
        });
        expect(verify.MoveCall.arguments).toHaveLength(8);
    });

    it("builds claim_payout with ordered object inputs", () => {
        const { transaction } = buildClaimPayoutTransaction({
            senderAddress: SENDER,
            packageId: PACKAGE_ID,
            objects: buildObjectConfig(),
        });

        const data = transaction.getData();
        const payout = data.commands.at(-1);
        expect(data.sender).toBe(SENDER);
        expect(data.commands).toHaveLength(1);
        expect(payout?.$kind).toBe("MoveCall");
        if (payout?.$kind !== "MoveCall") {
            throw new Error("last command must be MoveCall");
        }
        expect(payout.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "claim_payout",
        });
        expect(payout.MoveCall.arguments).toHaveLength(5);
    });
});

function buildObjectConfig() {
    return {
        pauseState: "0x0000000000000000000000000000000000000000000000000000000000000001",
        claimIndex: "0x0000000000000000000000000000000000000000000000000000000000000002",
        membershipRegistry:
            "0x0000000000000000000000000000000000000000000000000000000000000003",
        program: "0x0000000000000000000000000000000000000000000000000000000000000004",
        campaign: "0x0000000000000000000000000000000000000000000000000000000000000005",
        policy: "0x0000000000000000000000000000000000000000000000000000000000000006",
        budget: "0x0000000000000000000000000000000000000000000000000000000000000007",
        binding: "0x0000000000000000000000000000000000000000000000000000000000000008",
        disasterEvent: "0x0000000000000000000000000000000000000000000000000000000000000009",
        identityRegistry:
            "0x000000000000000000000000000000000000000000000000000000000000000a",
        pass: "0x000000000000000000000000000000000000000000000000000000000000000b",
        designatedPool: "0x000000000000000000000000000000000000000000000000000000000000000c",
        mainPool: "0x000000000000000000000000000000000000000000000000000000000000000d",
    };
}
