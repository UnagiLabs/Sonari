import { describe, expect, it } from "vitest";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { buildDonateTransaction } from "./donate-transaction";

const PACKAGE_ID = `0x${"ab".repeat(32)}`;
const SENDER = `0x${"11".repeat(32)}`;
const USDC_TYPE = `0x${"cd".repeat(32)}::usdc::USDC`;
const AMOUNT_MICRO_USDC = 1_234_567n;
const AMOUNT_DONATED = 2_345_678n;

const OBJECTS = {
    pauseState: `0x${"01".repeat(32)}`,
    mainPool: `0x${"02".repeat(32)}`,
    operationsPool: `0x${"03".repeat(32)}`,
} as const;

describe("buildDonateTransaction", () => {
    it("builds general donation with exact target and argument order", () => {
        const { transaction } = buildDonateTransaction({
            senderAddress: SENDER,
            packageId: PACKAGE_ID,
            usdcType: USDC_TYPE,
            amountMicroUsdc: AMOUNT_MICRO_USDC,
            objects: OBJECTS,
            destination: { kind: "general" },
        });

        const data = transaction.getData();
        const commandNames = data.commands.map((command) =>
            command.$kind === "MoveCall" ? command.MoveCall.function : command.$kind,
        );

        expect(data.sender).toBe(SENDER);
        expect(commandNames).toEqual(["$Intent", "donate_general_split_usdc"]);

        const moveCall = data.commands.at(-1);
        expect(moveCall?.$kind).toBe("MoveCall");
        if (moveCall?.$kind !== "MoveCall") {
            return;
        }

        expect(moveCall.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "donate_general_split_usdc",
        });

        expect(moveCall.MoveCall.arguments).toEqual([
            { $kind: "Input", Input: 0, type: "object" },
            { $kind: "Input", Input: 1, type: "object" },
            { $kind: "Input", Input: 2, type: "object" },
            { $kind: "Result", Result: 0 },
        ]);
    });

    it("builds campaign donation with clock argument and no donor registry arg", () => {
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
        });

        const data = transaction.getData();
        const commandNames = data.commands.map((command) =>
            command.$kind === "MoveCall" ? command.MoveCall.function : command.$kind,
        );

        expect(commandNames).toEqual(["$Intent", "donate_to_campaign_usdc"]);
        const moveCall = data.commands.at(-1);
        expect(moveCall?.$kind).toBe("MoveCall");
        if (moveCall?.$kind !== "MoveCall") {
            return;
        }

        expect(moveCall.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "donate_to_campaign_usdc",
        });

        expect(moveCall.MoveCall.arguments).toEqual([
            { $kind: "Input", Input: 0, type: "object" },
            { $kind: "Input", Input: 1, type: "object" },
            { $kind: "Input", Input: 2, type: "object" },
            { $kind: "Input", Input: 3, type: "object" },
            { $kind: "Result", Result: 0 },
            { $kind: "Input", Input: 4, type: "object" },
        ]);

        expect(data.inputs.map((input) => input.UnresolvedObject?.objectId)).toEqual([
            OBJECTS.pauseState,
            campaignId,
            OBJECTS.mainPool,
            OBJECTS.operationsPool,
            SUI_CLOCK_OBJECT_ID,
        ]);
        expect(data.inputs).toHaveLength(5);
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
            clock: overrideClock,
        });

        const data = transaction.getData();
        const moveCall = data.commands.at(-1);
        expect(moveCall?.$kind).toBe("MoveCall");
        if (moveCall?.$kind !== "MoveCall") {
            return;
        }

        const clockArgument = moveCall.MoveCall.arguments.at(-1);
        expect(clockArgument).toMatchObject({
            $kind: "Input",
            type: "object",
            Input: 4,
        });

        expect(data.inputs[4]).toMatchObject({
            UnresolvedObject: { objectId: overrideClock },
        });
    });

    it("builds category donation with exact target and argument order", () => {
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
        });

        const data = transaction.getData();
        const commandNames = data.commands.map((command) =>
            command.$kind === "MoveCall" ? command.MoveCall.function : command.$kind,
        );

        expect(commandNames).toEqual(["$Intent", "donate_to_category_usdc"]);
        const moveCall = data.commands.at(-1);
        expect(moveCall?.$kind).toBe("MoveCall");
        if (moveCall?.$kind !== "MoveCall") {
            return;
        }

        expect(moveCall.MoveCall).toMatchObject({
            package: PACKAGE_ID,
            module: "accessor",
            function: "donate_to_category_usdc",
        });
        expect(moveCall.MoveCall.arguments).toEqual([
            { $kind: "Input", Input: 0, type: "object" },
            { $kind: "Input", Input: 1, type: "object" },
            { $kind: "Input", Input: 2, type: "object" },
            { $kind: "Input", Input: 3, type: "object" },
            { $kind: "Result", Result: 0 },
        ]);
    });

    it("uses CoinWithBalance intent with configured usdc type and balance", () => {
        const { transaction } = buildDonateTransaction({
            packageId: PACKAGE_ID,
            usdcType: USDC_TYPE,
            amountMicroUsdc: AMOUNT_DONATED,
            objects: OBJECTS,
            destination: { kind: "general" },
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
