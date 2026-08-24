import { describe, it, expect, beforeEach, vi } from 'vitest';

const { m2mTokenMock } = vi.hoisted(() => ({
    m2mTokenMock: vi.fn(),
}));

vi.mock('../../../utils/auth/m2m.service', () => ({
    M2MService: class MockM2MService {
        getM2MToken = m2mTokenMock;
    },
}));

import { fetchProjectTool } from './fetch-project-tool';

// Minimal context for execute — the tool only uses context.mastra?.getLogger?.()
// which is optional, so undefined mastra is safe.
const minimalContext = { mastra: undefined } as any;

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

function baseApiResponse(overrides: Record<string, unknown> = {}) {
    return {
        id: 17423,
        name: 'Acme Redesign',
        status: 'active',
        type: 'app_dev',
        billingAccountId: 98765,
        directProjectId: 54321,
        techStack: ['React', 'Node.js'],
        ...overrides,
    };
}

async function executeTool(input: Record<string, unknown>): Promise<any> {
    return fetchProjectTool.execute?.(input as any, minimalContext) as Promise<any>;
}

beforeEach(() => {
    vi.clearAllMocks();
    m2mTokenMock.mockResolvedValue('fake-m2m-token');
});

describe('fetchProjectTool — request construction', () => {
    it('sends an M2M-authenticated GET request to the project endpoint', async () => {
        const fetchSpy = mockFetchResponse(baseApiResponse());

        await executeTool({ projectId: '17423' });

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toMatch(/\/v6\/projects\/17423$/);
        expect(init.method).toBe('GET');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-m2m-token');
    });

    it('appends a fields query param when supplied', async () => {
        const fetchSpy = mockFetchResponse(baseApiResponse());

        await executeTool({ projectId: '17423', fields: 'id,name' });

        const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toMatch(/\/v6\/projects\/17423\?fields=id%2Cname$/);
    });
});

describe('fetchProjectTool — response mapping', () => {
    it('coerces id/billingAccountId/directProjectId to strings', async () => {
        mockFetchResponse(baseApiResponse());

        const result = await executeTool({ projectId: '17423' });

        expect(result.project).toEqual({
            id: '17423',
            name: 'Acme Redesign',
            status: 'active',
            type: 'app_dev',
            billingAccountId: '98765',
            directProjectId: '54321',
            techStack: ['React', 'Node.js'],
        });
    });

    it('falls back to the requested projectId when the response omits id', async () => {
        mockFetchResponse(baseApiResponse({ id: undefined }));
        const result = await executeTool({ projectId: '17423' });
        expect(result.project.id).toBe('17423');
    });

    it('leaves billingAccountId/directProjectId undefined when absent', async () => {
        mockFetchResponse(baseApiResponse({ billingAccountId: null, directProjectId: undefined }));
        const result = await executeTool({ projectId: '17423' });
        expect(result.project.billingAccountId).toBeUndefined();
        expect(result.project.directProjectId).toBeUndefined();
    });

    it('reads techStack from details.techStack when the top-level field is absent', async () => {
        mockFetchResponse(
            baseApiResponse({ techStack: undefined, details: { techStack: ['Python'] } }),
        );
        const result = await executeTool({ projectId: '17423' });
        expect(result.project.techStack).toEqual(['Python']);
    });
});

describe('fetchProjectTool — error handling', () => {
    it('throws with the HTTP status when the response is not ok', async () => {
        mockFetchError(404);
        await expect(executeTool({ projectId: '17423' })).rejects.toThrow(/404/);
    });
});
