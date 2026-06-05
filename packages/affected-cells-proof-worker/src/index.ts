import { AffectedCellsProofError, errorResponse } from "./errors.js";

export default {
    async fetch(_request: Request): Promise<Response> {
        return errorResponse(
            new AffectedCellsProofError("not_found", "Not found", 404),
        );
    },
};
