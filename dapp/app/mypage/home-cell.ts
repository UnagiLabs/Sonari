import { parseH3Index } from "@sonari/proof-core";
import { h3DecimalToHex, RESIDENCE_H3_RESOLUTION } from "../register/residence/h3-geo";

/**
 * A validated residence cell ready for map drawing.
 * `decimal` is the on-chain u64 value; `hex` is the h3-js native id.
 */
export interface HomeCell {
    readonly decimal: string;
    readonly hex: string;
}

/**
 * Validate a `home_cell` decimal value for map display.
 *
 * The contract does not enforce the cell resolution, and an unregistered pass
 * stores 0, so we strictly check the value is a canonical res7 H3 cell. Any
 * invalid input (0, wrong resolution, non-numeric) returns null so the UI can
 * fall back to a plain text display instead of a broken map.
 */
export function parseHomeCell(decimal: string): HomeCell | null {
    try {
        parseH3Index(decimal, RESIDENCE_H3_RESOLUTION);
        return { decimal, hex: h3DecimalToHex(decimal) };
    } catch {
        return null;
    }
}
