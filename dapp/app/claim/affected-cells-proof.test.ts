import { describe, expect, it } from "vitest";
import {
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
