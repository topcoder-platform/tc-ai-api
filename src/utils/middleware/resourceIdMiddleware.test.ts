import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';

const { authenticateTokenMock, loggerErrorMock } = vi.hoisted(() => ({
    authenticateTokenMock: vi.fn(),
    loggerErrorMock: vi.fn(),
}));

vi.mock('../auth', () => ({
    apiAuthLayer: {
        authenticateToken: authenticateTokenMock,
    },
}));

vi.mock('../logger', () => ({
    tcAILogger: {
        error: loggerErrorMock,
    },
}));

import { resourceIdMiddleware } from './resourceIdMiddleware';

function createContext(options?: {
    user?: Record<string, unknown>;
    authHeader?: string;
    apiKey?: string;
}) {
    const requestContext = new Map<string, unknown>();
    if (options?.user) {
        requestContext.set('user', options.user);
    }

    const json = vi.fn((payload: unknown, status: number) => ({ payload, status }));

    const c = {
        get: vi.fn((key: string) => {
            if (key === 'requestContext') {
                return requestContext;
            }
            return undefined;
        }),
        req: {
            header: vi.fn((name: string) => {
                if (name.toLowerCase() === 'authorization') {
                    return options?.authHeader || '';
                }
                return '';
            }),
            query: vi.fn((name: string) => {
                if (name === 'apiKey') {
                    return options?.apiKey || '';
                }
                return '';
            }),
            raw: {} as Request,
        },
        json,
    };

    return { c, json, requestContext };
}

describe('resourceIdMiddleware', () => {
    const originalTcApiBase = process.env.TC_API_BASE;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.TC_API_BASE = 'https://api.topcoder-dev.com';
    });

    afterEach(() => {
        process.env.TC_API_BASE = originalTcApiBase;
    });

    it('sets resource id from existing user in request context', async () => {
        const user = {
            'https://topcoder-dev.com/userId': '12345',
            sub: 'sub-1',
        };
        const { c, requestContext, json } = createContext({ user });
        const next = vi.fn(async () => undefined);

        await resourceIdMiddleware.handler(c, next);

        expect(requestContext.get(MASTRA_RESOURCE_ID_KEY)).toBe('12345');
        expect(next).toHaveBeenCalledOnce();
        expect(json).not.toHaveBeenCalled();
        expect(authenticateTokenMock).not.toHaveBeenCalled();
    });

    it('hydrates user from bearer token when request context user is missing', async () => {
        const user = {
            'https://topcoder-dev.com/userId': '777',
            sub: 'sub-777',
        };
        authenticateTokenMock.mockResolvedValueOnce(user);

        const { c, requestContext, json } = createContext({
            authHeader: 'Bearer valid-token',
        });
        const next = vi.fn(async () => undefined);

        await resourceIdMiddleware.handler(c, next);

        expect(authenticateTokenMock).toHaveBeenCalledWith('valid-token', c.req.raw);
        expect(requestContext.get('user')).toEqual(user);
        expect(requestContext.get(MASTRA_RESOURCE_ID_KEY)).toBe('777');
        expect(next).toHaveBeenCalledOnce();
        expect(json).not.toHaveBeenCalled();
    });

    it('hydrates user from apiKey query token when bearer token is absent', async () => {
        const user = {
            sub: 'm2m-subject',
        };
        authenticateTokenMock.mockResolvedValueOnce(user);

        const { c, requestContext, json } = createContext({ apiKey: 'query-token' });
        const next = vi.fn(async () => undefined);

        await resourceIdMiddleware.handler(c, next);

        expect(authenticateTokenMock).toHaveBeenCalledWith('query-token', c.req.raw);
        expect(requestContext.get(MASTRA_RESOURCE_ID_KEY)).toBe('m2m-subject');
        expect(next).toHaveBeenCalledOnce();
        expect(json).not.toHaveBeenCalled();
    });

    it('returns 401 when user cannot be resolved', async () => {
        authenticateTokenMock.mockResolvedValueOnce(null);

        const { c, json } = createContext({ authHeader: 'Bearer invalid-token' });
        const next = vi.fn(async () => undefined);

        const result = await resourceIdMiddleware.handler(c, next);

        expect(result).toEqual({ payload: { error: 'Unauthorized' }, status: 401 });
        expect(next).not.toHaveBeenCalled();
        expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401);
        expect(loggerErrorMock).toHaveBeenCalledWith('User object missing in context!');
    });

    it('returns 401 when user has neither userId claim nor sub', async () => {
        const user = { email: 'no-id@example.com' };
        const { c, json } = createContext({ user });
        const next = vi.fn(async () => undefined);

        const result = await resourceIdMiddleware.handler(c, next);

        expect(result).toEqual({
            payload: { error: 'Failed to extract userId/sub from user object' },
            status: 401,
        });
        expect(next).not.toHaveBeenCalled();
        expect(json).toHaveBeenCalledWith({ error: 'Failed to extract userId/sub from user object' }, 401);
    });
});
