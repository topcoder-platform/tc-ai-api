import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve } from '@mastra/core/tools';
import { _resetSystemOneConfigCache } from '../../../config/system-one.config';
import { _resetAccessPolicyCache, ToolAccessDeniedError } from '../../../utils/auth/access-control';
import { _resetSystemOneProviderCache, SystemOneError } from '../../../utils/providers/system-one';
import { executeSystemOne, systemOneTool } from './system-one-tool';

const mocks = vi.hoisted(() => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../utils/logger', () => ({ tcAILogger: mocks.logger }));

const ROLES_CLAIM = 'https://topcoder.com/roles';
const USERID_CLAIM = 'https://topcoder.com/userId';
const ENV_KEYS = ['OLLAMA_API_URL', 'SYS1_OLLAMA_BASE_URL', 'SYS1_MODEL', 'SYS1_ALLOWED_MODELS', 'SYS1_KEEP_ALIVE', 'DISABLE_AUTH', 'TC_API_BASE'];

const SECRET_STATE = 'member 88774433 says: I was charged twice';
const input = {
    state: SECRET_STATE,
    questions: { refund: { type: 'noul' as const, instructions: 'Is a refund requested?' } },
};
const upstream = {
    model: 'nimble',
    answers: { refund: { type: 'noul', noul: 0.9989 } },
    usage: { input_tokens: 42, output_tokens: 2 },
};

function contextFor(user: Record<string, unknown> | undefined) {
    const requestContext = new RequestContext();
    if (user) requestContext.set('user', user);
    return { requestContext, observe: noopObserve };
}

const admin = { sub: 'auth0|1', [USERID_CLAIM]: '1', [ROLES_CLAIM]: ['administrator'] };
const copilot = { sub: 'auth0|2', [USERID_CLAIM]: '2', [ROLES_CLAIM]: ['copilot'] };
const sys1Service = { sub: 'svc@clients', scope: 'read:challenges sys1:use' };
const otherService = { sub: 'svc@clients', scope: 'read:challenges' };

const fetchMock = vi.fn<typeof fetch>();
let saved: Record<string, string | undefined>;

beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    for (const k of Object.keys(process.env)) if (k.startsWith('ACCESS_POLICY_')) delete process.env[k];
    process.env.OLLAMA_API_URL = 'http://ollama.test:11434';
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

describe('system-one tool — output', () => {
    it('returns the upstream response verbatim plus `provider`', async () => {
        await expect(systemOneTool.execute!(input, contextFor(admin))).resolves.toEqual({
            provider: 'ollama',
            ...upstream,
        });
    });

    it('sends the resolved model and the server keep_alive, never the caller one', async () => {
        process.env.SYS1_KEEP_ALIVE = '300';
        _resetSystemOneConfigCache();

        await systemOneTool.execute!({ ...input, keep_alive: -1 } as typeof input, contextFor(admin));

        const sent = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
        expect(sent).toMatchObject({ model: 'nimble', keep_alive: 300 });
    });
});

describe('system-one tool — access (administrator / sys1:use)', () => {
    it.each([
        ['administrator member', admin],
        ['M2M with sys1:use', sys1Service],
    ])('allows a %s', async (_, user) => {
        await expect(systemOneTool.execute!(input, contextFor(user))).resolves.toMatchObject({
            provider: 'ollama',
        });
    });

    it.each([
        ['member without administrator', copilot],
        ['M2M without sys1:use', otherService],
        ['missing user', undefined],
    ])('denies a %s with a 403 before calling the provider', async (_, user) => {
        const error = await systemOneTool.execute!(input, contextFor(user)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ToolAccessDeniedError);
        expect(error).toMatchObject({ status: 403 });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not reveal schema details to a denied caller', async () => {
        const error = await systemOneTool.execute!({} as typeof input, contextFor(copilot)).catch(
            (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(ToolAccessDeniedError);
    });
});

describe('system-one tool — errors', () => {
    it('returns Mastra validation errors as a value (ADR 0009 F3)', async () => {
        const result = await systemOneTool.execute!(
            { state: 'x', questions: {} } as typeof input,
            contextFor(admin),
        );
        expect(result).toMatchObject({ error: true });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('propagates a SystemOneError with its status intact', async () => {
        fetchMock.mockImplementationOnce(async () => new Response('{"error":"nope"}', { status: 404 }));
        const error = await systemOneTool.execute!(input, contextFor(admin)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SystemOneError);
        expect(error).toMatchObject({ status: 503, code: 'SYS1_MODEL_UNAVAILABLE' });
    });

    it('rejects a model outside the allowlist with 400', async () => {
        const error = await systemOneTool.execute!({ ...input, model: 'llama3' }, contextFor(admin)).catch(
            (e: unknown) => e,
        );
        expect(error).toMatchObject({ status: 400, code: 'SYS1_MODEL_NOT_ALLOWED' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails with 503 SYS1_NOT_CONFIGURED when no Ollama URL is set', async () => {
        delete process.env.OLLAMA_API_URL;
        _resetSystemOneConfigCache();
        const error = await systemOneTool.execute!(input, contextFor(admin)).catch((e: unknown) => e);
        expect(error).toMatchObject({ status: 503, code: 'SYS1_NOT_CONFIGURED' });
    });
});

describe('executeSystemOne — logging', () => {
    it('logs metadata with the runId and never the content', async () => {
        await executeSystemOne(input, { runId: 'run-1' });
        expect(mocks.logger.info).toHaveBeenCalledWith(
            'system-one: evaluated',
            expect.objectContaining({
                runId: 'run-1',
                provider: 'ollama',
                model: 'nimble',
                questionCount: 1,
                hasImages: false,
                usage: upstream.usage,
                latencyMs: expect.any(Number),
            }),
        );
        expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain(SECRET_STATE);
        expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain('Is a refund requested');
    });

    it('logs a failure with its code, without content', async () => {
        fetchMock.mockImplementationOnce(async () => new Response('{"error":"bad"}', { status: 400 }));
        await expect(executeSystemOne(input)).rejects.toThrow(SystemOneError);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            'system-one: failed',
            expect.objectContaining({ status: 400, code: 'SYS1_INVALID_REQUEST' }),
        );
        expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(SECRET_STATE);
    });
});
