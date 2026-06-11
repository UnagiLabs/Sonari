import { type Env, handleResidenceProofRequest } from "./http.js";
import type { TileExecutionContext } from "./tiles.js";

export { type Env, handleResidenceProofRequest, jsonResponse } from "./http.js";
export * from "./proof_shards.js";
export {
    loadProofManifest,
    loadProofShard,
    loadTileBytes,
    loadTileManifest,
    proofManifestObjectKey,
    tileManifestObjectKey,
    tileObjectKey,
} from "./r2.js";
export {
    handleResidenceTileRequest,
    isResidenceTilePath,
    type TileExecutionContext,
} from "./tiles.js";

export default {
    fetch(request: Request, env: Env, ctx?: TileExecutionContext): Promise<Response> {
        return handleResidenceProofRequest(request, env, ctx);
    },
};
