import { describe, expect, it } from "vitest";
import {
    assertWorldIdActionFormat,
    buildSettingsAssignments,
    GENESIS_KIND,
    GH_SCOPE,
    parseGenesisObjectIds,
    type RewireInput,
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

/** publish の events 配列を、init が必ず emit する 10 種類すべて揃えて返す。 */
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
    it("init が emit する 10 種類の genesis kind をすべて Map に取り込む", () => {
        const ids = parseGenesisObjectIds({ events: fullGenesisEvents() });
        expect(ids.size).toBe(10);
        expect(ids.get(GENESIS_KIND.ADMIN_CAP)).toBe(objectId("01"));
        expect(ids.get(GENESIS_KIND.OPERATIONS_POOL)).toBe(objectId("04"));
        expect(ids.get(GENESIS_KIND.DONOR_REGISTRY)).toBe(objectId("05"));
        expect(ids.get(GENESIS_KIND.CATEGORY_REGISTRY)).toBe(objectId("10"));
        expect(ids.get(GENESIS_KIND.EARTHQUAKE_POOL)).toBe(objectId("11"));
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

    it("後付けの DisasterRegistry は AWS relayer registry(repo+env) へ張替える", () => {
        const aws = findAll("AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_REGISTRY")[0];
        expect(aws?.value).toBe(objectId("d1"));
        expect(aws?.scopes).toEqual([GH_SCOPE.REPO, GH_SCOPE.ENV_AWS_DEV]);
    });

    it("後付けの AllowedResidenceCellRegistry を SONARI 変数へ張替える", () => {
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
