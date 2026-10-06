import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetSystemOneConfigCache } from '../../../config/system-one.config';
import { _resetSystemOneProviderCache, getSystemOneProvider } from './index';
import { OllamaSystemOneProvider } from './ollama';
import { SystemOneError } from './provider';
import type { SystemOneProviderRequest } from './types';

const BASE_URL = 'http://ollama.test:11434';

const req: SystemOneProviderRequest = {
    model: 'nimble',
    state: 'I was charged twice.',
    questions: { refund: { type: 'noul', instructions: 'Is a refund requested?' } },
    keep_alive: '5m',
};

const okBody = {
    model: 'nimble',
    answers: { refund: { type: 'noul', noul: 0.9989 } },
    usage: { input_tokens: 42, output_tokens: 2 },
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function provider(timeoutMs = 1000) {
    return new OllamaSystemOneProvider({ baseUrl: BASE_URL, timeoutMs });
}

async function expectSystemOneError(
    promise: Promise<unknown>,
    status: number,
    code: string,
    message?: RegExp,
) {
    const error = await promise.then(
        () => expect.unreachable('expected a SystemOneError'),
        (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SystemOneError);
    expect(error).toMatchObject({ status, code });
    expect((error as Error).message.startsWith(`[${code}] `)).toBe(true);
    if (message) expect((error as Error).message).toMatch(message);
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
});

describe('OllamaSystemOneProvider — request', () => {
    it('POSTs the request verbatim to /v1/systemone and returns the parsed response', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(okBody));

        await expect(provider().evaluate(req, {})).resolves.toEqual(okBody);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${BASE_URL}/v1/systemone`);
        expect(init?.method).toBe('POST');
        expect(JSON.parse(init?.body as string)).toEqual(req);
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
});

describe('OllamaSystemOneProvider — error mapping (ADR 0009 Decision 5)', () => {
    it('maps upstream 400 to 400 SYS1_INVALID_REQUEST with the upstream text', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'prompt exceeds context' }, 400));
        await expectSystemOneError(
            provider().evaluate(req, {}),
            400,
            'SYS1_INVALID_REQUEST',
            /prompt exceeds context$/,
        );
    });

    it('maps upstream 404 to 503 SYS1_MODEL_UNAVAILABLE, keeping the upstream text', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'model "nimble" not found' }, 404));
        await expectSystemOneError(
            provider().evaluate(req, {}),
            503,
            'SYS1_MODEL_UNAVAILABLE',
            /model "nimble" not found/,
        );
    });

    it('keeps a non-JSON 404 body (e.g. an Ollama without /v1/systemone)', async () => {
        fetchMock.mockResolvedValueOnce(new Response('404 page not found', { status: 404 }));
        await expectSystemOneError(
            provider().evaluate(req, {}),
            503,
            'SYS1_MODEL_UNAVAILABLE',
            /404 page not found/,
        );
    });

    it('maps upstream 413 to 413 SYS1_REQUEST_TOO_LARGE', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'request too large' }, 413));
        await expectSystemOneError(provider().evaluate(req, {}), 413, 'SYS1_REQUEST_TOO_LARGE');
    });

    it.each([500, 502, 401])('maps upstream %i to 502 SYS1_UPSTREAM_ERROR', async (status) => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, status));
        await expectSystemOneError(
            provider().evaluate(req, {}),
            502,
            'SYS1_UPSTREAM_ERROR',
            new RegExp(`returned ${status}: boom`),
        );
    });

    it('maps a response that fails the contract to 502 SYS1_UPSTREAM_ERROR', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ model: 'nimble', answers: {} }));
        await expectSystemOneError(
            provider().evaluate(req, {}),
            502,
            'SYS1_UPSTREAM_ERROR',
            /does not match the contract: usage/,
        );
    });

    it('maps a non-JSON success body to 502 SYS1_UPSTREAM_ERROR', async () => {
        fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
        await expectSystemOneError(provider().evaluate(req, {}), 502, 'SYS1_UPSTREAM_ERROR', /non-JSON/);
    });

    it('maps a network error to 503 SYS1_PROVIDER_UNAVAILABLE', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
        await expectSystemOneError(
            provider().evaluate(req, {}),
            503,
            'SYS1_PROVIDER_UNAVAILABLE',
            /fetch failed/,
        );
    });

    it('maps a timeout to 504 SYS1_TIMEOUT', async () => {
        fetchMock.mockImplementationOnce(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
                }),
        );
        await expectSystemOneError(
            provider(20).evaluate(req, {}),
            504,
            'SYS1_TIMEOUT',
            /did not respond within 20 ms/,
        );
    });

    it('rethrows a caller abort as-is instead of mapping it to a timeout', async () => {
        const controller = new AbortController();
        fetchMock.mockImplementationOnce(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
                }),
        );
        const pending = provider(5000).evaluate(req, { signal: controller.signal });
        controller.abort(new Error('run cancelled'));

        const error = await pending.catch((e: unknown) => e);
        expect(error).not.toBeInstanceOf(SystemOneError);
        expect((error as Error).message).toBe('run cancelled');
    });
});

describe('getSystemOneProvider', () => {
    const KEYS = ['SYS1_PROVIDER', 'SYS1_OLLAMA_BASE_URL', 'OLLAMA_API_URL'];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
        for (const k of KEYS) delete process.env[k];
        _resetSystemOneConfigCache();
        _resetSystemOneProviderCache();
    });

    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        _resetSystemOneConfigCache();
        _resetSystemOneProviderCache();
    });

    it('throws 503 SYS1_NOT_CONFIGURED when no Ollama base URL is set', () => {
        expect(() => getSystemOneProvider()).toThrow(
            expect.objectContaining({ status: 503, code: 'SYS1_NOT_CONFIGURED' }),
        );
    });

    it('throws 503 SYS1_NOT_CONFIGURED for an unsupported provider', () => {
        process.env.SYS1_PROVIDER = 'openai';
        process.env.OLLAMA_API_URL = BASE_URL;
        expect(() => getSystemOneProvider()).toThrow(/Unsupported SYS1_PROVIDER="openai"/);
    });

    it('returns a memoised Ollama provider on the configured base URL', async () => {
        process.env.OLLAMA_API_URL = `${BASE_URL}/`;
        const first = getSystemOneProvider();
        expect(first.name).toBe('ollama');
        expect(getSystemOneProvider()).toBe(first);

        fetchMock.mockResolvedValueOnce(jsonResponse(okBody));
        await first.evaluate(req, {});
        expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/v1/systemone`);
    });
});
