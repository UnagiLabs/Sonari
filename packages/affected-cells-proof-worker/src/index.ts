/**
 * index.ts
 *
 * Worker エントリポイント。
 * 2 本の API を 1 Worker にまとめて、ルート振り分けを行う。
 *
 * ルート:
 *   POST /events/:event_uid/revisions/:event_revision/affected-cells → handleRegisterRequest
 *   GET  /events/:event_uid/revisions/:event_revision/proof?h3_index=... → handleProofRequest
 *   上記パスにマッチするが method が違う → 405 method_not_allowed
 *   どのルートにもマッチしない → 404 not_found
 *
 * エラー処理: try→unchecked dispatch→catch で errorResponse(toAffectedCellsProofError(e))
 */

import {
    AffectedCellsProofError,
    errorResponse,
    toAffectedCellsProofError,
} from "./errors.js";
import {
    type AffectedAreaWorkflowEnv,
    type AffectedAreaWorkflowPublishSummary,
    runAffectedAreaArtifactWorkflow,
} from "./affected_area_workflow.js";
import {
    type AffectedAreaWorkflowInput,
    validateAffectedAreaWorkflowInput,
} from "./affected_area_workflow_input.js";
import { handleProofRequest } from "./http.js";
import type { RegisterEnv } from "./register.js";
import { handleRegisterRequest } from "./register.js";

const PUBLISH_STEP_CONFIG: WorkflowStepConfig = {
    retries: {
        limit: 5,
        delay: "10 seconds",
        backoff: "exponential",
    },
    timeout: "5 minutes",
};

function nonRetryableWorkflowError(cause: unknown): Error {
    const message = cause instanceof Error ? cause.message : String(cause);
    const Constructor = globalThis.NonRetryableError;
    return typeof Constructor === "function" ? new Constructor(message) : new Error(message);
}

export class AffectedAreaArtifactWorkflow extends WorkflowEntrypoint<
    AffectedAreaWorkflowEnv,
    AffectedAreaWorkflowInput
> {
    async run(
        event: WorkflowEvent<AffectedAreaWorkflowInput>,
        step: WorkflowStep,
    ): Promise<AffectedAreaWorkflowPublishSummary> {
        let input: AffectedAreaWorkflowInput;
        try {
            input = validateAffectedAreaWorkflowInput(event.payload);
        } catch (cause) {
            throw nonRetryableWorkflowError(cause);
        }

        return step.do("publish affected-area artifacts", PUBLISH_STEP_CONFIG, () =>
            runAffectedAreaArtifactWorkflow(input, this.env),
        );
    }
}

// ---------------------------------------------------------------------------
// Route patterns
// ---------------------------------------------------------------------------

const REGISTER_PATH_PATTERN =
    /^\/events\/([^/]+)\/revisions\/(\d+)\/affected-cells\/?$/;
const PROOF_PATH_PATTERN = /^\/events\/([^/]+)\/revisions\/(\d+)\/proof\/?$/;

// ---------------------------------------------------------------------------
// Worker default export
// ---------------------------------------------------------------------------

/**
 * Worker が受け取る env 型。
 * テスト用に fetchImpl を optional で受け取れるようにする。
 * （本番の Cloudflare Worker では fetchImpl は渡されず、グローバル fetch が使われる）
 */
export type WorkerEnv = RegisterEnv & { fetchImpl?: typeof fetch };

export default {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
        try {
            return await dispatchRequest(request, env);
        } catch (error) {
            return errorResponse(toAffectedCellsProofError(error));
        }
    },
};

// ---------------------------------------------------------------------------
// Internal dispatch
// ---------------------------------------------------------------------------

async function dispatchRequest(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    // テスト用 fetchImpl があれば使い、なければグローバル fetch を使う
    const fetchImpl = env.fetchImpl ?? fetch;

    // POST /events/:event_uid/revisions/:event_revision/affected-cells
    if (REGISTER_PATH_PATTERN.test(pathname)) {
        if (request.method === "POST") {
            return handleRegisterRequest(request, env, fetchImpl);
        }
        throw new AffectedCellsProofError(
            "method_not_allowed",
            `Method ${request.method} is not allowed. Use POST.`,
            405,
        );
    }

    // GET /events/:event_uid/revisions/:event_revision/proof
    if (PROOF_PATH_PATTERN.test(pathname)) {
        if (request.method === "GET") {
            return handleProofRequest(request, env, fetchImpl);
        }
        throw new AffectedCellsProofError(
            "method_not_allowed",
            `Method ${request.method} is not allowed. Use GET.`,
            405,
        );
    }

    // どのルートにもマッチしない
    throw new AffectedCellsProofError(
        "not_found",
        `Not found: ${pathname}`,
        404,
    );
}
