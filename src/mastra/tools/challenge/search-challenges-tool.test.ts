import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MASTRA_AUTH_TOKEN_KEY } from '@mastra/core/request-context';

// The tool no longer instantiates M2MService directly — the shared
// tc-api-client does, only on the (untested-here) M2M fallback path. Mocked
// so importing the client module doesn't construct a real M2M auth client.
const { m2mTokenMock } = vi.hoisted(() => ({
    m2mTokenMock: vi.fn(),
}));

vi.mock('../../../utils/auth/m2m.service', () => ({
    M2MService: class MockM2MService {
        getM2MToken = m2mTokenMock;
    },
}));

import { searchChallengesTool } from './search-challenges-tool';

// Minimal context — the tool uses context.mastra?.getLogger?.() (optional)
// and context.requestContext (to read the requestor's token).
const minimalContext = {
    mastra: undefined,
    requestContext: {
        get: (key: string) =>
            key === MASTRA_AUTH_TOKEN_KEY
                ? 'fake-requestor-token'
                : key === 'user'
                    ? { sub: 'test-user' }
                    : undefined,
    },
} as any;

/**
 * Installs a global fetch spy that resolves with the given JSON body.
 * Returns the spy so tests can assert call arguments (URL, headers).
 */
function mockFetchResponse(data: unknown) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => data,
    } as Response);
}

/**
 * Installs a global fetch spy that resolves with a non-2xx status.
 */
function mockFetchError(status: number) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status,
        json: async () => ({}),
    } as Response);
}

/**
 * Base challenge object returned by the v6 challenges API.
 * Override individual fields via `overrides`.
 */
function baseChallenge(overrides: Record<string, unknown> = {}) {
    return {
        id: 'challenge-1',
        name: 'Test Challenge',
        description: 'A test description',
        privateDescription: 'secret private info',
        descriptionFormat: 'markdown',
        status: 'ACTIVE',
        track: 'Development',
        type: 'Challenge',
        tags: ['tag1', 'tag2'],
        skills: [{ id: 's1', name: 'React' }],
        projectId: 12345,
        groups: ['acme'],
        ...overrides,
    };
}

/**
 * Calls the tool's execute and returns the result cast to any.
 */
async function executeTool(input: Record<string, unknown>): Promise<any> {
    return searchChallengesTool.execute?.(
        input,
        minimalContext,
    ) as Promise<any>;
}

// ---------------------------------------------------------------------------
// VAL-INGEST-045: issues M2M GET /v6/challenges with filters
// ---------------------------------------------------------------------------

describe('searchChallengesTool — request construction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('issues GET /v6/challenges with supplied filter query parameters', async () => {
        const fetchMock = mockFetchResponse([]);

        await executeTool({
            projectId: '123',
            status: ['ACTIVE'],
            types: ['Challenge'],
            tracks: ['Development'],
            tags: ['react'],
            groups: ['acme'],
            page: 1,
            perPage: 10,
            sortBy: 'updated',
            sortOrder: 'asc',
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, any];
        expect(url).toContain('/v6/challenges');
        expect(url).toContain('projectId=123');
        expect(url).toContain('status=ACTIVE');
        expect(url).toContain('types%5B%5D=Challenge');
        expect(url).toContain('tracks%5B%5D=Development');
        expect(url).toContain('tags%5B%5D=react');
        expect(url).toContain('groups%5B%5D=acme');
        expect(url).toContain('page=1');
        expect(url).toContain('perPage=10');
        expect(url).toContain('sortBy=updated');
        expect(url).toContain('sortOrder=asc');
        expect(init.method).toBe('GET');
    });

    it('sends types, tracks, tags and groups as bracketed array params', async () => {
        const fetchMock = mockFetchResponse([]);

        await executeTool({
            types: ['Challenge', 'Task'],
            tracks: ['Development', 'Design'],
            tags: ['react', 'node'],
            groups: ['acme', 'globex'],
        });

        // The v6 API rejects comma-joined and bare single array criteria with
        // HTTP 400 ("must be an array"); only key[]=... is accepted.
        const [url] = fetchMock.mock.calls[0] as [string, any];
        const query = decodeURIComponent(url.split('?')[1]);
        expect(query).toContain('types[]=Challenge&types[]=Task');
        expect(query).toContain('tracks[]=Development&tracks[]=Design');
        expect(query).toContain('tags[]=react&tags[]=node');
        expect(query).toContain('groups[]=acme&groups[]=globex');
        expect(query).not.toContain('types=Challenge,Task');
    });

    it('includes Authorization bearer token from the requestor', async () => {
        const fetchMock = mockFetchResponse([]);

        await executeTool({});

        const [, init] = fetchMock.mock.calls[0] as [string, any];
        expect(init.headers.Authorization).toBe('Bearer fake-requestor-token');
    });

    it('forwards projectIds as comma-separated query parameter', async () => {
        const fetchMock = mockFetchResponse([]);

        await executeTool({ projectIds: ['111', '222', '333'] });

        const [url] = fetchMock.mock.calls[0] as [string, any];
        expect(url).toContain('projectIds=111%2C222%2C333');
    });

    it('forwards approvalStatus filter', async () => {
        const fetchMock = mockFetchResponse([]);

        await executeTool({ approvalStatus: ['APPROVED', 'PENDING'] });

        const [url] = fetchMock.mock.calls[0] as [string, any];
        expect(url).toContain('approvalStatus=APPROVED%2CPENDING');
    });

    it('forwards updatedDateStart and updatedDateEnd filters', async () => {
        const fetchMock = mockFetchResponse([]);

        await executeTool({
            updatedDateStart: '2024-01-01T00:00:00Z',
            updatedDateEnd: '2024-12-31T23:59:59Z',
        });

        const [url] = fetchMock.mock.calls[0] as [string, any];
        expect(url).toContain('updatedDateStart=2024-01-01T00%3A00%3A00Z');
        expect(url).toContain('updatedDateEnd=2024-12-31T23%3A59%3A59Z');
    });

    it('forwards ids filter as comma-separated', async () => {
        const fetchMock = mockFetchResponse([]);

        await executeTool({ ids: ['abc', 'def'] });

        const [url] = fetchMock.mock.calls[0] as [string, any];
        expect(url).toContain('ids=abc%2Cdef');
    });
});

// ---------------------------------------------------------------------------
// VAL-INGEST-046: always sets isLightweight: false
// ---------------------------------------------------------------------------

describe('searchChallengesTool — isLightweight', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('always sends isLightweight=false in the query parameters', async () => {
        const fetchMock = mockFetchResponse([]);

        await executeTool({});

        const [url] = fetchMock.mock.calls[0] as [string, any];
        expect(url).toContain('isLightweight=false');
    });

    it('sends isLightweight=false even when no other filters are provided', async () => {
        const fetchMock = mockFetchResponse([]);

        await executeTool({ page: 1, perPage: 5 });

        const [url] = fetchMock.mock.calls[0] as [string, any];
        expect(url).toContain('isLightweight=false');
    });
});

// ---------------------------------------------------------------------------
// VAL-INGEST-047: includes app-version: 2.0.0 header
// ---------------------------------------------------------------------------

describe('searchChallengesTool — app-version header', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('includes app-version: 2.0.0 header in the request', async () => {
        const fetchMock = mockFetchResponse([]);

        await executeTool({});

        const [, init] = fetchMock.mock.calls[0] as [string, any];
        expect(init.headers['app-version']).toBe('2.0.0');
    });
});

// ---------------------------------------------------------------------------
// VAL-INGEST-048: handles bare-array API response
// ---------------------------------------------------------------------------

describe('searchChallengesTool — bare-array response handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('wraps a bare JSON array into { challenges, total, page, perPage }', async () => {
        mockFetchResponse([
            baseChallenge({ id: 'c1' }),
            baseChallenge({ id: 'c2' }),
            baseChallenge({ id: 'c3' }),
        ]);

        const result = await executeTool({ page: 1, perPage: 10 });

        expect(result).toBeDefined();
        expect(result.challenges).toHaveLength(3);
        expect(result.total).toBe(3);
        expect(result.page).toBe(1);
        expect(result.perPage).toBe(10);
    });

    it('handles an empty bare array response', async () => {
        mockFetchResponse([]);

        const result = await executeTool({ page: 1, perPage: 10 });

        expect(result.challenges).toHaveLength(0);
        expect(result.total).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// VAL-INGEST-049: returns pagination envelope
// ---------------------------------------------------------------------------

describe('searchChallengesTool — pagination envelope', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('returns { challenges, total, page, perPage } with correct values', async () => {
        mockFetchResponse([
            baseChallenge({ id: 'c1' }),
            baseChallenge({ id: 'c2' }),
        ]);

        const result = await executeTool({ page: 2, perPage: 20 });

        expect(result).toHaveProperty('challenges');
        expect(result).toHaveProperty('total');
        expect(result).toHaveProperty('page');
        expect(result).toHaveProperty('perPage');
        expect(Array.isArray(result.challenges)).toBe(true);
        expect(result.total).toBe(2);
        expect(result.page).toBe(2);
        expect(result.perPage).toBe(20);
    });

    it('defaults page to 1 and perPage to 20 when not provided', async () => {
        mockFetchResponse([baseChallenge()]);

        const result = await executeTool({});

        expect(result.page).toBe(1);
        expect(result.perPage).toBe(20);
    });
});

// ---------------------------------------------------------------------------
// VAL-INGEST-050: discards privateDescription
// ---------------------------------------------------------------------------

describe('searchChallengesTool — discards privateDescription', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('strips privateDescription from each challenge in the return value', async () => {
        mockFetchResponse([
            baseChallenge({ id: 'c1', privateDescription: 'secret1' }),
            baseChallenge({ id: 'c2', privateDescription: 'secret2' }),
        ]);

        const result = await executeTool({ page: 1, perPage: 10 });

        for (const challenge of result.challenges) {
            expect(challenge).not.toHaveProperty('privateDescription');
        }
    });

    it('preserves public description while discarding privateDescription', async () => {
        mockFetchResponse([
            baseChallenge({
                description: 'public description',
                privateDescription: 'private info',
            }),
        ]);

        const result = await executeTool({ page: 1, perPage: 10 });

        expect(result.challenges[0].description).toBe('public description');
        expect(result.challenges[0]).not.toHaveProperty('privateDescription');
    });
});

// ---------------------------------------------------------------------------
// VAL-INGEST-051: uses 15s timeout
// ---------------------------------------------------------------------------

describe('searchChallengesTool — 15s timeout', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('creates an AbortSignal with a 15-second timeout', async () => {
        const timeoutSpy = vi
            .spyOn(AbortSignal, 'timeout')
            .mockReturnValue(new AbortController().signal);

        mockFetchResponse([]);

        await executeTool({});

        expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    });

    it('passes the AbortSignal to fetch', async () => {
        vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
            new AbortController().signal,
        );

        const fetchMock = mockFetchResponse([]);

        await executeTool({});

        const [, init] = fetchMock.mock.calls[0] as [string, any];
        expect(init.signal).toBeDefined();
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });
});

// ---------------------------------------------------------------------------
// VAL-INGEST-052: propagates upstream non-2xx as errors
// ---------------------------------------------------------------------------

describe('searchChallengesTool — error handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('throws on 401 response with status code in error message', async () => {
        mockFetchError(401);

        await expect(executeTool({})).rejects.toThrow(/401/);
    });

    it('throws on 403 response with status code in error message', async () => {
        mockFetchError(403);

        await expect(executeTool({})).rejects.toThrow(/403/);
    });

    it('throws on 500 response with status code in error message', async () => {
        mockFetchError(500);

        await expect(executeTool({})).rejects.toThrow(/500/);
    });

    it('error message identifies the upstream failure', async () => {
        mockFetchError(502);

        await expect(executeTool({})).rejects.toThrow(
            /search challenges/i,
        );
    });
});

// ---------------------------------------------------------------------------
// Challenge field mapping
// ---------------------------------------------------------------------------

describe('searchChallengesTool — challenge field mapping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('maps track and type from string values', async () => {
        mockFetchResponse([
            baseChallenge({ track: 'Data Science', type: 'First2Finish' }),
        ]);

        const result = await executeTool({ page: 1, perPage: 10 });

        expect(result.challenges[0].track).toBe('Data Science');
        expect(result.challenges[0].type).toBe('First2Finish');
    });

    it('maps track and type from object with name property', async () => {
        mockFetchResponse([
            baseChallenge({
                track: { name: 'Design' },
                type: { name: 'Task' },
            }),
        ]);

        const result = await executeTool({ page: 1, perPage: 10 });

        expect(result.challenges[0].track).toBe('Design');
        expect(result.challenges[0].type).toBe('Task');
    });

    it('maps skills array with id and name', async () => {
        mockFetchResponse([
            baseChallenge({
                skills: [
                    { id: 's1', name: 'React' },
                    { id: 's2', name: 'TypeScript' },
                ],
            }),
        ]);

        const result = await executeTool({ page: 1, perPage: 10 });

        expect(result.challenges[0].skills).toEqual([
            { id: 's1', name: 'React' },
            { id: 's2', name: 'TypeScript' },
        ]);
    });

    it('preserves projectId as a number', async () => {
        mockFetchResponse([baseChallenge({ projectId: 99999 })]);

        const result = await executeTool({ page: 1, perPage: 10 });

        expect(result.challenges[0].projectId).toBe(99999);
    });

    it('preserves groups array', async () => {
        mockFetchResponse([baseChallenge({ groups: ['team-a', 'team-b'] })]);

        const result = await executeTool({ page: 1, perPage: 10 });

        expect(result.challenges[0].groups).toEqual(['team-a', 'team-b']);
    });
});
