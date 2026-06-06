import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    assertFixtureNetwork,
    assertSuiObjectType,
    buildCreateAllowedResidenceCellRegistryCommand,
    buildDummyWorldIdRequest,
    buildMembershipIdentityFixtureFiles,
    buildMembershipIdentityFixtureManifest,
    buildRegisterMemberPtbCommand,
    buildSuiObjectCommand,
    buildSuiPtbCommand,
    computeWorldIdSignalHash,
    DEFAULT_ALLOWLIST_VERSION,
    DEFAULT_GEO_RESOLUTION,
    DEFAULT_HOME_CELL,
    DEFAULT_RESIDENCE_PROOF_LEFT,
    DEFAULT_RESIDENCE_PROOF_RIGHT,
    DEFAULT_RESIDENCE_ROOT,
    DEFAULT_RESIDENCE_SOURCE_HASH,
    DEFAULT_SIGNED_STATEMENT_HASH,
    DEFAULT_TERMS_VERSION,
    EXPECTED_OBJECT_TYPES,
    GENESIS_KIND_IDENTITY_REGISTRY,
    GENESIS_KIND_MEMBERSHIP_REGISTRY,
    GENESIS_KIND_PAUSE_STATE,
    GENESIS_KIND_VERIFIER_REGISTRY,
    hexToMoveU8Vector,
    type MembershipIdentityFixtureManifestInput,
    parseAllowedResidenceCellRegistryId,
    parseMembershipPassIssuedId,
    parsePublishedTomlPackageId,
    parsePublishFixtureObjects,
    parseSuiJsonCommandResult,
    parseSuiObjectReadback,
    parseUnverifiedMembershipPassReadback,
    resolveBaseFixtureObjects,
    runMembershipIdentityTestnetFixture,
    type SuiCommandExecutor,
    type SuiCommandPlan,
    type SuiCommandResult,
    WORLD_ID_ACTION,
} from "./membership_identity_testnet_fixture.js";

describe("membership identity testnet fixture files", () => {
    it("generates env, manifest, and dummy World ID request without secrets", () => {
        const files = buildMembershipIdentityFixtureFiles(fixtureInput());
        const manifest = JSON.parse(files.manifestJson) as unknown;
        const request = JSON.parse(files.dummyWorldIdRequestJson) as unknown;

        expect(files.envFile).toBe(
            [
                `SONARI_IDENTITY_PACKAGE_ID=${objectId("aa")}`,
                `SONARI_IDENTITY_PAUSE_STATE_ID=${objectId("11")}`,
                `SONARI_IDENTITY_REGISTRY_ID=${objectId("22")}`,
                `SONARI_MEMBERSHIP_REGISTRY_ID=${objectId("33")}`,
                `SONARI_VERIFIER_REGISTRY_ID=${objectId("44")}`,
                `SONARI_MEMBERSHIP_PASS_ID=${objectId("66")}`,
                "",
            ].join("\n"),
        );
        expect(manifest).toMatchObject({
            schema: "sonari.membership_identity.testnet_fixture",
            version: 1,
            network: "testnet",
            generated_at: "2026-06-05T00:00:00.000Z",
            sui_client_config: ".local/sonari-dev/sui_wallets/admin/sui_config.yaml",
            objects: {
                package_id: objectId("aa"),
                admin_cap_id: objectId("ab"),
                allowed_residence_cell_registry_id: objectId("55"),
                membership_pass_id: objectId("66"),
            },
        });
        expect(request).toEqual({
            registry_id: objectId("22"),
            membership_id: objectId("66"),
            owner: objectId("77"),
            provider: "world_id",
            terms_version: DEFAULT_TERMS_VERSION,
            signed_statement_hash: DEFAULT_SIGNED_STATEMENT_HASH,
            world_id: {
                world_app_id: "app_staging_123",
                nullifier_hash: "12345678901234567890",
                merkle_root: "987654321",
                proof: "0xproof",
                verification_level: "orb",
                action: WORLD_ID_ACTION,
                signal_hash: computeWorldIdSignalHash(
                    objectId("77"),
                    objectId("66"),
                    DEFAULT_SIGNED_STATEMENT_HASH,
                ),
            },
        });
        expect(files.manifestJson).not.toMatch(/private|secret|keystore|suiprivkey/i);
        expect(files.envFile).not.toMatch(/private|secret|keystore|suiprivkey/i);
        expect(files.dummyWorldIdRequestJson).not.toMatch(/private|secret|keystore|suiprivkey/i);
    });

    it("builds the AWS submit request from manifest smoke metadata", () => {
        const manifest = buildMembershipIdentityFixtureManifest(fixtureInput());

        expect(buildDummyWorldIdRequest(manifest)).toEqual(manifest.smoke);
    });

    it("computes the World ID signal hash from the owner, membership, and statement binding", () => {
        expect(
            computeWorldIdSignalHash(objectId("77"), objectId("66"), DEFAULT_SIGNED_STATEMENT_HASH),
        ).toBe("0x4b71aa2dffa6b2a16467a508e2e1836d697729bc96849519a80f598699354901");
    });

    it("binds the dummy request signal hash to the smoke owner, membership, and statement", () => {
        const manifest = buildMembershipIdentityFixtureManifest(fixtureInput());

        expect(manifest.smoke.world_id.signal_hash).toBe(
            computeWorldIdSignalHash(objectId("77"), objectId("66"), DEFAULT_SIGNED_STATEMENT_HASH),
        );
    });

    it("fails closed on mainnet", () => {
        expect(() => assertFixtureNetwork("mainnet")).toThrow(
            "membership identity fixture only supports devnet or testnet",
        );
    });

    it("rejects empty object ids and mismatched smoke ids", () => {
        expect(() =>
            buildMembershipIdentityFixtureManifest({
                ...fixtureInput(),
                objects: { ...fixtureInput().objects, packageId: "" },
            }),
        ).toThrow("packageId must be a 0x-prefixed hex object id");

        expect(() =>
            buildMembershipIdentityFixtureManifest({
                ...fixtureInput(),
                smoke: { ...fixtureInput().smoke, membershipId: objectId("99") },
            }),
        ).toThrow("smoke membership_id must match SONARI_MEMBERSHIP_PASS_ID");
    });
});

describe("membership identity Sui JSON parsing", () => {
    it("reads package and registry ids from publish JSON", () => {
        expect(parsePublishFixtureObjects(publishJson())).toEqual({
            packageId: objectId("aa"),
            adminCapId: objectId("ab"),
            pauseStateId: objectId("11"),
            identityRegistryId: objectId("22"),
            membershipRegistryId: objectId("33"),
            verifierRegistryId: objectId("44"),
        });
    });

    it("reads pass id from MembershipPassIssued transaction events", () => {
        expect(
            parseMembershipPassIssuedId({
                events: [
                    {
                        type: `${objectId("aa")}::membership::MembershipPassIssued`,
                        parsedJson: {
                            pass_id: objectId("66"),
                        },
                    },
                ],
            }),
        ).toBe(objectId("66"));
    });

    it("rejects object type mismatches on readback", () => {
        const object = parseSuiObjectReadback({
            data: {
                objectId: objectId("22"),
                type: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.membershipRegistry}`,
                content: { fields: { issued_count: "0" } },
            },
        });

        expect(object.fields).toEqual({ issued_count: "0" });
        expect(() =>
            assertSuiObjectType(
                object,
                `${objectId("aa")}${EXPECTED_OBJECT_TYPES.identityRegistry}`,
                "identityRegistryId",
            ),
        ).toThrow(
            `identityRegistryId must be ${objectId("aa")}${EXPECTED_OBJECT_TYPES.identityRegistry}`,
        );
    });

    it("converts Sui CLI failures and invalid JSON into clear errors", () => {
        expect(() =>
            parseSuiJsonCommandResult(
                { code: 1, stdout: "", stderr: "Object not found" },
                "sui object",
            ),
        ).toThrow("sui object failed: Object not found");

        expect(() =>
            parseSuiJsonCommandResult({ code: 0, stdout: "{", stderr: "" }, "sui call"),
        ).toThrow("sui call returned invalid JSON");
    });

    it("plans object and PTB commands with explicit client config and env", () => {
        expect(
            buildSuiObjectCommand(objectId("22"), {
                clientConfig: ".local/sonari-dev/sui_wallets/admin/sui_config.yaml",
                env: "testnet",
            }),
        ).toEqual({
            command: "sui",
            args: [
                "client",
                "--client.config",
                ".local/sonari-dev/sui_wallets/admin/sui_config.yaml",
                "--client.env",
                "testnet",
                "object",
                objectId("22"),
                "--json",
            ],
        });
        expect(
            buildSuiPtbCommand(
                {
                    clientConfig: ".local/sonari-dev/sui_wallets/admin/sui_config.yaml",
                    env: "testnet",
                },
                ["--move-call", `${objectId("aa")}::accessor::new_residence_proof_step_left`],
            ).args,
        ).toContain("ptb");
    });
});

describe("membership identity base object resolution", () => {
    it("reuses existing package and registry ids after object readback", async () => {
        const executor = fakeExecutor({
            [objectId("ab")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.adminCap}`,
            [objectId("11")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.pauseState}`,
            [objectId("22")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.identityRegistry}`,
            [objectId("33")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.membershipRegistry}`,
            [objectId("44")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.verifierRegistry}`,
        });

        await expect(
            resolveBaseFixtureObjects({
                candidates: baseCandidates(),
                options: suiOptions(),
                executor,
            }),
        ).resolves.toEqual(baseCandidates());
        expect(executor.plans.map((plan) => plan.args[5])).toEqual([
            "object",
            "object",
            "object",
            "object",
            "object",
        ]);
    });

    it("stops when AdminCap is missing and publish is not explicit", async () => {
        const { adminCapId: _adminCapId, ...candidates } = baseCandidates();
        await expect(
            resolveBaseFixtureObjects({
                candidates,
                options: suiOptions(),
                executor: fakeExecutor({}),
            }),
        ).rejects.toThrow(
            "missing fixture object ids: adminCapId; pass --publish-if-missing to publish contracts",
        );
    });

    it("stops when registry ids are missing and publish is not explicit", async () => {
        const {
            identityRegistryId: _identityRegistryId,
            membershipRegistryId: _membershipRegistryId,
            ...candidates
        } = baseCandidates();
        await expect(
            resolveBaseFixtureObjects({
                candidates,
                options: suiOptions(),
                executor: fakeExecutor({}),
            }),
        ).rejects.toThrow("missing fixture object ids: identityRegistryId, membershipRegistryId");
    });

    it("rejects registry readback from a stale package publish", async () => {
        const executor = fakeExecutor({
            [objectId("ab")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.adminCap}`,
            [objectId("11")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.pauseState}`,
            [objectId("22")]: `${objectId("bb")}${EXPECTED_OBJECT_TYPES.identityRegistry}`,
            [objectId("33")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.membershipRegistry}`,
            [objectId("44")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.verifierRegistry}`,
        });

        await expect(
            resolveBaseFixtureObjects({
                candidates: baseCandidates(),
                options: suiOptions(),
                executor,
            }),
        ).rejects.toThrow(
            `identityRegistryId must be ${objectId("aa")}${EXPECTED_OBJECT_TYPES.identityRegistry}`,
        );
    });

    it("publishes only with an explicit flag and verifies created object ids", async () => {
        const executor = fakeExecutor({
            [objectId("ab")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.adminCap}`,
            [objectId("11")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.pauseState}`,
            [objectId("22")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.identityRegistry}`,
            [objectId("33")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.membershipRegistry}`,
            [objectId("44")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.verifierRegistry}`,
        });

        await expect(
            resolveBaseFixtureObjects({
                candidates: { packageId: objectId("aa") },
                options: suiOptions(),
                executor,
                publishIfMissing: true,
            }),
        ).resolves.toEqual(baseCandidates());
        expect(executor.plans[0]?.args).toEqual([
            "client",
            "--client.config",
            ".local/sonari-dev/sui_wallets/admin/sui_config.yaml",
            "--client.env",
            "testnet",
            "publish",
            "contracts",
            "--gas-budget",
            "1000000000",
            "--json",
        ]);
    });

    it("reads testnet package id from Published.toml without registry ids", () => {
        expect(
            parsePublishedTomlPackageId(
                [
                    "[published.testnet]",
                    'published-at = "0xabc"',
                    'upgrade-capability = "0xdef"',
                    "",
                ].join("\n"),
                "testnet",
            ),
        ).toBe("0xabc");
    });
});

describe("membership identity pass fixture planning", () => {
    it("plans allowed residence registry creation with the pinned fixture root", () => {
        expect(
            buildCreateAllowedResidenceCellRegistryCommand(
                {
                    packageId: objectId("aa"),
                    adminCapId: objectId("ab"),
                    root: DEFAULT_RESIDENCE_ROOT,
                    geoResolution: DEFAULT_GEO_RESOLUTION,
                    allowlistVersion: DEFAULT_ALLOWLIST_VERSION,
                    sourceHash: DEFAULT_RESIDENCE_SOURCE_HASH,
                },
                suiOptions(),
            ).args,
        ).toEqual([
            "client",
            "--client.config",
            ".local/sonari-dev/sui_wallets/admin/sui_config.yaml",
            "--client.env",
            "testnet",
            "call",
            "--package",
            objectId("aa"),
            "--module",
            "admin",
            "--function",
            "create_allowed_residence_cell_registry",
            "--args",
            objectId("ab"),
            DEFAULT_RESIDENCE_ROOT,
            DEFAULT_GEO_RESOLUTION,
            DEFAULT_ALLOWLIST_VERSION,
            DEFAULT_RESIDENCE_SOURCE_HASH,
            "--gas-budget",
            "100000000",
            "--json",
        ]);
    });

    it("plans register_member as a PTB that builds ProofStep values first", () => {
        const args = buildRegisterMemberPtbCommand(
            {
                packageId: objectId("aa"),
                pauseStateId: objectId("11"),
                membershipRegistryId: objectId("33"),
                allowedResidenceCellRegistryId: objectId("55"),
                homeCell: DEFAULT_HOME_CELL,
                proofLeft: DEFAULT_RESIDENCE_PROOF_LEFT,
                proofRight: DEFAULT_RESIDENCE_PROOF_RIGHT,
                termsVersion: DEFAULT_TERMS_VERSION,
                signedStatementHash: DEFAULT_SIGNED_STATEMENT_HASH,
            },
            suiOptions(),
        ).args;

        expect(args).toEqual(
            expect.arrayContaining([
                "ptb",
                `${objectId("aa")}::accessor::new_residence_proof_step_left`,
                hexToMoveU8Vector(DEFAULT_RESIDENCE_PROOF_LEFT),
                "proof_left",
                `${objectId("aa")}::accessor::new_residence_proof_step_right`,
                hexToMoveU8Vector(DEFAULT_RESIDENCE_PROOF_RIGHT),
                "proof_right",
                `<${objectId("aa")}::allowed_residence_cell::ProofStep>`,
                "[proof_left,proof_right]",
                "residence_proof",
                `${objectId("aa")}::accessor::register_member`,
                `@${objectId("11")}`,
                `@${objectId("33")}`,
                `@${objectId("55")}`,
                DEFAULT_HOME_CELL,
                DEFAULT_TERMS_VERSION.toString(),
                hexToMoveU8Vector(DEFAULT_SIGNED_STATEMENT_HASH),
            ]),
        );
    });

    it("reads allowed residence registry id from root update event", () => {
        expect(
            parseAllowedResidenceCellRegistryId({
                events: [
                    {
                        type: `${objectId("aa")}::allowed_residence_cell::AllowedResidenceCellRootUpdated`,
                        parsedJson: { registry_id: objectId("55") },
                    },
                ],
            }),
        ).toBe(objectId("55"));
    });

    it("accepts only unverified MembershipPass readback", () => {
        expect(
            parseUnverifiedMembershipPassReadback(
                passReadback(false),
                objectId("66"),
                objectId("aa"),
            ),
        ).toEqual({
            passId: objectId("66"),
            owner: objectId("77"),
            identityVerified: false,
            providerLabel: "Unverified",
        });

        expect(() =>
            parseUnverifiedMembershipPassReadback(
                passReadback(true),
                objectId("66"),
                objectId("aa"),
            ),
        ).toThrow("membership pass fixture must start with identity_verified=false");
    });
});

describe("membership identity fixture runner", () => {
    it("writes manifest, env, and request files from fake Sui execution", async () => {
        const outputDir = await mkdtemp(path.join(os.tmpdir(), "sonari-membership-fixture-"));
        try {
            const executor = fakeExecutor({
                [objectId("ab")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.adminCap}`,
                [objectId("11")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.pauseState}`,
                [objectId("22")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.identityRegistry}`,
                [objectId("33")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.membershipRegistry}`,
                [objectId("44")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.verifierRegistry}`,
                [objectId("55")]:
                    `${objectId("aa")}${EXPECTED_OBJECT_TYPES.allowedResidenceCellRegistry}`,
                [objectId("66")]: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.membershipPass}`,
            });

            const result = await runMembershipIdentityTestnetFixture({
                env: "testnet",
                clientConfig: ".local/sonari-dev/sui_wallets/admin/sui_config.yaml",
                outputDir,
                publishIfMissing: true,
                executor,
                processEnv: {},
                now: () => new Date("2026-06-05T00:00:00.000Z"),
            });

            await expect(readFile(result.envPath, "utf8")).resolves.toContain(
                `SONARI_MEMBERSHIP_PASS_ID=${objectId("66")}`,
            );
            await expect(readFile(result.dummyWorldIdRequestPath, "utf8")).resolves.toContain(
                `"membership_id": "${objectId("66")}"`,
            );
            const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
                readonly smoke: { readonly owner: string; readonly terms_version: number };
            };
            expect(manifest.smoke).toMatchObject({
                owner: objectId("77"),
                terms_version: DEFAULT_TERMS_VERSION,
            });
        } finally {
            await rm(outputDir, { recursive: true, force: true });
        }
    });
});

function fixtureInput(): MembershipIdentityFixtureManifestInput {
    return {
        network: "testnet",
        generatedAt: "2026-06-05T00:00:00.000Z",
        suiClientConfig: ".local/sonari-dev/sui_wallets/admin/sui_config.yaml",
        objects: {
            packageId: objectId("aa"),
            adminCapId: objectId("ab"),
            pauseStateId: objectId("11"),
            identityRegistryId: objectId("22"),
            membershipRegistryId: objectId("33"),
            verifierRegistryId: objectId("44"),
            allowedResidenceCellRegistryId: objectId("55"),
            membershipPassId: objectId("66"),
        },
        smoke: {
            registryId: objectId("22"),
            membershipId: objectId("66"),
            owner: objectId("77"),
            termsVersion: DEFAULT_TERMS_VERSION,
            signedStatementHash: DEFAULT_SIGNED_STATEMENT_HASH,
            worldId: {
                worldAppId: "app_staging_123",
                nullifierHash: "12345678901234567890",
                merkleRoot: "987654321",
                proof: "0xproof",
                verificationLevel: "orb",
                action: WORLD_ID_ACTION,
            },
        },
    };
}

function objectId(byte: string): string {
    return `0x${byte.repeat(32)}`;
}

function publishJson(): unknown {
    return {
        objectChanges: [
            {
                type: "published",
                packageId: objectId("aa"),
            },
            {
                type: "created",
                objectType: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.adminCap}`,
                objectId: objectId("ab"),
            },
        ],
        events: [
            genesisEvent(GENESIS_KIND_PAUSE_STATE, objectId("11")),
            genesisEvent(GENESIS_KIND_IDENTITY_REGISTRY, objectId("22")),
            genesisEvent(GENESIS_KIND_MEMBERSHIP_REGISTRY, objectId("33")),
            genesisEvent(GENESIS_KIND_VERIFIER_REGISTRY, objectId("44")),
        ],
    };
}

function baseCandidates() {
    return {
        packageId: objectId("aa"),
        adminCapId: objectId("ab"),
        pauseStateId: objectId("11"),
        identityRegistryId: objectId("22"),
        membershipRegistryId: objectId("33"),
        verifierRegistryId: objectId("44"),
    };
}

function suiOptions() {
    return {
        clientConfig: ".local/sonari-dev/sui_wallets/admin/sui_config.yaml",
        env: "testnet" as const,
    };
}

function fakeExecutor(typeByObjectId: Record<string, string>): SuiCommandExecutor & {
    plans: SuiCommandPlan[];
} {
    const plans: SuiCommandPlan[] = [];
    const executor = (async (plan: SuiCommandPlan): Promise<SuiCommandResult> => {
        plans.push(plan);
        if (plan.args.includes("publish")) {
            return { code: 0, stdout: JSON.stringify(publishJson()), stderr: "" };
        }
        if (plan.args.includes("create_allowed_residence_cell_registry")) {
            return {
                code: 0,
                stdout: JSON.stringify({
                    events: [
                        {
                            type: `${objectId("aa")}::allowed_residence_cell::AllowedResidenceCellRootUpdated`,
                            parsedJson: { registry_id: objectId("55") },
                        },
                    ],
                }),
                stderr: "",
            };
        }
        if (plan.args.includes("ptb")) {
            return {
                code: 0,
                stdout: JSON.stringify({
                    events: [
                        {
                            type: `${objectId("aa")}::membership::MembershipPassIssued`,
                            parsedJson: { pass_id: objectId("66") },
                        },
                    ],
                }),
                stderr: "",
            };
        }
        const objectIdArg = plan.args[6];
        if (typeof objectIdArg !== "string") {
            return { code: 1, stdout: "", stderr: "missing object id" };
        }
        const type = typeByObjectId[objectIdArg];
        if (type === undefined) {
            return { code: 1, stdout: "", stderr: `missing object: ${objectIdArg}` };
        }
        return {
            code: 0,
            stdout: JSON.stringify({
                data: {
                    objectId: objectIdArg,
                    type,
                    content: {
                        fields:
                            objectIdArg === objectId("66")
                                ? {
                                      owner: objectId("77"),
                                      identity_verified: false,
                                      provider_label: "Unverified",
                                  }
                                : {},
                    },
                },
            }),
            stderr: "",
        };
    }) as SuiCommandExecutor & { plans: SuiCommandPlan[] };
    executor.plans = plans;
    return executor;
}

function passReadback(identityVerified: boolean): unknown {
    return {
        data: {
            objectId: objectId("66"),
            type: `${objectId("aa")}${EXPECTED_OBJECT_TYPES.membershipPass}`,
            content: {
                fields: {
                    owner: objectId("77"),
                    identity_verified: identityVerified,
                    provider_label: "Unverified",
                },
            },
        },
    };
}

function genesisEvent(objectKind: number, id: string): unknown {
    return {
        type: `${objectId("aa")}::admin::GenesisObjectCreated`,
        parsedJson: {
            object_kind: objectKind,
            object_id: id,
        },
    };
}
