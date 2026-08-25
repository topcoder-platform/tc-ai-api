import { describe, it, expect, beforeEach, vi } from 'vitest';

const { m2mTokenMock } = vi.hoisted(() => ({
    m2mTokenMock: vi.fn(),
}));

vi.mock('../../../utils/auth/m2m.service', () => ({
    M2MService: class MockM2MService {
        getM2MToken = m2mTokenMock;
    },
}));

import { fetchChallengeTool } from './fetch-challenge-tool';

// Minimal context for execute — the tool only uses context.mastra?.getLogger?.()
// which is optional, so undefined mastra is safe.
const minimalContext = { mastra: undefined } as any;

// Valid UUID v4 (zod 4's .uuid() rejects version-0 UUIDs)
const CHALLENGE_UUID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * Installs a global fetch spy that resolves with the given JSON body.
 * Returns the spy so tests can assert call arguments (URL, headers).
 */
function mockFetchResponse(data: Record<string, unknown>) {
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
 * Base API response with all existing fields populated.
 * Override individual fields via `overrides`.
 */
function baseApiResponse(overrides: Record<string, unknown> = {}) {
    return {
        id: 'challenge-1',
        name: 'Test Challenge',
        description: 'A test description',
        privateDescription: 'secret',
        descriptionFormat: 'markdown',
        status: 'ACTIVE',
        track: { name: 'Development' },
        type: { name: 'Challenge' },
        tags: ['tag1', 'tag2'],
        skills: [{ id: 's1', name: 'React' }],
        numOfRegistrants: 5,
        numOfSubmissions: 2,
        ...overrides,
    };
}

/**
 * Calls the tool's execute and returns the result cast to any, since
 * Mastra's execute return type is a union with ValidationError that
 * TypeScript cannot narrow without runtime checks.
 */
async function executeTool(challengeId: string): Promise<any> {
    return fetchChallengeTool.execute?.(
        { challengeId },
        minimalContext,
    ) as Promise<any>;
}

// ---------------------------------------------------------------------------
// VAL-INGEST-053: output schema includes projectId
// ---------------------------------------------------------------------------

describe('fetchChallengeTool — additive projectId field', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('returns projectId when the API response includes a numeric projectId', async () => {
        mockFetchResponse(baseApiResponse({ projectId: 12345 }));

        const result = await executeTool(CHALLENGE_UUID);

        expect(result?.challenge.projectId).toBe(12345);
    });

    // VAL-INGEST-058: projectId nullable from API — null becomes undefined
    it('omits projectId when the API response has projectId: null', async () => {
        mockFetchResponse(baseApiResponse({ projectId: null }));

        const result = await executeTool(CHALLENGE_UUID);

        expect(result?.challenge.projectId).toBeUndefined();
    });

    it('omits projectId when the API response does not include projectId', async () => {
        mockFetchResponse(baseApiResponse());

        const result = await executeTool(CHALLENGE_UUID);

        expect(result?.challenge.projectId).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// VAL-INGEST-054: output schema includes groups
// ---------------------------------------------------------------------------

describe('fetchChallengeTool — additive groups field', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('returns groups when the API response includes a groups array', async () => {
        mockFetchResponse(baseApiResponse({ groups: ['acme', 'beta'] }));

        const result = await executeTool(CHALLENGE_UUID);

        expect(result?.challenge.groups).toEqual(['acme', 'beta']);
    });

    it('omits groups when the API response does not include groups', async () => {
        mockFetchResponse(baseApiResponse());

        const result = await executeTool(CHALLENGE_UUID);

        expect(result?.challenge.groups).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// VAL-INGEST-055: mapping function passes projectId and groups through
// ---------------------------------------------------------------------------

describe('fetchChallengeTool — mapping passes both additive fields through', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('passes both projectId and groups from the API response into the output', async () => {
        mockFetchResponse(baseApiResponse({ projectId: 999, groups: ['x', 'y'] }));

        const result = await executeTool(CHALLENGE_UUID);

        expect(result?.challenge.projectId).toBe(999);
        expect(result?.challenge.groups).toEqual(['x', 'y']);
    });
});

// ---------------------------------------------------------------------------
// VAL-INGEST-057: app-version: 2.0.0 header preserved
// ---------------------------------------------------------------------------

describe('fetchChallengeTool — app-version header', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('includes app-version: 2.0.0 header in the request', async () => {
        const fetchMock = mockFetchResponse(baseApiResponse());

        await executeTool(CHALLENGE_UUID);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const callArgs = fetchMock.mock.calls[0] as [string, any];
        expect(callArgs[1].headers['app-version']).toBe('2.0.0');
    });

    it('includes Authorization bearer token from M2MService', async () => {
        const fetchMock = mockFetchResponse(baseApiResponse());

        await executeTool(CHALLENGE_UUID);

        const callArgs = fetchMock.mock.calls[0] as [string, any];
        expect(callArgs[1].headers.Authorization).toBe('Bearer fake-m2m-token');
    });
});

// ---------------------------------------------------------------------------
// VAL-INGEST-056: existing behavior unchanged
// ---------------------------------------------------------------------------

describe('fetchChallengeTool — existing behavior unchanged', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
    });

    it('returns all existing fields with correct values', async () => {
        mockFetchResponse(baseApiResponse());

        const result = await executeTool(CHALLENGE_UUID);

        expect(result?.challenge.id).toBe('challenge-1');
        expect(result?.challenge.name).toBe('Test Challenge');
        expect(result?.challenge.description).toBe('A test description');
        expect(result?.challenge.privateDescription).toBe('secret');
        expect(result?.challenge.descriptionFormat).toBe('markdown');
        expect(result?.challenge.status).toBe('ACTIVE');
        expect(result?.challenge.track).toBe('Development');
        expect(result?.challenge.type).toBe('Challenge');
        expect(result?.challenge.tags).toEqual(['tag1', 'tag2']);
        expect(result?.challenge.skills).toEqual([{ id: 's1', name: 'React' }]);
        expect(result?.challenge.numOfRegistrants).toBe(5);
        expect(result?.challenge.numOfSubmissions).toBe(2);
    });

    it('throws on non-2xx response', async () => {
        mockFetchError(404);

        await expect(
            executeTool(CHALLENGE_UUID),
        ).rejects.toThrow(/HTTP 404/);
    });

    it('constructs the URL with the challenge ID', async () => {
        const fetchMock = mockFetchResponse(baseApiResponse());

        await executeTool(CHALLENGE_UUID);

        const callArgs = fetchMock.mock.calls[0] as [string, any];
        expect(callArgs[0]).toContain(encodeURIComponent(CHALLENGE_UUID));
    });

    it('uses GET method', async () => {
        const fetchMock = mockFetchResponse(baseApiResponse());

        await executeTool(CHALLENGE_UUID);

        const callArgs = fetchMock.mock.calls[0] as [string, any];
        expect(callArgs[1].method).toBe('GET');
    });
});

// ---------------------------------------------------------------------------
// Output schema validation — projectId and groups are defined in the schema
// ---------------------------------------------------------------------------

describe('fetchChallengeTool — output schema defines additive fields', () => {
    /**
     * Validates against the tool's outputSchema using whichever interface the
     * schema exposes (zod safeParse or StandardSchema ~standard.validate).
     * Returns the parsed/validated value on success, or throws on failure.
     */
    async function validateOutput(value: unknown): Promise<any> {
        const schema = fetchChallengeTool.outputSchema as any;
        expect(schema).toBeDefined();

        if (typeof schema.safeParse === 'function') {
            const result = schema.safeParse(value);
            if (!result.success) {
                throw new Error(JSON.stringify(result.error));
            }
            return result.data;
        }

        if (schema['~standard']?.validate) {
            const result = await schema['~standard'].validate(value);
            if (result.issues) {
                throw new Error(JSON.stringify(result.issues));
            }
            return result.value;
        }

        throw new Error('Schema has neither safeParse nor ~standard.validate');
    }

    // VAL-INGEST-053: output schema includes projectId
    it('outputSchema includes projectId in the parsed output', async () => {
        const parsed = await validateOutput({
            challenge: {
                id: 'c1',
                name: 'Test',
                status: 'ACTIVE',
                tags: [],
                skills: [],
                numOfRegistrants: 0,
                numOfSubmissions: 0,
                projectId: 12345,
                groups: ['acme'],
            },
        });

        expect(parsed.challenge.projectId).toBe(12345);
    });

    // VAL-INGEST-054: output schema includes groups
    it('outputSchema includes groups in the parsed output', async () => {
        const parsed = await validateOutput({
            challenge: {
                id: 'c1',
                name: 'Test',
                status: 'ACTIVE',
                tags: [],
                skills: [],
                numOfRegistrants: 0,
                numOfSubmissions: 0,
                projectId: 12345,
                groups: ['acme'],
            },
        });

        expect(parsed.challenge.groups).toEqual(['acme']);
    });

    it('outputSchema accepts absence of projectId and groups (optional)', async () => {
        const parsed = await validateOutput({
            challenge: {
                id: 'c1',
                name: 'Test',
                status: 'ACTIVE',
                tags: [],
                skills: [],
                numOfRegistrants: 0,
                numOfSubmissions: 0,
            },
        });

        expect(parsed.challenge.projectId).toBeUndefined();
        expect(parsed.challenge.groups).toBeUndefined();
    });
});
