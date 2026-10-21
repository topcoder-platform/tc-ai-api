import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MASTRA_AUTH_TOKEN_KEY } from '@mastra/core/request-context';

const { m2mTokenMock } = vi.hoisted(() => ({
    m2mTokenMock: vi.fn(),
}));

vi.mock('../../../utils/auth/m2m.service', () => ({
    M2MService: class MockM2MService {
        getM2MToken = m2mTokenMock;
    },
}));

import { fetchClientProjectsTool } from './fetch-client-projects-tool';
import { ToolAccessDeniedError } from '../../../utils/auth/access-control';


const CLIENT = { id: '71000412', name: 'ANHEUSER-BUSCH', codeName: 'CUS-173826' };
const BILLING_ACCOUNT = { id: 70016070, name: 'RPC Rewrite', clientId: '71000412' };
const PROJECT = {
    id: '15554',
    name: 'RPC Rewrite',
    status: 'completed',
    billingAccountId: '70016070',
    lastActivityAt: '2025-11-04T12:30:00.000Z',
    lastActivityUserId: 40158994,
};

function memberUser(roles: string[]): Record<string, unknown> {
    return { sub: 'auth0|123', kind: 'user', isMachine: false, userId: 88774433, roles: roles };
}

/**
 * Builds a tool context for authorization tests.
 * @param user Verified member claims, or undefined to exercise missing identity.
 * @param token Requestor token; an empty string simulates missing credentials.
 * @returns Minimal Mastra execution context. Does not throw.
 */
function buildContext(user: Record<string, unknown> | undefined, token = 'fake-requestor-token') {
    return {
        mastra: undefined,
        requestContext: {
            get: (key: string) => {
                if (key === MASTRA_AUTH_TOKEN_KEY) return token;
                if (key === 'user') return user;
                return undefined;
            },
        },
    } as any;
}

/**
 * Stubs the three upstream APIs for client discovery tests.
 * @param options Response rows, pagination, statuses, and per-account visible projects.
 * @returns Fetch spy used to check forwarded credentials and requested URLs.
 * @throws Error for an unexpected endpoint, catching unintended upstream calls.
 */
function mockApi(
    options: {
        clients?: any[];
        clientsTotal?: number;
        clientsStatus?: number;
        billingAccounts?: any[];
        billingAccountsTotal?: number;
        billingAccountsStatus?: number;
        projects?: any[];
        projectsByBillingAccount?: Record<string, any[]>;
        projectsTotal?: number;
        projectsStatus?: number;
    } = {},
) {
    const clients = options.clients ?? [CLIENT];
    const clientsTotal = options.clientsTotal ?? clients.length;
    const billingAccounts = options.billingAccounts ?? [BILLING_ACCOUNT];
    const billingAccountsTotal = options.billingAccountsTotal ?? billingAccounts.length;
    const projects = options.projects ?? [PROJECT];
    const projectsTotal = options.projectsTotal ?? projects.length;

    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/clients')) {
            return {
                ok: options.clientsStatus === undefined || options.clientsStatus < 400,
                status: options.clientsStatus ?? 200,
                headers: new Headers(),
                json: async () => ({ page: 1, perPage: 50, total: clientsTotal, totalPages: 1, data: clients }),
            } as Response;
        }
        if (url.includes('/billing-accounts')) {
            return {
                ok: options.billingAccountsStatus === undefined || options.billingAccountsStatus < 400,
                status: options.billingAccountsStatus ?? 200,
                headers: new Headers(),
                json: async () => ({
                    page: 1,
                    perPage: 50,
                    total: billingAccountsTotal,
                    totalPages: 1,
                    data: billingAccounts,
                }),
            } as Response;
        }
        if (url.includes('/projects')) {
            const accountId = new URL(url, 'https://api.topcoder-dev.com').searchParams.get('billingAccountId') ?? '';
            const visibleProjects = options.projectsByBillingAccount?.[accountId] ?? projects;
            return {
                ok: options.projectsStatus === undefined || options.projectsStatus < 400,
                status: options.projectsStatus ?? 200,
                headers: new Headers({ 'x-total': String(options.projectsByBillingAccount ? visibleProjects.length : projectsTotal) }),
                json: async () => visibleProjects,
            } as Response;
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
    });
}

async function executeTool(
    input: { codeName?: string; name?: string },
    user: Record<string, unknown> | undefined = memberUser(['administrator']),
) {
    return fetchClientProjectsTool.execute?.(input, buildContext(user)) as Promise<any>;
}

beforeEach(() => {
    vi.clearAllMocks();
    m2mTokenMock.mockResolvedValue('fake-m2m-token');
    process.env.TC_API_BASE = 'https://api.topcoder.com';
    delete process.env.DISABLE_AUTH;
});

describe('fetchClientProjectsTool — happy path', () => {
    it('walks clients -> billing accounts -> projects and nests the result', async () => {
        mockApi();

        const result = await executeTool({ name: 'ANHEUSER' });

        expect(result.clients).toHaveLength(1);
        expect(result.clients[0]).toMatchObject({
            id: '71000412',
            name: 'ANHEUSER-BUSCH',
            codeName: 'CUS-173826',
            billingAccountsTruncated: false,
        });
        expect(result.clients[0].billingAccounts).toHaveLength(1);
        expect(result.clients[0].billingAccounts[0]).toMatchObject({
            id: '70016070',
            name: 'RPC Rewrite',
            projectsTruncated: false,
        });
        expect(result.clients[0].billingAccounts[0].projects).toEqual([
            {
                id: '15554',
                name: 'RPC Rewrite',
                status: 'completed',
                lastActivityAt: '2025-11-04T12:30:00.000Z',
                lastActivityUserId: '40158994',
            },
        ]);
        expect(result.clientsTruncated).toBe(false);
    });

    it('forwards only the search params actually supplied', async () => {
        const fetchSpy = mockApi();

        await executeTool({ codeName: 'CUS-173826' });

        const clientsCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/clients'));
        const [url] = clientsCall as [string];
        expect(url).toContain('codeName=CUS-173826');
        expect(url).not.toContain('name=');
    });
});

describe('fetchClientProjectsTool — truncation', () => {
    it('flags clientsTruncated when total exceeds the returned page', async () => {
        mockApi({ clientsTotal: 5 });
        expect((await executeTool({ name: 'a' })).clientsTruncated).toBe(true);
    });

    it('flags billingAccountsTruncated per client', async () => {
        mockApi({ billingAccountsTotal: 9 });
        const result = await executeTool({ name: 'a' });
        expect(result.clients[0].billingAccountsTruncated).toBe(true);
    });

    it('flags projectsTruncated per billing account using the x-total header', async () => {
        mockApi({ projectsTotal: 99 });
        const result = await executeTool({ name: 'a' });
        expect(result.clients[0].billingAccounts[0].projectsTruncated).toBe(true);
    });
});

describe('fetchClientProjectsTool — validation and errors', () => {
    it('throws when neither codeName nor name is supplied', async () => {
        await expect(executeTool({})).rejects.toThrow(/codeName or name/);
    });

    it('throws with the HTTP status on a non-2xx clients response', async () => {
        mockApi({ clientsStatus: 500 });
        await expect(executeTool({ name: 'a' })).rejects.toThrow(/HTTP 500/);
    });

    it('returns an empty client list when nothing matches, without throwing', async () => {
        mockApi({ clients: [], clientsTotal: 0 });
        const result = await executeTool({ name: 'nonexistent' });
        expect(result.clients).toEqual([]);
        expect(result.clientsTruncated).toBe(false);
    });
});

describe('fetchClientProjectsTool — credential selection', () => {
    it.each([
        ['administrator'],
        ['Talent Manager'],
        ['administrator', 'Talent Manager'],
    ])('uses the requestor token for every API call with roles %j', async (...roles) => {
        const fetchSpy = mockApi();

        await executeTool({ name: 'a' }, memberUser(roles));

        expect(fetchSpy).toHaveBeenCalledTimes(3);
        for (const [, init] of fetchSpy.mock.calls) {
            expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fake-requestor-token');
        }
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it('rejects a missing requestor token without requesting M2M credentials', async () => {
        const fetchSpy = mockApi();

        await expect(fetchClientProjectsTool.execute?.(
            { name: 'a' }, buildContext(memberUser(['Talent Manager']), ''),
        )).rejects.toThrow(/No requestor token/);

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it.each([401, 403])('does not escalate on HTTP %s at any discovery level', async (status) => {
        for (const endpoint of ['clientsStatus', 'billingAccountsStatus', 'projectsStatus']) {
            const fetchSpy = mockApi({ [endpoint]: status });

            const request = executeTool({ name: 'a' }, memberUser(['Talent Manager']));
            await expect(request).rejects.toThrow(`HTTP ${status}`);
            await expect(request).rejects.not.toThrow(String(BILLING_ACCOUNT.id));

            expect(m2mTokenMock).not.toHaveBeenCalled();
            for (const [, init] of fetchSpy.mock.calls) {
                expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fake-requestor-token');
            }
            fetchSpy.mockRestore();
        }
    });
});

describe('fetchClientProjectsTool — internal billing account visibility (PM-6517)', () => {
    const internalAccount = { id: 80004349, name: 'Topcoder Sales Investment - FY25-26' };
    const internalProject = { ...PROJECT, id: '1000853', billingAccountId: '80004349', name: 'Internal project' };

    it('omits internal account details when no projects are visible to the Talent Manager', async () => {
        mockApi({
            clients: [{ id: '1', name: 'Topcoder', codeName: 'CUS-174018' }],
            billingAccounts: [internalAccount, BILLING_ACCOUNT],
            projectsByBillingAccount: { '80004349': [], '70016070': [PROJECT] },
        });

        const result = await executeTool({ name: 'Topcoder' }, memberUser(['Talent Manager']));

        expect(result.clients[0].billingAccounts).toEqual([
            expect.objectContaining({ id: '70016070', projects: [expect.objectContaining({ id: PROJECT.id })] }),
        ]);
        expect(JSON.stringify(result)).not.toContain(String(internalAccount.id));
        expect(JSON.stringify(result)).not.toContain(internalAccount.name);
    });

    it('returns only the internal projects the Projects API makes visible through active membership', async () => {
        mockApi({ billingAccounts: [internalAccount], projects: [internalProject] });

        const result = await executeTool({ name: 'Topcoder' }, memberUser(['Talent Manager']));

        expect(result.clients[0].billingAccounts).toEqual([
            expect.objectContaining({
                id: '80004349', name: internalAccount.name,
                projects: [expect.objectContaining({ id: internalProject.id })],
            }),
        ]);
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it.each(['administrator', 'Administrator'])('preserves empty accounts for %s callers', async (role) => {
        mockApi({ billingAccounts: [internalAccount], projects: [] });

        const result = await executeTool({ name: 'Topcoder' }, memberUser([role, 'Talent Manager']));

        expect(result.clients[0].billingAccounts).toEqual([
            { id: '80004349', name: internalAccount.name, projects: [], projectsTruncated: false },
        ]);
    });

    it('returns no account metadata when all projects are hidden', async () => {
        mockApi({ billingAccounts: [internalAccount], projects: [] });

        const result = await executeTool({ name: 'Topcoder' }, memberUser(['Talent Manager']));

        expect(result.clients[0].billingAccounts).toEqual([]);
    });
});

describe('fetchClientProjectsTool — RBAC', () => {
    it('denies callers without administrator or Talent Manager', async () => {
        mockApi();

        await expect(
            executeTool({ name: 'a' }, memberUser(['copilot'])),
        ).rejects.toBeInstanceOf(ToolAccessDeniedError);
    });

    it('allows Talent Manager callers through RBAC', async () => {
        mockApi();

        await expect(
            executeTool({ name: 'a' }, memberUser(['Talent Manager'])),
        ).resolves.toMatchObject({ clientsTruncated: false });
    });
});
