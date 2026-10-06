/**
 * System One workflow (id: system-one) — the ONLY service entry point to the
 * system-one tool. See docs/adr/0009-system-one-tool.md, Decision 7.
 *
 *   POST /v6/ai/workflows/system-one/start-async  { "inputData": <SystemOneRequest> }
 *
 * Every call is a persisted run (input, per-step payload/output/error/timing,
 * result, caller identity) — that run record is the tracking contract.
 *
 * Mastra behaviours this file is built around (ADR 0009 W2–W8):
 *  - an invalid start input would throw before any run is recorded → input is
 *    validated in the first step instead (`validateInputs: false`);
 *  - a tool's input-validation failure is a *returned* `{ error: true }` → the
 *    evaluate step turns it into a thrown error, or the run records success;
 *  - pruneSnapshot fires mid-run on objects shared with the live run → image
 *    redaction works on a deep copy, never in place;
 *  - a reused runId overwrites another caller's record → onStart gate (409).
 */
import { createHash } from 'node:crypto';
import { noopObserve } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { WorkflowRunState, WorkflowStartCallbackInfo } from '@mastra/core/workflows';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { getSystemOneConfig } from '../../../config/system-one.config';
import {
    formatSystemOneIssues,
    resolveSystemOneRequest,
    systemOneProviderRequestSchema,
    SystemOneError,
} from '../../../utils/providers/system-one';
import {
    SYSTEM_ONE_TOOL_DESCRIPTION,
    systemOneInputSchema,
    systemOneOutputSchema,
    systemOneTool,
    type SystemOneOutput,
} from '../../tools/system-one/system-one-tool';

const WORKFLOW_ID = 'system-one';

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Validates and resolves the request. Its output is the RESOLVED request, so
 * the run record shows the effective model, not just what the caller sent.
 */
const validateRequestStep = createStep({
    id: 'validate-request',
    description: 'Validates the System One request and applies server defaults (model, keep_alive, size limits).',
    inputSchema: systemOneInputSchema,
    outputSchema: systemOneProviderRequestSchema,
    execute: async ({ inputData }) => {
        const parsed = systemOneInputSchema.safeParse(inputData);
        if (!parsed.success) {
            throw new SystemOneError(
                400,
                'SYS1_INVALID_INPUT',
                `Invalid System One request: ${formatSystemOneIssues(parsed.error)}`,
            );
        }
        return resolveSystemOneRequest(parsed.data, getSystemOneConfig());
    },
});

/**
 * Re-enters through the tool (not createStep(tool)) so there is one
 * implementation and one access guard, and so a returned validation error
 * fails the step instead of being recorded as its output.
 */
const evaluateStep = createStep({
    id: 'evaluate',
    description: 'Scores the questions with the System One provider.',
    inputSchema: systemOneProviderRequestSchema,
    outputSchema: systemOneOutputSchema,
    execute: async ({
        inputData,
        mastra,
        requestContext,
        abortSignal,
        runId,
        state,
        setState,
    }) => {
        const result: unknown = await systemOneTool.execute!(inputData, {
            mastra,
            requestContext,
            abortSignal,
            observe: noopObserve,
            // The tool never suspends; it only reads runId (for log correlation).
            workflow: { runId, workflowId: WORKFLOW_ID, state, setState, suspend: neverSuspends },
        });

        if (isToolValidationError(result)) {
            throw new SystemOneError(400, 'SYS1_INVALID_INPUT', result.message);
        }
        return result as SystemOneOutput;
    },
});

async function neverSuspends(): Promise<void> {
    throw new Error('[system-one] the system-one tool does not suspend');
}

function isToolValidationError(value: unknown): value is { error: true; message: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { error?: unknown }).error === true
    );
}

// ---------------------------------------------------------------------------
// pruneSnapshot — images are stored as { sha256, bytes }, never as base64
// ---------------------------------------------------------------------------

export interface RedactedImage {
    sha256: string;
    /** Decoded length. */
    bytes: number;
}

function redactImage(image: unknown): unknown {
    if (typeof image !== 'string') return image; // already redacted on an earlier persist
    const decoded = Buffer.from(image, 'base64');
    return {
        sha256: createHash('sha256').update(decoded).digest('hex'),
        bytes: decoded.length,
    } satisfies RedactedImage;
}

/**
 * The `images` field of a System One request object — and ONLY that field:
 * `state` is arbitrary caller JSON and may legitimately contain an `images` key.
 */
function hasRawImages(request: unknown): request is { images: unknown[] } {
    const images = (request as { images?: unknown } | null | undefined)?.images;
    return Array.isArray(images) && images.some((image) => typeof image === 'string');
}

/** context.input, then each step's payload and output. */
function* imageCarriers(snapshot: WorkflowRunState): Generator<unknown> {
    const context = (snapshot?.context ?? {}) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(context)) {
        if (key === 'input') {
            yield entry;
            continue;
        }
        const step = entry as { payload?: unknown; output?: unknown } | null;
        yield step?.payload;
        yield step?.output;
    }
}

/**
 * MUST NOT mutate its argument: the snapshot shares references with the live
 * run, and an in-place rewrite would send hashes to the provider instead of
 * images (ADR 0009 W2, probed). Runs on every persist, so it is idempotent.
 */
export function redactSystemOneImages({
    snapshot,
}: {
    snapshot: WorkflowRunState;
    workflowStatus?: unknown;
}): WorkflowRunState {
    if (![...imageCarriers(snapshot)].some(hasRawImages)) return snapshot;

    const copy = structuredClone(snapshot);
    for (const carrier of imageCarriers(copy)) {
        if (hasRawImages(carrier)) carrier.images = carrier.images.map(redactImage);
    }
    return copy;
}

// ---------------------------------------------------------------------------
// onStart — a supplied runId must not overwrite another caller's record
// ---------------------------------------------------------------------------

interface WorkflowsStore {
    getWorkflowRunById(args: {
        runId: string;
        workflowName?: string;
    }): Promise<{ resourceId?: string | null; snapshot: WorkflowRunState | string } | null>;
}

/**
 * createRun() has already written this caller's fresh `pending` record, so any
 * other state means the id is in use: finished/running (anyone), or pending
 * but owned by someone else.
 *
 * The caller is taken from the request context's verified resourceId, not
 * from `info.resourceId`: Mastra caches Run objects per runId in-process, so
 * a second caller reusing a pending id gets the FIRST caller's Run — and its
 * resourceId — back from createRun().
 *
 * Residual: two concurrent starts with the same brand-new id can both pass.
 */
export async function rejectRunIdReuse(info: WorkflowStartCallbackInfo): Promise<void> {
    const store = (await info.mastra?.getStorage()?.getStore('workflows')) as
        | WorkflowsStore
        | undefined;
    if (!store) return;

    const existing = await store.getWorkflowRunById({
        runId: info.runId,
        workflowName: info.workflowId,
    });
    if (!existing) return;

    const snapshot =
        typeof existing.snapshot === 'string'
            ? (JSON.parse(existing.snapshot) as WorkflowRunState)
            : existing.snapshot;
    const callerResourceId =
        (info.requestContext?.get(MASTRA_RESOURCE_ID_KEY) as string | undefined) ??
        info.resourceId;
    // Storage returns a missing resourceId as NULL (Postgres) while the context
    // has `undefined` — e.g. every run under DISABLE_AUTH=true. Treat both as
    // "no owner", or a caller's own fresh run is rejected as a conflict.
    const ownerResourceId = existing.resourceId ?? undefined;

    if (snapshot?.status !== 'pending' || ownerResourceId !== (callerResourceId ?? undefined)) {
        throw new SystemOneError(
            409,
            'SYS1_RUN_ID_CONFLICT',
            `runId "${info.runId}" is already in use; supply a fresh UUID or omit runId.`,
        );
    }
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const systemOneWorkflow = createWorkflow({
    id: WORKFLOW_ID,
    description: `${SYSTEM_ONE_TOOL_DESCRIPTION} Each call is recorded as a workflow run.`,
    inputSchema: systemOneInputSchema,
    outputSchema: systemOneOutputSchema,
    options: {
        // Validation happens in a recorded step instead (W3).
        validateInputs: false,
        // A crashed synchronous scoring call is not re-driven on boot; its
        // caller already saw the dropped connection, and a redacted snapshot
        // can't be replayed anyway.
        autoRestartActiveRuns: false,
        pruneSnapshot: redactSystemOneImages,
        onStart: rejectRunIdReuse,
    },
})
    .then(validateRequestStep)
    .then(evaluateStep)
    .commit();

export const _testing = { validateRequestStep, evaluateStep };
