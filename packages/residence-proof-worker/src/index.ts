import { type Env, handleResidenceProofRequest } from "./http.js";

export { type Env, handleResidenceProofRequest, jsonResponse } from "./http.js";
export * from "./proof_shards.js";
export { loadProofManifest, loadProofShard, proofManifestObjectKey } from "./r2.js";

export default {
    fetch(request: Request, env: Env): Promise<Response> {
        return handleResidenceProofRequest(request, env);
    },
};
