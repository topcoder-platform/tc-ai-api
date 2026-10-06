/**
 * The system-one workflow on a real Mastra engine with in-memory LibSQL
 * storage (as in the ADR 0009 probes), so the persisted run record — the
 * tracking contract — is what gets asserted. Only `fetch` is faked.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from '@mastra/core/request-context';
import type { WorkflowRunState } from '@mastra/core/workflows';
import { _resetSystemOneConfigCache } from '../../../config/system-one.config';
import { _resetAccessPolicyCache } from '../../../utils/auth/access-control';
import { _resetSystemOneProviderCache } from '../../../utils/providers/system-one';
import { systemOneTool } from '../../tools/system-one/system-one-tool';
import { redactSystemOneImages, rejectRunIdReuse, systemOneWorkflow } from './system-one-workflow';

vi.mock('../../../utils/logger', () => ({
    tcAILogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ROLES_CLAIM = 'https://topcoder.com/roles';
const USERID_CLAIM = 'https://topcoder.com/userId';
const ENV_KEYS = ['OLLAMA_API_URL', 'SYS1_OLLAMA_BASE_URL', 'SYS1_MODEL', 'SYS1_ALLOWED_MODELS', 'DISABLE_AUTH', 'TC_API_BASE'];

// 1x1 PNG
const IMAGE_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

const input = {
    state: { ticket: 'I was charged twice. Please refund the extra payment.' },
    questions: {
        refund: { type: 'noul', instructions: 'Is the customer requesting a refund?' },
        label: {
            type: 'choice',
            instructions: 'Which queue owns this ticket?',
            criteria: { billing: 'Payments and refunds', bug: 'Software errors', other: null },
        },
    },
};

const upstream = {
    model: 'nimble',
    answers: {
        refund: { type: 'noul', noul: 0.9989 },
        label: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.97, bug: 0.02, other: 0.01 },
            confidence: 0.83,
        },
    },
    usage: { input_tokens: 120, output_tokens: 3 },
};

interface Caller {
    resourceId: string;
    user: Record<string, unknown>;
}

const adminA: Caller = {
    resourceId: '1001',
    user: { sub: 'auth0|1001', [USERID_CLAIM]: '1001', [ROLES_CLAIM]: ['administrator'] },
};
const adminB: Caller = {
    resourceId: '1002',
    user: { sub: 'auth0|1002', [USERID_CLAIM]: '1002', [ROLES_CLAIM]: ['administrator'] },
};
const copilot: Caller = {
    resourceId: '1003',
    user: { sub: 'auth0|1003', [USERID_CLAIM]: '1003', [ROLES_CLAIM]: ['copilot'] },
};

/** What the HTTP layer puts on the context: the verified user and resourceId. */
function contextFor(caller: Caller): RequestContext {
    const requestContext = new RequestContext();
    requestContext.set('user', caller.user);
    requestContext.set(MASTRA_RESOURCE_ID_KEY, caller.resourceId);
    return requestContext;
}

let mastra: Mastra;
const fetchMock = vi.fn<typeof fetch>();
let saved: Record<string, string | undefined>;

beforeAll(() => {
    mastra = new Mastra({
        workflows: { systemOneWorkflow },
        storage: new LibSQLStore({ id: 'system-one-workflow-test', url: ':memory:' }),
        logger: false,
    });
});

afterAll(async () => {
    await mastra.shutdown?.();
});

beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OLLAMA_API_URL = 'http://ollama.test:11434';
    process.env.SYS1_ALLOWED_MODELS = 'clef-flash';
    _resetSystemOneConfigCache();
    _resetSystemOneProviderCache();
    _resetAccessPolicyCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(upstream), { status: 200 }));
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    _resetSystemOneConfigCache();
    _resetSystemOneProviderCache();
    _resetAccessPolicyCache();
});

async function start(caller: Caller, inputData: unknown, runId = randomUUID()) {
    const run = await mastra
        .getWorkflow('systemOneWorkflow')
        .createRun({ runId, resourceId: caller.resourceId });
    const result = await run.start({ inputData: inputData as never, requestContext: contextFor(caller) });
    return { runId, result };
}

async function storedRun(runId: string) {
    const store = await mastra.getStorage()!.getStore('workflows');
    const row = await store!.getWorkflowRunById({ runId, workflowName: 'system-one' });
    if (!row) return null;
    const snapshot = (
        typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot
    ) as WorkflowRunState;
    return { resourceId: row.resourceId, snapshot };
}

function errorOf(result: unknown): { message: string; status?: number } {
    return (result as { error: { message: string; status?: number } }).error;
}

// ---------------------------------------------------------------------------
// Outcomes and the run record
// ---------------------------------------------------------------------------

describe('system-one workflow — outcomes', () => {
    it('succeeds and records input, resolved request, result and caller', async () => {
        const { runId, result } = await start(adminA, input);

        expect(result.status).toBe('success');
        expect((result as { result: unknown }).result).toEqual({ provider: 'ollama', ...upstream });

        const stored = await storedRun(runId);
        expect(stored?.resourceId).toBe(adminA.resourceId);
        expect(stored?.snapshot.status).toBe('success');
        expect(stored?.snapshot.context.input).toEqual(input);
        // The validate step records the EFFECTIVE model, not just what was sent.
        expect((stored?.snapshot.context['validate-request'] as { output: unknown }).output).toMatchObject({
            model: 'nimble',
        });
        expect(stored?.snapshot.result).toEqual({ provider: 'ollama', ...upstream });
    });

    it('records invalid input as a failed run (SYS1_INVALID_INPUT), not an HTTP 500', async () => {
        const { runId, result } = await start(adminA, {
            state: 'x',
            questions: { label: { type: 'choice', instructions: 'x', criteria: { only: null } } },
        });

        expect(result.status).toBe('failed');
        expect(errorOf(result).message).toMatch(
            /^\[SYS1_INVALID_INPUT\] .*questions\.label\.criteria: must have 2–26 options/,
        );
        expect(errorOf(result).status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();

        const stored = await storedRun(runId);
        expect(stored?.snapshot.status).toBe('failed');
        expect((stored?.snapshot.context['validate-request'] as { status: string }).status).toBe('failed');
    });

    it('records a model outside the allowlist as a failed validate step', async () => {
        const { result } = await start(adminA, { ...input, model: 'llama3' });
        expect(result.status).toBe('failed');
        expect(errorOf(result)).toMatchObject({ status: 400 });
        expect(errorOf(result).message).toMatch(/^\[SYS1_MODEL_NOT_ALLOWED\]/);
    });

    it('records a provider failure as a failed evaluate step with its status', async () => {
        fetchMock.mockImplementationOnce(
            async () => new Response('{"error":"model not found"}', { status: 404 }),
        );
        const { runId, result } = await start(adminA, input);

        expect(result.status).toBe('failed');
        expect(errorOf(result)).toMatchObject({ status: 503 });
        expect(errorOf(result).message).toMatch(/^\[SYS1_MODEL_UNAVAILABLE\]/);

        const stored = await storedRun(runId);
        expect((stored?.snapshot.context['validate-request'] as { status: string }).status).toBe('success');
        expect((stored?.snapshot.context.evaluate as { status: string }).status).toBe('failed');
    });

    it('fails (not succeeds) when the tool returns a validation error value', async () => {
        vi.spyOn(systemOneTool, 'execute').mockResolvedValueOnce({
            error: true,
            message: 'Tool input validation failed',
        } as never);
        const { result } = await start(adminA, input);

        expect(result.status).toBe('failed');
        expect(errorOf(result).message).toBe('[SYS1_INVALID_INPUT] Tool input validation failed');
    });

    it('records an access denial inside evaluate (tool policy) as a failed run', async () => {
        const { result } = await start(copilot, input);
        expect(result.status).toBe('failed');
        expect(errorOf(result).message).toMatch(/Access denied for tool "system-one"/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Images — the provider gets base64, the record only hashes
// ---------------------------------------------------------------------------

describe('system-one workflow — image redaction', () => {
    it('sends the original base64 to the provider but stores only { sha256, bytes }', async () => {
        const { runId, result } = await start(adminA, {
            ...input,
            model: 'clef-flash',
            images: [IMAGE_B64],
        });
        expect(result.status).toBe('success');

        const sent = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
        expect(sent.images).toEqual([IMAGE_B64]);

        const stored = await storedRun(runId);
        expect(JSON.stringify(stored)).not.toContain(IMAGE_B64);

        const decoded = Buffer.from(IMAGE_B64, 'base64');
        const expectedImage = { sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: decoded.length };
        const context = stored!.snapshot.context as Record<string, any>;
        expect(context.input.images).toEqual([expectedImage]);
        expect(context['validate-request'].payload.images).toEqual([expectedImage]);
        expect(context['validate-request'].output.images).toEqual([expectedImage]);
        expect(context.evaluate.payload.images).toEqual([expectedImage]);
    });

    it('never mutates its argument, is idempotent, and leaves `state` alone', () => {
        const snapshot = {
            status: 'running',
            context: {
                input: { state: { images: ['keep-me'] }, images: [IMAGE_B64] },
                'validate-request': { status: 'success', payload: { images: [IMAGE_B64] }, output: { images: [IMAGE_B64] } },
            },
        } as unknown as WorkflowRunState;
        const before = structuredClone(snapshot);

        const once = redactSystemOneImages({ snapshot });
        expect(snapshot).toEqual(before);
        expect(once).not.toBe(snapshot);

        const context = once.context as Record<string, any>;
        expect(context.input.images[0]).toMatchObject({ bytes: expect.any(Number) });
        expect(context.input.state).toEqual({ images: ['keep-me'] });
        expect(context['validate-request'].output.images[0]).toHaveProperty('sha256');

        const twice = redactSystemOneImages({ snapshot: once });
        expect(twice).toBe(once);
    });

    it('returns a snapshot without images as-is', () => {
        const snapshot = { status: 'pending', context: {} } as unknown as WorkflowRunState;
        expect(redactSystemOneImages({ snapshot })).toBe(snapshot);
    });
});

// ---------------------------------------------------------------------------
// runId reuse — a second caller must not overwrite the first caller's record
// ---------------------------------------------------------------------------

describe('system-one workflow — runId reuse gate', () => {
    it('rejects reuse of a finished run id with 409 and leaves the first record intact', async () => {
        const { runId } = await start(adminA, input);
        const before = await storedRun(runId);

        const error = await start(adminB, { ...input, state: 'B input' }, runId).catch((e: unknown) => e);
        expect(error).toMatchObject({ status: 409, code: 'SYS1_RUN_ID_CONFLICT' });

        const after = await storedRun(runId);
        expect(after?.resourceId).toBe(adminA.resourceId);
        expect(after?.snapshot.context.input).toEqual(input);
        expect(after?.snapshot.result).toEqual(before?.snapshot.result);
    });

    it('rejects the same caller re-starting a finished run id too', async () => {
        const { runId } = await start(adminA, input);
        await expect(start(adminA, input, runId)).rejects.toMatchObject({ status: 409 });
    });

    it("rejects another caller starting a run id that is still pending (someone else's create-run)", async () => {
        const runId = randomUUID();
        const workflow = mastra.getWorkflow('systemOneWorkflow');
        const runA = await workflow.createRun({ runId, resourceId: adminA.resourceId });

        // Mastra hands B the cached Run created for A — with A's resourceId —
        // so only the verified caller on the request context can tell them apart.
        const runB = await workflow.createRun({ runId, resourceId: adminB.resourceId });
        await expect(
            runB.start({ inputData: input as never, requestContext: contextFor(adminB) }),
        ).rejects.toMatchObject({ status: 409, code: 'SYS1_RUN_ID_CONFLICT' });
        expect(fetchMock).not.toHaveBeenCalled();

        const result = await runA.start({ inputData: input as never, requestContext: contextFor(adminA) });
        expect(result.status).toBe('success');
        expect((await storedRun(runId))?.resourceId).toBe(adminA.resourceId);
    });

    it('lets a caller start their own pending run (create-run then start)', async () => {
        const runId = randomUUID();
        await mastra.getWorkflow('systemOneWorkflow').createRun({ runId, resourceId: adminA.resourceId });
        const { result } = await start(adminA, input, runId);
        expect(result.status).toBe('success');
    });

    it('lets an unowned run start under DISABLE_AUTH (create-run then start, no resourceId)', async () => {
        // Regression: Postgres returns a missing resourceId as NULL while the
        // context has none, and `null !== undefined` rejected every run as 409.
        process.env.DISABLE_AUTH = 'true';
        const runId = randomUUID();
        const workflow = mastra.getWorkflow('systemOneWorkflow');
        await workflow.createRun({ runId });

        const run = await workflow.createRun({ runId });
        const result = await run.start({ inputData: input as never, requestContext: new RequestContext() });
        expect(result.status).toBe('success');
    });
});

describe('rejectRunIdReuse — storage shapes', () => {
    function infoWith(row: { resourceId?: string | null; status: string } | null, callerResourceId?: string) {
        const requestContext = new RequestContext();
        if (callerResourceId) requestContext.set(MASTRA_RESOURCE_ID_KEY, callerResourceId);
        const store = {
            getWorkflowRunById: vi.fn(async () =>
                row
                    ? { resourceId: row.resourceId, snapshot: JSON.stringify({ status: row.status }) }
                    : null,
            ),
        };
        return {
            runId: 'run-1',
            workflowId: 'system-one',
            requestContext,
            mastra: { getStorage: () => ({ getStore: async () => store }) },
            getInitData: () => ({}),
            state: {},
        } as never;
    }

    it('treats a NULL stored resourceId as "no owner" (Postgres, DISABLE_AUTH)', async () => {
        await expect(rejectRunIdReuse(infoWith({ resourceId: null, status: 'pending' }))).resolves.toBeUndefined();
    });

    it('still rejects an unowned pending run claimed by an authenticated caller', async () => {
        await expect(
            rejectRunIdReuse(infoWith({ resourceId: null, status: 'pending' }, '1002')),
        ).rejects.toMatchObject({ status: 409 });
    });

    it('still rejects a finished unowned run', async () => {
        await expect(
            rejectRunIdReuse(infoWith({ resourceId: null, status: 'success' })),
        ).rejects.toMatchObject({ status: 409 });
    });

    it('allows a run id that is not stored yet', async () => {
        await expect(rejectRunIdReuse(infoWith(null))).resolves.toBeUndefined();
    });
});
