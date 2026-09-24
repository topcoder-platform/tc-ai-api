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

import { fetchProjectTool } from './fetch-project-tool';
import { ToolAccessDeniedError } from '../../../utils/auth/access-control';

const ROLES_CLAIM = 'https://topcoder.com/roles';
const USERID_CLAIM = 'https://topcoder.com/userId';

// Minimal context for execute — the tool uses context.mastra?.getLogger?.()
// (optional) and context.requestContext (to read the requestor's token and,
// since ADR 0007, the RBAC-checked user — must carry an allowed role).
const minimalContext = {
    mastra: undefined,
    requestContext: {
        get: (key: string) =>
            key === MASTRA_AUTH_TOKEN_KEY
                ? 'fake-requestor-token'
                : key === 'user'
                    ? { sub: 'test-user', [USERID_CLAIM]: '88774433', [ROLES_CLAIM]: ['administrator'] }
                    : undefined,
    },
} as any;

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
        lastActivityAt: '2025-11-04T12:30:00.000Z',
        lastActivityUserId: 40158994,
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
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-requestor-token');
    });

    it('appends a fields query param when supplied', async () => {
        const fetchSpy = mockFetchResponse(baseApiResponse());

        await executeTool({ projectId: '17423', fields: 'id,name' });

        const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toMatch(/\/v6\/projects\/17423\?fields=id%2Cname$/);
    });
});

describe('fetchProjectTool — response mapping', () => {
    it('coerces id/billingAccountId/directProjectId/lastActivityUserId to strings', async () => {
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
            lastActivityAt: '2025-11-04T12:30:00.000Z',
            lastActivityUserId: '40158994',
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

describe('fetchProjectTool — members', () => {
    function apiMember(overrides: Record<string, unknown> = {}) {
        return {
            id: '1000335',
            projectId: '1000289',
            userId: '8547899',
            role: 'manager',
            isPrimary: true,
            deletedAt: null,
            createdAt: '2025-01-07T18:23:17.853Z',
            updatedAt: '2025-01-07T18:23:17.865Z',
            deletedBy: null,
            createdBy: 8547899,
            updatedBy: 8547899,
            handle: 'TonyJ',
            ...overrides,
        };
    }

    it('maps members to userId/handle/role/isPrimary/createdAt, dropping audit fields', async () => {
        mockFetchResponse(baseApiResponse({ members: [apiMember()] }));

        const result = await executeTool({ projectId: '17423' });

        expect(result.project.members).toEqual([
            {
                userId: '8547899',
                handle: 'TonyJ',
                role: 'manager',
                isPrimary: true,
                createdAt: '2025-01-07T18:23:17.853Z',
            },
        ]);
    });

    it('coerces a numeric userId to string', async () => {
        mockFetchResponse(baseApiResponse({ members: [apiMember({ userId: 40158994, handle: 'copilotX', role: 'copilot', isPrimary: false })] }));
        const result = await executeTool({ projectId: '17423' });
        expect(result.project.members[0]).toMatchObject({ userId: '40158994', role: 'copilot', isPrimary: false });
    });

    it('drops soft-deleted members and members without a userId', async () => {
        mockFetchResponse(
            baseApiResponse({
                members: [
                    apiMember(),
                    apiMember({ userId: '111', deletedAt: '2025-02-01T00:00:00.000Z' }),
                    apiMember({ userId: null }),
                ],
            }),
        );
        const result = await executeTool({ projectId: '17423' });
        expect(result.project.members.map((m: any) => m.userId)).toEqual(['8547899']);
    });

    it('leaves members undefined when the response has none', async () => {
        mockFetchResponse(baseApiResponse());
        const result = await executeTool({ projectId: '17423' });
        expect(result.project.members).toBeUndefined();
    });

    it('keeps members on the best name match but strips them from matches', async () => {
        mockFetchResponse([
            baseApiResponse({ id: 1, name: 'skproject1 archive', members: [apiMember({ userId: '1' })] }),
            baseApiResponse({ id: 2, name: 'SKProject1', members: [apiMember({ userId: '2' })] }),
        ] as any);

        const result = await executeTool({ projectId: 'skproject1' });

        expect(result.project.members.map((m: any) => m.userId)).toEqual(['2']);
        expect(result.matches[0].members).toBeUndefined();
    });
});

describe('fetchProjectTool — name resolution', () => {
    it('searches by name when the input is not numeric', async () => {
        const fetchSpy = mockFetchResponse([baseApiResponse({ id: 17423, name: 'skproject1' })] as any);

        const result = await executeTool({ projectId: 'skproject1' });

        const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toMatch(/\/v6\/projects\?name=skproject1&perPage=\d+$/);
        expect(result.resolvedBy).toBe('name');
        expect(result.project.id).toBe('17423');
        expect(result.project.name).toBe('skproject1');
        expect(result.matches).toBeUndefined();
    });

    it('reports resolvedBy "id" for a numeric input', async () => {
        mockFetchResponse(baseApiResponse());
        const result = await executeTool({ projectId: '17423' });
        expect(result.resolvedBy).toBe('id');
    });

    it('accepts a { data: [...] } list envelope', async () => {
        mockFetchResponse({ data: [baseApiResponse({ id: 17423, name: 'skproject1' })] });
        const result = await executeTool({ projectId: 'skproject1' });
        expect(result.project.id).toBe('17423');
    });

    it('prefers an exact (case-insensitive) name match and returns the rest as matches', async () => {
        mockFetchResponse([
            baseApiResponse({ id: 1, name: 'skproject1 archive' }),
            baseApiResponse({ id: 2, name: 'SKProject1' }),
        ] as any);

        const result = await executeTool({ projectId: 'skproject1' });

        expect(result.project.id).toBe('2');
        expect(result.matches.map((m: any) => m.id)).toEqual(['1']);
    });

    it('falls back to the first hit when no name matches exactly', async () => {
        mockFetchResponse([
            baseApiResponse({ id: 1, name: 'skproject1 archive' }),
            baseApiResponse({ id: 2, name: 'skproject1 legacy' }),
        ] as any);

        const result = await executeTool({ projectId: 'skproject1' });

        expect(result.project.id).toBe('1');
        expect(result.matches.map((m: any) => m.id)).toEqual(['2']);
    });

    it('throws when the name search returns no projects', async () => {
        mockFetchResponse([] as any);
        await expect(executeTool({ projectId: 'skproject1' })).rejects.toThrow(/No project found matching name/);
    });

    it('throws with the HTTP status when the name search fails', async () => {
        mockFetchError(403);
        await expect(executeTool({ projectId: 'skproject1' })).rejects.toThrow(/403/);
    });
});

describe('fetchProjectTool — error handling', () => {
    it('throws with the HTTP status when the response is not ok', async () => {
        mockFetchError(404);
        await expect(executeTool({ projectId: '17423' })).rejects.toThrow(/404/);
    });
});

/**
 * Installs a global fetch spy that routes GET /v6/billing-accounts/:id
 * separately from the project fetch/search call, so enrichment behavior can
 * be tested independently of the base project lookup. See ADR 0007.
 */
function mockFetchByUrl(responses: {
    projectOrSearch?: unknown;
    projectStatus?: number;
    billingAccount?: Record<string, unknown>;
    billingAccountStatus?: number;
    billingAccountThrows?: boolean;
}) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/billing-accounts/')) {
            if (responses.billingAccountThrows) {
                throw new Error('network down');
            }
            return {
                ok: responses.billingAccountStatus === undefined || responses.billingAccountStatus < 400,
                status: responses.billingAccountStatus ?? 200,
                json: async () => responses.billingAccount ?? {},
            } as Response;
        }
        return {
            ok: responses.projectStatus === undefined || responses.projectStatus < 400,
            status: responses.projectStatus ?? 200,
            json: async () => responses.projectOrSearch,
        } as Response;
    });
}

describe('fetchProjectTool — client enrichment', () => {
    it('enriches the project with client and subcontractingEndCustomer from its billing account', async () => {
        mockFetchByUrl({
            projectOrSearch: baseApiResponse(),
            billingAccount: {
                id: 98765,
                client: { id: '71000535', name: 'Wipro Limited (NA subcontracting)', codeName: 'CUS-275117' },
                subcontractingEndCustomer: 'Ford India',
            },
        });

        const result = await executeTool({ projectId: '17423' });

        expect(result.project.client).toEqual({
            id: '71000535',
            name: 'Wipro Limited (NA subcontracting)',
            codeName: 'CUS-275117',
        });
        expect(result.project.subcontractingEndCustomer).toBe('Ford India');
    });

    it('never escalates to M2M for the billing-account enrichment call', async () => {
        const fetchSpy = mockFetchByUrl({
            projectOrSearch: baseApiResponse(),
            billingAccount: { id: 98765, client: { id: '1', name: 'X' } },
        });

        await executeTool({ projectId: '17423' });

        const billingCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/billing-accounts/'));
        const [, init] = billingCall as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-requestor-token');
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it('skips enrichment when the project has no billingAccountId', async () => {
        const fetchSpy = mockFetchByUrl({ projectOrSearch: baseApiResponse({ billingAccountId: null }) });

        const result = await executeTool({ projectId: '17423' });

        expect(result.project.client).toBeUndefined();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('fails soft (no error, no client) when the billing-account call is non-2xx', async () => {
        mockFetchByUrl({ projectOrSearch: baseApiResponse(), billingAccountStatus: 404 });

        const result = await executeTool({ projectId: '17423' });

        expect(result.project.client).toBeUndefined();
        expect(result.project.id).toBe('17423');
    });

    it('fails soft (no error, no client) when the billing-account call throws', async () => {
        mockFetchByUrl({ projectOrSearch: baseApiResponse(), billingAccountThrows: true });

        const result = await executeTool({ projectId: '17423' });

        expect(result.project.client).toBeUndefined();
        expect(result.project.id).toBe('17423');
    });

    it('enriches only the primary project, not the matches list', async () => {
        const fetchSpy = mockFetchByUrl({
            projectOrSearch: [
                baseApiResponse({ id: 1, name: 'skproject1 archive', billingAccountId: 111 }),
                baseApiResponse({ id: 2, name: 'SKProject1', billingAccountId: 222 }),
            ],
            billingAccount: { id: 222, client: { id: '9', name: 'Best Match Client' } },
        });

        const result = await executeTool({ projectId: 'skproject1' });

        expect(result.project.id).toBe('2');
        expect(result.project.client).toEqual({ id: '9', name: 'Best Match Client' });
        expect(result.matches[0].client).toBeUndefined();

        const billingCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/billing-accounts/'));
        expect(billingCalls).toHaveLength(1);
    });
});

describe('fetchProjectTool — RBAC', () => {
    function contextForUser(user: Record<string, unknown> | undefined) {
        return {
            mastra: undefined,
            requestContext: {
                get: (key: string) => {
                    if (key === MASTRA_AUTH_TOKEN_KEY) return 'fake-requestor-token';
                    if (key === 'user') return user;
                    return undefined;
                },
            },
        } as any;
    }

    it('denies callers without administrator or Talent Manager (ADR 0007 — was public)', async () => {
        mockFetchResponse(baseApiResponse());
        const user = { sub: 'auth0|1', [USERID_CLAIM]: '1', [ROLES_CLAIM]: ['copilot'] };

        await expect(
            fetchProjectTool.execute?.({ projectId: '17423' } as any, contextForUser(user)),
        ).rejects.toBeInstanceOf(ToolAccessDeniedError);
    });

    it('allows Talent Manager callers through RBAC', async () => {
        mockFetchResponse(baseApiResponse());
        const user = { sub: 'auth0|1', [USERID_CLAIM]: '1', [ROLES_CLAIM]: ['Talent Manager'] };

        await expect(
            fetchProjectTool.execute?.({ projectId: '17423' } as any, contextForUser(user)),
        ).resolves.toMatchObject({ resolvedBy: 'id' });
    });
});
