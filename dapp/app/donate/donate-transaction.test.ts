import { describe, expect, it } from "vitest";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { buildDonateTransaction } from "./donate-transaction";

const PACKAGE_ID = `0x${"ab".repeat(32)}`;
const SENDER = `0x${"11".repeat(32)}`;
const USDC_TYPE = `0x${"cd".repeat(32)}::usdc::USDC`;
const AMOUNT_MICRO_USDC = 1_234_567n;
const AMOUNT_DONATED = 2_345_678n;
const EXISTING_PASS_ID = `0x${"44".repeat(32)}`;

const OBJECTS = {
    pauseState: `0x${"01".repeat(32)}`,
    donorRegistry: `0x${"02".repeat(32)}`,
    mainPool: `0x${"03".repeat(32)}`,
    operationsPool: `0x${"04".repeat(32)}`,
} as const;

function commandNames(transaction: ReturnType<typeof buildDonateTransaction>["transaction"]): readonly string[] {
    return transaction.getData().commands.map((command) =>
        command.$kind === "MoveCall" ? command.MoveCall.function : command.$kind,
    );
}

describe("buildDonateTransaction", () => {
    it("builds initial general donation as issue, donate, and transfer", () => {
        const { transaction } = buildDonateTransaction({
            senderAddress: SENDER,
            packageId: PACKAGE_ID,
            usdcType: USDC_TYPE,
            amountMicroUsdc: AMOUNT_MICRO_USDC,
            objects: OBJECTS,
            destination: { kind: "general" },
            donorPass: { kind: "none" },
        });

        const data = transaction.getData();

        expect(data.sender).toBe(SENDER);
        expect(commandNames(transaction)).toEqual([
            "$Intent",
            "issue_donor_pass",
            "donate_general",
            "transfer_donor_pass",
        ]);

        const issueCall = data.commands[1];
        expect(issueCall?.$kind).toBe("MoveCall");
        if (issueCall?.$kind !== "MoveCall") {
            return;
        }
        expect(issueCall.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "issue_donor_pass",
        });
        expect(issueCall.MoveCall.arguments).toEqual([
            { $kind: "Input", Input: 0, type: "object" },
            { $kind: "Input", Input: 1, type: "object" },
        ]);

        const donateCall = data.commands[2];
        expect(donateCall?.$kind).toBe("MoveCall");
        if (donateCall?.$kind !== "MoveCall") {
            return;
        }
        expect(donateCall.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "donate_general",
        });
        expect(donateCall.MoveCall.arguments).toEqual([
            { $kind: "Input", Input: 0, type: "object" },
            { $kind: "Input", Input: 1, type: "object" },
            { $kind: "Result", Result: 1 },
            { $kind: "Input", Input: 2, type: "object" },
            { $kind: "Input", Input: 3, type: "object" },
            { $kind: "Result", Result: 0 },
        ]);

        const transferCall = data.commands[3];
        expect(transferCall?.$kind).toBe("MoveCall");
        if (transferCall?.$kind !== "MoveCall") {
            return;
        }
        expect(transferCall.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "transfer_donor_pass",
        });
        expect(transferCall.MoveCall.arguments).toEqual([{ $kind: "Result", Result: 1 }]);
    });

    it("builds initial campaign donation with clock argument and issued pass", () => {
        const campaignId = `0x${"21".repeat(32)}`;
        const { transaction } = buildDonateTransaction({
            senderAddress: SENDER,
            packageId: PACKAGE_ID,
            usdcType: USDC_TYPE,
            amountMicroUsdc: AMOUNT_DONATED,
            objects: OBJECTS,
            destination: {
                kind: "campaign",
                campaignId,
            },
            donorPass: { kind: "none" },
        });

        const data = transaction.getData();

        expect(commandNames(transaction)).toEqual([
            "$Intent",
            "issue_donor_pass",
            "donate_to_campaign",
            "transfer_donor_pass",
        ]);
        const donateCall = data.commands[2];
        expect(donateCall?.$kind).toBe("MoveCall");
        if (donateCall?.$kind !== "MoveCall") {
            return;
        }

        expect(donateCall.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "donate_to_campaign",
        });

        expect(donateCall.MoveCall.arguments).toEqual([
            { $kind: "Input", Input: 0, type: "object" },
            { $kind: "Input", Input: 1, type: "object" },
            { $kind: "Result", Result: 1 },
            { $kind: "Input", Input: 2, type: "object" },
            { $kind: "Input", Input: 3, type: "object" },
            { $kind: "Input", Input: 4, type: "object" },
            { $kind: "Result", Result: 0 },
            { $kind: "Input", Input: 5, type: "object" },
        ]);

        expect(data.inputs.map((input) => input.UnresolvedObject?.objectId)).toEqual([
            OBJECTS.pauseState,
            OBJECTS.donorRegistry,
            campaignId,
            OBJECTS.mainPool,
            OBJECTS.operationsPool,
            SUI_CLOCK_OBJECT_ID,
        ]);
        expect(data.inputs).toHaveLength(6);
    });

    it("uses the override clock when provided for campaign donations", () => {
        const campaignId = `0x${"22".repeat(32)}`;
        const overrideClock = `0x${"ff".repeat(32)}`;
        const { transaction } = buildDonateTransaction({
            packageId: PACKAGE_ID,
            usdcType: USDC_TYPE,
            amountMicroUsdc: AMOUNT_DONATED,
            objects: OBJECTS,
            destination: {
                kind: "campaign",
                campaignId,
            },
            donorPass: { kind: "none" },
            clock: overrideClock,
        });

        const data = transaction.getData();
        const donateCall = data.commands[2];
        expect(donateCall?.$kind).toBe("MoveCall");
        if (donateCall?.$kind !== "MoveCall") {
            return;
        }

        const clockArgument = donateCall.MoveCall.arguments.at(-1);
        expect(clockArgument).toMatchObject({
            $kind: "Input",
            type: "object",
            Input: 5,
        });

        expect(data.inputs[5]).toMatchObject({
            UnresolvedObject: { objectId: overrideClock },
        });
    });

    it("builds initial category donation with issued pass", () => {
        const categoryPoolId = `0x${"31".repeat(32)}`;
        const { transaction } = buildDonateTransaction({
            senderAddress: SENDER,
            packageId: PACKAGE_ID,
            usdcType: USDC_TYPE,
            amountMicroUsdc: AMOUNT_MICRO_USDC,
            objects: OBJECTS,
            destination: {
                kind: "category",
                categoryPoolId,
            },
            donorPass: { kind: "none" },
        });

        const data = transaction.getData();
        expect(commandNames(transaction)).toEqual([
            "$Intent",
            "issue_donor_pass",
            "donate_to_category",
            "transfer_donor_pass",
        ]);

        const donateCall = data.commands[2];
        expect(donateCall?.$kind).toBe("MoveCall");
        if (donateCall?.$kind !== "MoveCall") {
            return;
        }

        expect(donateCall.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "donate_to_category",
        });
        expect(donateCall.MoveCall.arguments).toEqual([
            { $kind: "Input", Input: 0, type: "object" },
            { $kind: "Input", Input: 1, type: "object" },
            { $kind: "Result", Result: 1 },
            { $kind: "Input", Input: 2, type: "object" },
            { $kind: "Input", Input: 3, type: "object" },
            { $kind: "Input", Input: 4, type: "object" },
            { $kind: "Result", Result: 0 },
        ]);
    });

    it("builds continuing general donation with an existing pass", () => {
        const { transaction } = buildDonateTransaction({
            packageId: PACKAGE_ID,
            usdcType: USDC_TYPE,
            amountMicroUsdc: AMOUNT_MICRO_USDC,
            objects: OBJECTS,
            destination: { kind: "general" },
            donorPass: { kind: "existing", passId: EXISTING_PASS_ID },
        });

        const data = transaction.getData();
        expect(commandNames(transaction)).toEqual(["$Intent", "donate_general"]);
        const donateCall = data.commands.at(-1);
        expect(donateCall?.$kind).toBe("MoveCall");
        if (donateCall?.$kind !== "MoveCall") {
            return;
        }

        expect(donateCall.MoveCall.arguments).toEqual([
            { $kind: "Input", Input: 0, type: "object" },
            { $kind: "Input", Input: 1, type: "object" },
            { $kind: "Input", Input: 2, type: "object" },
            { $kind: "Input", Input: 3, type: "object" },
            { $kind: "Input", Input: 4, type: "object" },
            { $kind: "Result", Result: 0 },
        ]);
    });

    it("builds continuing campaign and category donations with an existing pass", () => {
        const campaignId = `0x${"21".repeat(32)}`;
        const categoryPoolId = `0x${"31".repeat(32)}`;

        const campaign = buildDonateTransaction({
            packageId: PACKAGE_ID,
            usdcType: USDC_TYPE,
            amountMicroUsdc: AMOUNT_MICRO_USDC,
            objects: OBJECTS,
            destination: { kind: "campaign", campaignId },
            donorPass: { kind: "existing", passId: EXISTING_PASS_ID },
        }).transaction;
        const category = buildDonateTransaction({
            packageId: PACKAGE_ID,
            usdcType: USDC_TYPE,
            amountMicroUsdc: AMOUNT_MICRO_USDC,
            objects: OBJECTS,
            destination: { kind: "category", categoryPoolId },
            donorPass: { kind: "existing", passId: EXISTING_PASS_ID },
        }).transaction;

        expect(commandNames(campaign)).toEqual(["$Intent", "donate_to_campaign"]);
        expect(commandNames(category)).toEqual(["$Intent", "donate_to_category"]);
    });

    it("uses CoinWithBalance intent with configured usdc type and balance", () => {
        const { transaction } = buildDonateTransaction({
            packageId: PACKAGE_ID,
            usdcType: USDC_TYPE,
            amountMicroUsdc: AMOUNT_DONATED,
            objects: OBJECTS,
            destination: { kind: "general" },
            donorPass: { kind: "none" },
        });

        const data = transaction.getData();
        const coinIntentCommand = data.commands[0];
        expect(coinIntentCommand?.$kind).toBe("$Intent");
        if (coinIntentCommand?.$kind !== "$Intent") {
            return;
        }

        expect(coinIntentCommand.$Intent).toMatchObject({
            name: "CoinWithBalance",
            data: {
                type: USDC_TYPE,
                balance: AMOUNT_DONATED,
            },
        });
    });
});
