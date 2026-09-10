import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MASTRA_AUTH_TOKEN_KEY } from '@mastra/core/request-context';

const { m2mTokenMock, fallbackConfigMock, loggerWarnMock } = vi.hoisted(() => ({
    m2mTokenMock: vi.fn(),
    fallbackConfigMock: {} as Record<string, boolean>,
    loggerWarnMock: vi.fn(),
}));

vi.mock('./auth/m2m.service', () => ({
    M2MService: class MockM2MService {
        getM2MToken = m2mTokenMock;
    },
}));

vi.mock('../config/tool-auth-fallback.config', () => ({
    TOOL_M2M_FALLBACK_CONFIG: fallbackConfigMock,
}));

vi.mock('./logger', () => ({
    tcAILogger: {
        warn: loggerWarnMock,
    },
}));

import { callTcApi } from './tc-api-client';

function requestContextWithToken(token: string | undefined) {
    return {
        get: (key: string) => (key === MASTRA_AUTH_TOKEN_KEY ? token : undefined),
    } as any;
}

function mockFetchResponse(status: number) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: status < 400, status } as Response);
}

beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(fallbackConfigMock)) delete fallbackConfigMock[key];
    m2mTokenMock.mockResolvedValue('fake-m2m-token');
});

describe('callTcApi — requestor token path', () => {
    it('calls fetch with the requestor token and returns the response on success', async () => {
        const fetchSpy = mockFetchResponse(200);

        const response = await callTcApi({
            toolId: 'some-tool',
            url: 'https://api.example.com/v6/thing',
            requestContext: requestContextWithToken('requestor-token'),
        });

        expect(response.status).toBe(200);
        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer requestor-token');
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it('returns the requestor-token 401 as-is when fallback is not configured for the tool', async () => {
        mockFetchResponse(401);

        const response = await callTcApi({
            toolId: 'not-listed-tool',
            url: 'https://api.example.com/v6/thing',
            requestContext: requestContextWithToken('requestor-token'),
        });

        expect(response.status).toBe(401);
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it('returns the requestor-token 403 as-is when fallback is not configured for the tool', async () => {
        mockFetchResponse(403);

        const response = await callTcApi({
            toolId: 'not-listed-tool',
            url: 'https://api.example.com/v6/thing',
            requestContext: requestContextWithToken('requestor-token'),
        });

        expect(response.status).toBe(403);
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it('passes through a non-401/403 error status without attempting fallback', async () => {
        fallbackConfigMock['fallback-tool'] = true;
        mockFetchResponse(500);

        const response = await callTcApi({
            toolId: 'fallback-tool',
            url: 'https://api.example.com/v6/thing',
            requestContext: requestContextWithToken('requestor-token'),
        });

        expect(response.status).toBe(500);
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });
});

describe('callTcApi — M2M fallback path (tool explicitly enabled)', () => {
    it('retries once with the M2M token on a 401 when fallback is enabled', async () => {
        fallbackConfigMock['fallback-tool'] = true;
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
            .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

        const response = await callTcApi({
            toolId: 'fallback-tool',
            url: 'https://api.example.com/v6/thing',
            requestContext: requestContextWithToken('requestor-token'),
        });

        expect(response.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const [, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
        expect((secondInit.headers as Record<string, string>).Authorization).toBe('Bearer fake-m2m-token');
        expect(loggerWarnMock).toHaveBeenCalledWith(
            'Requestor token rejected by Topcoder platform API, falling back to service M2M token',
            { toolId: 'fallback-tool', status: 401 },
        );
    });

    it('retries once with the M2M token on a 403 when fallback is enabled', async () => {
        fallbackConfigMock['fallback-tool'] = true;
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce({ ok: false, status: 403 } as Response)
            .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

        const response = await callTcApi({
            toolId: 'fallback-tool',
            url: 'https://api.example.com/v6/thing',
            requestContext: requestContextWithToken('requestor-token'),
        });

        expect(response.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('propagates the M2M attempt result even if it also fails (no further retries)', async () => {
        fallbackConfigMock['fallback-tool'] = true;
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
            .mockResolvedValueOnce({ ok: false, status: 401 } as Response);

        const response = await callTcApi({
            toolId: 'fallback-tool',
            url: 'https://api.example.com/v6/thing',
            requestContext: requestContextWithToken('requestor-token'),
        });

        expect(response.status).toBe(401);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
});

describe('callTcApi — no requestor token', () => {
    it('goes straight to the M2M token when fallback is enabled', async () => {
        fallbackConfigMock['fallback-tool'] = true;
        const fetchSpy = mockFetchResponse(200);

        const response = await callTcApi({
            toolId: 'fallback-tool',
            url: 'https://api.example.com/v6/thing',
            requestContext: requestContextWithToken(undefined),
        });

        expect(response.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-m2m-token');
    });

    it('fails fast without calling fetch when fallback is not enabled', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await expect(
            callTcApi({
                toolId: 'not-listed-tool',
                url: 'https://api.example.com/v6/thing',
                requestContext: requestContextWithToken(undefined),
            }),
        ).rejects.toThrow(/No requestor token available for tool "not-listed-tool"/);

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it('fails fast when requestContext itself is undefined and fallback is not enabled', async () => {
        await expect(
            callTcApi({
                toolId: 'not-listed-tool',
                url: 'https://api.example.com/v6/thing',
                requestContext: undefined,
            }),
        ).rejects.toThrow(/No requestor token available/);
    });
});

describe('callTcApi — default headers', () => {
    it('sends Content-Type and app-version headers alongside Authorization', async () => {
        const fetchSpy = mockFetchResponse(200);

        await callTcApi({
            toolId: 'some-tool',
            url: 'https://api.example.com/v6/thing',
            init: { method: 'GET' },
            requestContext: requestContextWithToken('requestor-token'),
        });

        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['app-version']).toBe('2.0.0');
        expect(init.method).toBe('GET');
    });
});
