import { describe, expect, it } from "vitest";
import type { SuiCommandPlan, SuiCommandResult } from "./membership_identity_testnet_fixture.js";
import {
    assertWorldIdActionFormat,
    buildSettingsAssignments,
    GENESIS_KIND,
    GH_SCOPE,
    guardSecrets,
    parseDisasterRegistryId,
    parseGenesisObjectIds,
    parsePublishedPackageId,
    type RepublishBootstrapOptions,
    type RewireInput,
    redactSecrets,
    rewritePublishedTomlPackageId,
    runRepublishBootstrap,
} from "./republish_contracts_bootstrap.js";

function objectId(byte: string): string {
    return `0x${byte.repeat(32)}`;
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

/** publish の events 配列を、init が必ず emit する 12 種類すべて揃えて返す。 */
function fullGenesisEvents(): unknown[] {
    return [
        genesisEvent(GENESIS_KIND.ADMIN_CAP, objectId("01")),
        genesisEvent(GENESIS_KIND.PAUSE_STATE, objectId("02")),
        genesisEvent(GENESIS_KIND.MAIN_POOL, objectId("03")),
        genesisEvent(GENESIS_KIND.OPERATIONS_POOL, objectId("04")),
        genesisEvent(GENESIS_KIND.DONOR_REGISTRY, objectId("05")),
        genesisEvent(GENESIS_KIND.MEMBERSHIP_REGISTRY, objectId("06")),
        genesisEvent(GENESIS_KIND.VERIFIER_REGISTRY, objectId("07")),
        genesisEvent(GENESIS_KIND.IDENTITY_REGISTRY, objectId("09")),
        genesisEvent(GENESIS_KIND.CATEGORY_REGISTRY, objectId("10")),
        genesisEvent(GENESIS_KIND.EARTHQUAKE_POOL, objectId("11")),
        genesisEvent(GENESIS_KIND.DISASTER_REGISTRY, objectId("d1")),
        genesisEvent(GENESIS_KIND.ALLOWED_RESIDENCE_CELL_REGISTRY, objectId("e1")),
    ];
}

function fullRewireInput(): RewireInput {
    return {
        packageId: objectId("ff"),
        genesisObjectIds: parseGenesisObjectIds({ events: fullGenesisEvents() }),
        disasterRegistryId: objectId("d1"),
        allowedResidenceCellRegistryId: objectId("e1"),
    };
}

describe("parseGenesisObjectIds", () => {
    it("init が emit する 12 種類の genesis kind をすべて Map に取り込む", () => {
        const ids = parseGenesisObjectIds({ events: fullGenesisEvents() });
        expect(ids.size).toBe(12);
        expect(ids.get(GENESIS_KIND.ADMIN_CAP)).toBe(objectId("01"));
        expect(ids.get(GENESIS_KIND.OPERATIONS_POOL)).toBe(objectId("04"));
        expect(ids.get(GENESIS_KIND.DONOR_REGISTRY)).toBe(objectId("05"));
        expect(ids.get(GENESIS_KIND.CATEGORY_REGISTRY)).toBe(objectId("10"));
        expect(ids.get(GENESIS_KIND.EARTHQUAKE_POOL)).toBe(objectId("11"));
        expect(ids.get(GENESIS_KIND.DISASTER_REGISTRY)).toBe(objectId("d1"));
        expect(ids.get(GENESIS_KIND.ALLOWED_RESIDENCE_CELL_REGISTRY)).toBe(objectId("e1"));
    });

    it("camelCase の objectKind / objectId にもフォールバックする", () => {
        const ids = parseGenesisObjectIds({
            events: [
                {
                    type: `${objectId("aa")}::admin::GenesisObjectCreated`,
                    parsedJson: { objectKind: GENESIS_KIND.MAIN_POOL, objectId: objectId("03") },
                },
            ],
        });
        expect(ids.get(GENESIS_KIND.MAIN_POOL)).toBe(objectId("03"));
    });

    it("GenesisObjectCreated 以外のイベントは無視する", () => {
        const ids = parseGenesisObjectIds({
            events: [
                {
                    type: `${objectId("aa")}::admin::SomethingElse`,
                    parsedJson: { object_kind: 1, object_id: objectId("01") },
                },
                genesisEvent(GENESIS_KIND.ADMIN_CAP, objectId("01")),
            ],
        });
        expect(ids.size).toBe(1);
    });

    it("object_kind / object_id が欠落していれば fail-closed で throw する", () => {
        expect(() =>
            parseGenesisObjectIds({
                events: [
                    {
                        type: `${objectId("aa")}::admin::GenesisObjectCreated`,
                        parsedJson: { object_kind: 1 },
                    },
                ],
            }),
        ).toThrow();
    });

    it("object_id が 0x hex でなければ throw する", () => {
        expect(() =>
            parseGenesisObjectIds({
                events: [
                    {
                        type: `${objectId("aa")}::admin::GenesisObjectCreated`,
                        parsedJson: { object_kind: 1, object_id: "not-hex" },
                    },
                ],
            }),
        ).toThrow();
    });
});

describe("buildSettingsAssignments", () => {
    function findAll(name: string) {
        return buildSettingsAssignments(fullRewireInput()).assignments.filter(
            (a) => a.name === name,
        );
    }

    it("AdminCap (kind 1) は SONARI_ADMIN_CAP_ID(repo) へ張替える", () => {
        const [a] = findAll("SONARI_ADMIN_CAP_ID");
        expect(a?.value).toBe(objectId("01"));
        expect(a?.scopes).toEqual([GH_SCOPE.REPO]);
        expect(a?.secret).toBe(false);
    });

    it("PauseState (kind 2) は identity / floor_census の 2 変数へ同値で展開する", () => {
        const identity = findAll("SONARI_IDENTITY_PAUSE_STATE_ID");
        const floor = findAll("SONARI_FLOOR_CENSUS_PAUSE_STATE");
        expect(identity).toHaveLength(1);
        expect(floor).toHaveLength(1);
        expect(identity[0]?.value).toBe(objectId("02"));
        expect(floor[0]?.value).toBe(objectId("02"));
    });

    it("MainPool (kind 3) は SONARI_FLOOR_CENSUS_MAIN_POOL へ張替える", () => {
        expect(findAll("SONARI_FLOOR_CENSUS_MAIN_POOL")[0]?.value).toBe(objectId("03"));
    });

    it("MembershipRegistry (kind 6) は SONARI_MEMBERSHIP_REGISTRY_ID へ張替える", () => {
        expect(findAll("SONARI_MEMBERSHIP_REGISTRY_ID")[0]?.value).toBe(objectId("06"));
    });

    it("VerifierRegistry (kind 7) は SONARI 変数(repo) と AWS relayer 変数(repo+env) へ張替える", () => {
        expect(findAll("SONARI_VERIFIER_REGISTRY_ID")[0]?.value).toBe(objectId("07"));
        const aws = findAll("AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_VERIFIER_REGISTRY")[0];
        expect(aws?.value).toBe(objectId("07"));
        expect(aws?.scopes).toEqual([GH_SCOPE.REPO, GH_SCOPE.ENV_AWS_DEV]);
    });

    it("IdentityRegistry (kind 9) と CategoryRegistry (kind 10) を張替える", () => {
        expect(findAll("SONARI_IDENTITY_REGISTRY_ID")[0]?.value).toBe(objectId("09"));
        expect(findAll("SONARI_CATEGORY_REGISTRY_ID")[0]?.value).toBe(objectId("10"));
    });

    it("EarthquakePool (kind 11) は earthquake / floor_census の 2 変数へ同値で展開する", () => {
        expect(findAll("SONARI_EARTHQUAKE_CATEGORY_POOL_ID")[0]?.value).toBe(objectId("11"));
        expect(findAll("SONARI_FLOOR_CENSUS_CATEGORY_POOL")[0]?.value).toBe(objectId("11"));
    });

    it("init の DisasterRegistry は AWS relayer registry(repo+env) へ張替える", () => {
        const aws = findAll("AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_REGISTRY")[0];
        expect(aws?.value).toBe(objectId("d1"));
        expect(aws?.scopes).toEqual([GH_SCOPE.REPO, GH_SCOPE.ENV_AWS_DEV]);
    });

    it("init の AllowedResidenceCellRegistry を SONARI 変数へ張替える", () => {
        expect(findAll("SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID")[0]?.value).toBe(objectId("e1"));
    });

    it("SONARI_FLOOR_CENSUS_TARGET は新 package id から導出する", () => {
        expect(findAll("SONARI_FLOOR_CENSUS_TARGET")[0]?.value).toBe(
            `${objectId("ff")}::accessor::set_floor_census`,
        );
    });

    it("OperationsPool(kind 4) / DonorRegistry(kind 5) は張替え対象外で cross-check に分離する", () => {
        const plan = buildSettingsAssignments(fullRewireInput());
        const opsId = objectId("04");
        const donorId = objectId("05");
        // assignments には ops/donor の値が一切含まれない
        expect(plan.assignments.some((a) => a.value === opsId || a.value === donorId)).toBe(false);
        const kinds = plan.crossChecks.map((c) => c.objectKind).sort();
        expect(kinds).toEqual([GENESIS_KIND.OPERATIONS_POOL, GENESIS_KIND.DONOR_REGISTRY].sort());
        expect(
            plan.crossChecks.find((c) => c.objectKind === GENESIS_KIND.OPERATIONS_POOL)?.objectId,
        ).toBe(opsId);
    });

    it("必須の genesis kind が欠けていれば fail-closed で throw する", () => {
        const input = fullRewireInput();
        const partial = new Map(input.genesisObjectIds);
        partial.delete(GENESIS_KIND.VERIFIER_REGISTRY);
        expect(() => buildSettingsAssignments({ ...input, genesisObjectIds: partial })).toThrow(
            /VerifierRegistry|kind=7/,
        );
    });

    it("packageId が 0x hex でなければ throw する", () => {
        expect(() =>
            buildSettingsAssignments({ ...fullRewireInput(), packageId: "nope" }),
        ).toThrow();
    });

    it("どの assignment にも秘密鍵は含めない（secret は別経路）", () => {
        const plan = buildSettingsAssignments(fullRewireInput());
        expect(plan.assignments.every((a) => a.secret === false)).toBe(true);
    });
});

describe("assertWorldIdActionFormat", () => {
    it("sonari_membership_register_v<N> を受け入れる", () => {
        expect(() => assertWorldIdActionFormat("sonari_membership_register_v7")).not.toThrow();
        expect(() => assertWorldIdActionFormat("sonari_membership_register_v8")).not.toThrow();
        expect(() => assertWorldIdActionFormat("sonari_membership_register_v123")).not.toThrow();
    });

    it("version 番号が無い・前後にゴミがある・大文字などは reject する", () => {
        expect(() => assertWorldIdActionFormat("sonari_membership_register")).toThrow();
        expect(() => assertWorldIdActionFormat("sonari_membership_register_v")).toThrow();
        expect(() => assertWorldIdActionFormat("sonari_membership_register_v8 ")).toThrow();
        expect(() => assertWorldIdActionFormat("SONARI_membership_register_v8")).toThrow();
        expect(() => assertWorldIdActionFormat("other_action_v8")).toThrow();
    });
});

describe("guardSecrets", () => {
    const plan: SuiCommandPlan = { command: "sui", args: ["client", "publish", "contracts"] };

    it("どの引数にも secret が現れなければ通す", () => {
        expect(() => guardSecrets([plan], ["super-secret-key"])).not.toThrow();
    });

    it("引数に secret が混入していれば fail-closed で throw する", () => {
        const leaky: SuiCommandPlan = {
            command: "sui",
            args: ["client", "--key", "super-secret-key"],
        };
        expect(() => guardSecrets([leaky], ["super-secret-key"])).toThrow();
    });

    it("空文字の secret は無視する（誤検知しない）", () => {
        expect(() => guardSecrets([plan], ["", "  "])).not.toThrow();
    });
});

describe("redactSecrets", () => {
    it("出力中の secret を伏字へ置換する", () => {
        const out = redactSecrets("token=super-secret-key done", ["super-secret-key"]);
        expect(out).not.toContain("super-secret-key");
        expect(out).toContain("***REDACTED***");
    });

    it("secret が無ければ原文のまま返す", () => {
        expect(redactSecrets("nothing here", ["abc"])).toBe("nothing here");
    });
});

describe("parsePublishedPackageId", () => {
    it("objectChanges の published 項目から package id を取り出す", () => {
        const id = parsePublishedPackageId({
            objectChanges: [{ type: "published", packageId: objectId("ff") }],
        });
        expect(id).toBe(objectId("ff"));
    });

    it("published 項目が無ければ throw する", () => {
        expect(() => parsePublishedPackageId({ objectChanges: [{ type: "created" }] })).toThrow();
    });
});

describe("parseDisasterRegistryId", () => {
    it("DisasterRegistryCreated イベントから registry_id を取り出す", () => {
        const id = parseDisasterRegistryId({
            events: [
                {
                    type: `${objectId("aa")}::disaster_event::DisasterRegistryCreated`,
                    parsedJson: { registry_id: objectId("d1") },
                },
            ],
        });
        expect(id).toBe(objectId("d1"));
    });

    it("イベントが無ければ throw する", () => {
        expect(() => parseDisasterRegistryId({ events: [] })).toThrow();
    });
});

describe("runRepublishBootstrap", () => {
    const REAL_ROOT = `0x${"33".repeat(32)}`;
    const SOURCE_HASH = `0x${"11".repeat(32)}`;
    const TOML = [
        "[published.testnet]",
        'published-at = "0xold"',
        'original-id = "0xold"',
        "version = 1",
    ].join("\n");

    function baseOptions(
        overrides: Partial<RepublishBootstrapOptions> = {},
    ): RepublishBootstrapOptions {
        return {
            clientConfig: ".local/sonari-dev/sui_wallets/admin/client.yaml",
            env: "testnet",
            publishedToml: TOML,
            residenceRoot: REAL_ROOT,
            residenceGeoResolution: "9",
            residenceAllowlistVersion: "1",
            residenceSourceHash: SOURCE_HASH,
            dryRun: true,
            secrets: ["super-secret-key"],
            ...overrides,
        };
    }

    function liveExecutor(): {
        executor: (plan: SuiCommandPlan) => Promise<SuiCommandResult>;
        calls: SuiCommandPlan[];
    } {
        const calls: SuiCommandPlan[] = [];
        const executor = (plan: SuiCommandPlan): Promise<SuiCommandResult> => {
            calls.push(plan);
            const json = (value: unknown): SuiCommandResult => ({
                code: 0,
                stdout: JSON.stringify(value),
                stderr: "",
            });
            if (plan.args.includes("publish")) {
                return Promise.resolve(
                    json({
                        objectChanges: [{ type: "published", packageId: objectId("ff") }],
                        events: [
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.ADMIN_CAP,
                                    object_id: objectId("01"),
                                },
                            },
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.PAUSE_STATE,
                                    object_id: objectId("02"),
                                },
                            },
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.MAIN_POOL,
                                    object_id: objectId("03"),
                                },
                            },
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.OPERATIONS_POOL,
                                    object_id: objectId("04"),
                                },
                            },
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.DONOR_REGISTRY,
                                    object_id: objectId("05"),
                                },
                            },
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.MEMBERSHIP_REGISTRY,
                                    object_id: objectId("06"),
                                },
                            },
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.VERIFIER_REGISTRY,
                                    object_id: objectId("07"),
                                },
                            },
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.IDENTITY_REGISTRY,
                                    object_id: objectId("09"),
                                },
                            },
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.CATEGORY_REGISTRY,
                                    object_id: objectId("10"),
                                },
                            },
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.EARTHQUAKE_POOL,
                                    object_id: objectId("11"),
                                },
                            },
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.DISASTER_REGISTRY,
                                    object_id: objectId("d1"),
                                },
                            },
                            {
                                type: `${objectId("ff")}::admin::GenesisObjectCreated`,
                                parsedJson: {
                                    object_kind: GENESIS_KIND.ALLOWED_RESIDENCE_CELL_REGISTRY,
                                    object_id: objectId("e1"),
                                },
                            },
                        ],
                    }),
                );
            }
            if (plan.args.includes("update_allowed_residence_cell_root")) {
                return Promise.resolve(
                    json({
                        events: [
                            {
                                type: `${objectId("ff")}::allowed_residence_cell::AllowedResidenceCellRootUpdated`,
                                parsedJson: { registry_id: objectId("e1") },
                            },
                        ],
                    }),
                );
            }
            throw new Error(`unexpected command: ${plan.args.join(" ")}`);
        };
        return { executor, calls };
    }

    it("dry-run では executor を一切呼ばず publish 計画だけ返す", async () => {
        const { executor, calls } = liveExecutor();
        const result = await runRepublishBootstrap(baseOptions({ dryRun: true }), executor);
        expect(calls).toHaveLength(0);
        expect(result.dryRun).toBe(true);
        expect(result.plannedCommands[0]?.args).toContain("publish");
        expect(result.settings).toBeUndefined();
        expect(result.packageId).toBeUndefined();
    });

    it("live 実行で publish → residence root update の順に呼び、ID と settings と新 toml を返す", async () => {
        const { executor, calls } = liveExecutor();
        const result = await runRepublishBootstrap(baseOptions({ dryRun: false }), executor);
        expect(
            calls.map((c) =>
                c.args.includes("publish") ? "publish" : c.args[c.args.indexOf("--function") + 1],
            ),
        ).toEqual(["publish", "update_allowed_residence_cell_root"]);
        expect(result.packageId).toBe(objectId("ff"));
        expect(result.disasterRegistryId).toBe(objectId("d1"));
        expect(result.allowedResidenceCellRegistryId).toBe(objectId("e1"));
        expect(
            result.settings?.assignments.find((a) => a.name === "SONARI_ADMIN_CAP_ID")?.value,
        ).toBe(objectId("01"));
        expect(result.rewrittenPublishedToml).toContain(`published-at = "${objectId("ff")}"`);
    });

    it("residence root 更新は AdminCap・registry・実 root・source hash を引数に渡す", async () => {
        const { executor, calls } = liveExecutor();
        await runRepublishBootstrap(baseOptions({ dryRun: false }), executor);
        const residence = calls.find((c) => c.args.includes("update_allowed_residence_cell_root"));
        expect(residence?.args).toContain(objectId("01")); // AdminCap
        expect(residence?.args).toContain(objectId("e1")); // AllowedResidenceCellRegistry
        expect(residence?.args).toContain(REAL_ROOT);
        expect(residence?.args).toContain(SOURCE_HASH);
    });

    it("residenceRoot が hex32 でなければ throw する", async () => {
        const { executor } = liveExecutor();
        await expect(
            runRepublishBootstrap(baseOptions({ dryRun: false, residenceRoot: "0x12" }), executor),
        ).rejects.toThrow();
    });
});

describe("rewritePublishedTomlPackageId", () => {
    const SAMPLE = [
        "# Generated by Move",
        "",
        "[published.testnet]",
        'chain-id = "4c78adac"',
        'published-at = "0x36fb8f4e1b83f0f57f558bb106e66a9ea1449e3475b30ff89461e34223e0078e"',
        'original-id = "0x36fb8f4e1b83f0f57f558bb106e66a9ea1449e3475b30ff89461e34223e0078e"',
        "version = 1",
        'upgrade-capability = "0x1b54bc81378a37db8ac21193465641e05424dae3de3e662200bfbb17c0ef0d0c"',
        "",
    ].join("\n");

    const NEW_ID = `0x${"ab".repeat(32)}`;

    it("対象 env の published-at と original-id を新 package id へ書換える", () => {
        const out = rewritePublishedTomlPackageId(SAMPLE, "testnet", NEW_ID);
        expect(out).toContain(`published-at = "${NEW_ID}"`);
        expect(out).toContain(`original-id = "${NEW_ID}"`);
        expect(out).not.toContain("0x36fb8f4e");
    });

    it("chain-id / version / upgrade-capability など他の行は保持する", () => {
        const out = rewritePublishedTomlPackageId(SAMPLE, "testnet", NEW_ID);
        expect(out).toContain('chain-id = "4c78adac"');
        expect(out).toContain("version = 1");
        expect(out).toContain(
            'upgrade-capability = "0x1b54bc81378a37db8ac21193465641e05424dae3de3e662200bfbb17c0ef0d0c"',
        );
    });

    it("対象 env のセクションが無ければ throw する", () => {
        expect(() => rewritePublishedTomlPackageId(SAMPLE, "devnet", NEW_ID)).toThrow();
    });

    it("published-at が見つからなければ throw する", () => {
        const broken = SAMPLE.replace(/^published-at = .*$/m, "");
        expect(() => rewritePublishedTomlPackageId(broken, "testnet", NEW_ID)).toThrow();
    });

    it("新 package id が 0x hex でなければ throw する", () => {
        expect(() => rewritePublishedTomlPackageId(SAMPLE, "testnet", "nope")).toThrow();
    });

    it("別 env のセクションを巻き込まない", () => {
        const multi = `${SAMPLE}\n[published.mainnet]\npublished-at = "0xdead"\noriginal-id = "0xdead"\n`;
        const out = rewritePublishedTomlPackageId(multi, "testnet", NEW_ID);
        expect(out).toContain('[published.mainnet]\npublished-at = "0xdead"');
    });
});
