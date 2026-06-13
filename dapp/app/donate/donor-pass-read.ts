import { bcs } from "@mysten/sui/bcs";
import { deriveDynamicFieldID } from "@mysten/sui/utils";

export interface DonorPassRegistryFieldObject {
    readonly objectId: string;
    readonly json: Record<string, unknown> | null;
}

export interface DonorPassReadClient {
    getObjects(input: {
        readonly objectIds: string[];
        readonly include: { readonly json: true };
    }): Promise<{ readonly objects: ReadonlyArray<DonorPassRegistryFieldObject | Error> }>;
}

export type DonorPassLookupResult =
    | { readonly kind: "ok"; readonly passId: string }
    | { readonly kind: "none" }
    | { readonly kind: "error"; readonly message: string };

export async function readDonorPassId(
    client: DonorPassReadClient,
    donorRegistryId: string,
    donorAddress: string,
): Promise<DonorPassLookupResult> {
    let fieldId: string;
    try {
        const keyBytes = bcs.Address.serialize(donorAddress).toBytes();
        fieldId = deriveDynamicFieldID(donorRegistryId, "address", keyBytes);
    } catch {
        return { kind: "error", message: "Donor registry lookup key is invalid." };
    }

    let item: DonorPassRegistryFieldObject | Error | undefined;
    try {
        const response = await client.getObjects({
            objectIds: [fieldId],
            include: { json: true },
        });
        item = response.objects[0];
    } catch (error) {
        return {
            kind: "error",
            message: error instanceof Error ? error.message : "Could not read DonorPass registry.",
        };
    }

    if (item === undefined || item instanceof Error) {
        return { kind: "none" };
    }
    if (item.json === null) {
        return { kind: "error", message: "DonorPass registry field JSON is missing." };
    }

    const raw = item.json.value;
    const passId = parseObjectId(raw);
    if (passId === null) {
        return { kind: "error", message: "DonorPass registry field value is invalid." };
    }

    return { kind: "ok", passId };
}

function parseObjectId(raw: unknown): string | null {
    if (typeof raw !== "string") {
        return null;
    }
    const trimmed = raw.trim();
    return /^0x[0-9a-fA-F]{64}$/u.test(trimmed) ? trimmed : null;
}
