import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOUR_MS, usgsDetailUrl } from "../nautilus/verifiers/earthquake/watcher/src/index.js";
import {
    E2E_FIXTURE_CASES,
    FixtureSourceClient,
    LocalOracleCoreRunnerAdapter,
    loadFixtureCandidate,
    runLocalOracleE2e,
    UsgsSourceClient,
} from "./nautilus_local_e2e.js";

const target = "0x123::accessor::create_disaster_event_and_campaign_from_signed_payload";
const registry = "0x456";
const verifierRegistry = "0x654";
const categoryRegistry = "0xabc";
const categoryPool = "0xdef";
// CI runs this test with a cold Cargo binary build before the Rust TEE tests.
const LOCAL_E2E_TEST_TIMEOUT_MS = 90_000;

describe("Nautilus local oracle E2E", () => {
    it(
        "finalizes the canonical fixture and builds a relayer request preview",
        async () => {
            const output = await runLocalOracleE2e({
                caseId: "usgs/finalized_minimal",
                target,
                registry,
                verifierRegistry,
                categoryRegistry,
                categoryPool,
            });

            expect(output.case_id).toBe("usgs/finalized_minimal");
            expect(output.source_event_id).toBe("us7000sonari");
            expect(output.first_process_summary.processed).toBe(1);
            expect(output.second_process_summary.processed).toBe(0);
            expect(output.runner_invocation_count).toBe(1);
            expect(output.final_event).toMatchObject({
                status: "finalized",
                retry_count: 0,
                source_updated_at_ms: 1_704_151_200_000,
                error_code: null,
            });
            expect(output.runner_result).toEqual({
                status: "finalized",
                payload: expect.objectContaining({
                    event_uid: expect.any(String),
                    evidence_manifest_uri:
                        "ipfs://sonari/examples/us7000sonari/evidence_manifest.json",
                    evidence_manifest_hash: expect.any(String),
                }),
                payload_bcs_hex: expect.any(String),
                signature: expect.any(String),
                public_key: expect.any(String),
                verifier_config_key: 1,
                verifier_config_version: 1,
                enclave_instance_public_key: expect.any(String),
            });
            if (output.runner_result.status !== "finalized") {
                throw new Error("expected finalized runner result");
            }
            expect(output.runner_result.enclave_instance_public_key).toBe(
                output.runner_result.public_key,
            );
            expect(output.runner_result).not.toHaveProperty("payloadBcsBytes");
            expect(output.runner_result).not.toHaveProperty("signatureBytes");
            expect(output.runner_result).not.toHaveProperty("publicKeyBytes");
            expect(output.relayer_preview).toMatchObject({
                ok: true,
                value: {
                    target,
                    registry,
                    verifierRegistry,
                    arguments: [
                        registry,
                        verifierRegistry,
                        categoryRegistry,
                        categoryPool,
                        expect.any(String),
                        expect.any(Array),
                        expect.any(Array),
                        expect.any(Array),
                    ],
                },
            });
            expect(output).not.toHaveProperty("relayer_skipped");
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );

    it(
        "fails finalized cases when relayer preview generation fails",
        async () => {
            await expect(
                runLocalOracleE2e({
                    caseId: "usgs/finalized_minimal",
                    target: "",
                    registry,
                    verifierRegistry,
                    categoryRegistry,
                    categoryPool,
                }),
            ).rejects.toThrow(/Local E2E relayer preview failed: .*target, registry/);
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );

    it.each([
        ["usgs/pending_source_no_shakemap", "pending_source", "SHAKEMAP_PRODUCT_MISSING"],
        ["usgs/pending_mmi_empty_grid", "pending_mmi", "MMI_NOT_AVAILABLE"],
        ["usgs/rejected_cancelled_shakemap", "rejected", "SHAKEMAP_CANCELLED"],
        ["usgs/rejected_no_affected_cells", "rejected", "NO_AFFECTED_CELLS"],
    ] as const)(
        "skips relayer preview for non-finalized case %s",
        async (caseId, status, errorCode) => {
            const output = await runLocalOracleE2e({ caseId, target, registry, verifierRegistry });

            expect(output.first_process_summary.processed).toBe(1);
            expect(output.second_process_summary.processed).toBe(0);
            expect(output.runner_invocation_count).toBe(1);
            expect(output.runner_result).toMatchObject({
                status,
                source_event_id: output.source_event_id,
                error_code: errorCode,
            });
            expect(output.final_event).toMatchObject({
                status,
                retry_count: status === "rejected" ? 0 : 1,
                error_code: errorCode,
            });
            expect(output.relayer_skipped).toEqual({
                reason: "non_finalized_status",
                status,
                error_code: errorCode,
            });
            expect(output).not.toHaveProperty("relayer_preview");
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );

    it(
        "keeps every Step 6 fixture eligible under normal watcher screening",
        async () => {
            for (const caseId of E2E_FIXTURE_CASES) {
                const output = await runLocalOracleE2e({
                    caseId,
                    target,
                    registry,
                    verifierRegistry,
                    categoryRegistry,
                    categoryPool,
                });

                expect(output.first_process_summary.processed).toBe(1);
                expect(output.final_event.status).not.toBe("ignored_small");
            }
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );

    it("resolves raw fixture artifacts through FixtureSourceClient", async () => {
        const sourceClient = new FixtureSourceClient({
            caseId: "usgs/finalized_minimal",
            fixturesDir: "nautilus/verifiers/earthquake/fixtures",
        });

        await expect(sourceClient.getSourceArtifacts("us7000sonari")).resolves.toEqual({
            case_id: "usgs/finalized_minimal",
            source_event_id: "us7000sonari",
            raw_detail_path: expect.stringMatching(
                /nautilus\/verifiers\/earthquake\/fixtures\/usgs\/finalized_minimal\/input\/usgs_detail\.json$/,
            ),
            raw_detail_uri:
                "nautilus/verifiers/earthquake/fixtures/usgs/finalized_minimal/input/usgs_detail.json",
            raw_grid_path: expect.stringMatching(
                /nautilus\/verifiers\/earthquake\/fixtures\/usgs\/finalized_minimal\/input\/usgs_grid\.xml$/,
            ),
            raw_grid_uri:
                "nautilus/verifiers/earthquake/fixtures/usgs/finalized_minimal/input/usgs_grid.xml",
            raw_data_uri: "ipfs://sonari/examples/us7000sonari/raw_data_manifest.json",
            affected_cells_uri: "ipfs://sonari/examples/us7000sonari/affected_cells.json",
            temporary_dir: null,
        });
    });

    it(
        "routes LocalOracleCoreRunnerAdapter through the configured SourceClient",
        async () => {
            const sourceClient = new FixtureSourceClient({
                caseId: "usgs/finalized_minimal",
                fixturesDir: "nautilus/verifiers/earthquake/fixtures",
            });
            const runner = new LocalOracleCoreRunnerAdapter({ sourceClient });

            await expect(
                runner.run({
                    source_event_id: "us7000sonari",
                    hazard_type: 1,
                    primary_source: 1,
                    geo_resolution: 7,
                }),
            ).resolves.toMatchObject({ status: "finalized" });
            expect(runner.invocationCount).toBe(1);
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );

    it("fetches live USGS detail from the deterministic detail URL and prefers grid.xml.zip", async () => {
        const requests: string[] = [];
        const fetcher = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
            const url = String(input);
            requests.push(url);
            if (url === usgsDetailUrl("us7000sonari")) {
                return Response.json(
                    detailWithContents("us7000sonari", {
                        "download/grid.xml": { url: "https://example.test/grid.xml" },
                        "download/grid.xml.zip": { url: "https://example.test/grid.xml.zip" },
                    }),
                );
            }
            if (url === "https://example.test/grid.xml.zip") {
                return new Response("zip-bytes");
            }
            return new Response("unexpected", { status: 404 });
        };
        const sourceClient = new UsgsSourceClient({
            fetcher,
        });

        const artifacts = await sourceClient.getSourceArtifacts("us7000sonari");

        expect(requests).toEqual([
            usgsDetailUrl("us7000sonari"),
            "https://example.test/grid.xml.zip",
        ]);
        expect(artifacts).toMatchObject({
            case_id: "usgs-live/us7000sonari",
            source_event_id: "us7000sonari",
            raw_detail_uri: usgsDetailUrl("us7000sonari"),
            raw_grid_uri: "https://example.test/grid.xml.zip",
            raw_data_uri: "ipfs://sonari/live/us7000sonari/raw_data_manifest.json",
            affected_cells_uri: "ipfs://sonari/live/us7000sonari/affected_cells.json",
            temporary_dir: expect.any(String),
        });
        expect(artifacts.raw_detail_path).toMatch(/usgs_detail\.json$/);
        expect(artifacts.raw_grid_path).toMatch(/usgs_grid\.xml\.zip$/);
    });

    it("falls back to the deterministic USGS detail URL for manual event ids", async () => {
        const requests: string[] = [];
        const fetcher = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
            const url = String(input);
            requests.push(url);
            if (
                url ===
                "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000manual.geojson"
            ) {
                return Response.json(
                    detailWithContents("us7000manual", {
                        "download/grid.xml": { url: "https://example.test/grid.xml" },
                    }),
                );
            }
            if (url === "https://example.test/grid.xml") {
                return new Response("<grid />");
            }
            return new Response("unexpected", { status: 404 });
        };

        const artifacts = await new UsgsSourceClient({
            fetcher,
        }).getSourceArtifacts("us7000manual");

        expect(requests).toContain(
            "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000manual.geojson",
        );
        expect(artifacts.raw_grid_path).toMatch(/usgs_grid\.xml$/);
        expect(artifacts.raw_grid_uri).toBe("https://example.test/grid.xml");
    });

    it.each([
        ["detail 404", new Response("missing", { status: 404 })],
        ["invalid detail JSON", new Response("{not json", { status: 200 })],
        ["id mismatch", Response.json(detailWithContents("other-event", {}))],
    ] as const)("maps %s to pending_source USGS_DETAIL_UNAVAILABLE", async (_name, response) => {
        const fetcher = async (): Promise<Response> => {
            return response;
        };
        const runner = new LocalOracleCoreRunnerAdapter({
            sourceClient: new UsgsSourceClient({
                fetcher,
            }),
        });

        await expect(
            runner.run({
                source_event_id: "us7000sonari",
                hazard_type: 1,
                primary_source: 1,
                geo_resolution: 7,
            }),
        ).resolves.toEqual({
            status: "pending_source",
            source_event_id: "us7000sonari",
            error_code: "USGS_DETAIL_UNAVAILABLE",
        });
    });

    it("maps missing ShakeMap grid contents to pending_source SHAKEMAP_GRID_UNAVAILABLE", async () => {
        const fetcher = async (): Promise<Response> => {
            return Response.json(detailWithContents("us7000sonari", {}));
        };
        const runner = new LocalOracleCoreRunnerAdapter({
            sourceClient: new UsgsSourceClient({
                fetcher,
            }),
        });

        await expect(
            runner.run({
                source_event_id: "us7000sonari",
                hazard_type: 1,
                primary_source: 1,
                geo_resolution: 7,
            }),
        ).resolves.toEqual({
            status: "pending_source",
            source_event_id: "us7000sonari",
            error_code: "SHAKEMAP_GRID_UNAVAILABLE",
        });
    });

    it(
        "removes live source temporary files after the local runner finishes",
        async () => {
            const tempDir = await mkdtemp(path.join(tmpdir(), "sonari-source-test-"));
            const sourceClient = new FixtureSourceClient({
                caseId: "usgs/finalized_minimal",
                fixturesDir: "nautilus/verifiers/earthquake/fixtures",
            });
            const runner = new LocalOracleCoreRunnerAdapter({
                sourceClient: {
                    async getSourceArtifacts(sourceEventId) {
                        return {
                            ...(await sourceClient.getSourceArtifacts(sourceEventId)),
                            temporary_dir: tempDir,
                        };
                    },
                },
            });

            await runner.run({
                source_event_id: "us7000sonari",
                hazard_type: 1,
                primary_source: 1,
                geo_resolution: 7,
            });

            await expect(stat(tempDir)).rejects.toThrow();
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );

    function detailWithContents(
        id: string,
        contents: Record<string, { url: string }>,
    ): Record<string, unknown> {
        return {
            id,
            properties: {
                time: 1_700_000_000_000,
                updated: 1_700_000_010_000,
                products: {
                    shakemap: [
                        {
                            status: "UPDATE",
                            preferredWeight: 1,
                            updateTime: 1_700_000_010_000,
                            properties: {
                                "map-status": "RELEASED",
                                version: "1",
                            },
                            contents,
                        },
                    ],
                },
            },
        };
    }

    it.each([
        ["usgs/finalized_minimal", "finalized", null],
        ["usgs/rejected_cancelled_shakemap", "rejected", "SHAKEMAP_CANCELLED"],
    ] as const)(
        "does not re-run terminal case %s after duplicate scans and process attempts",
        async (caseId, status, errorCode) => {
            const candidate = loadFixtureCandidate(caseId);
            const output = await runLocalOracleE2e({
                caseId,
                nowMs: candidate.occurred_at_ms + 25 * HOUR_MS,
                target,
                registry,
                verifierRegistry,
                categoryRegistry,
                categoryPool,
            });

            expect(output.runner_invocation_count).toBe(1);
            expect(output.second_process_summary).toMatchObject({
                processed: 0,
                deferred: 0,
                recovered: 0,
                failed: 0,
                rejected: 0,
            });
            expect(output.final_event).toMatchObject({
                status,
                retry_count: 0,
                source_updated_at_ms: candidate.source_updated_at_ms,
                error_code: errorCode,
            });
        },
        LOCAL_E2E_TEST_TIMEOUT_MS,
    );
});
