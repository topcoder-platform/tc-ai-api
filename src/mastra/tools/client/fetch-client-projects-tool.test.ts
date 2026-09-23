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

const ROLES_CLAIM = 'https://topcoder.com/roles';
const USERID_CLAIM = 'https://topcoder.com/userId';

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
    return { sub: 'auth0|123', [USERID_CLAIM]: '88774433', [ROLES_CLAIM]: roles };
}

function buildContext(user: Record<string, unknown> | undefined) {
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

function mockApi(
    options: {
        clients?: any[];
        clientsTotal?: number;
        clientsStatus?: number;
        billingAccounts?: any[];
        billingAccountsTotal?: number;
        billingAccountsStatus?: number;
        projects?: any[];
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
            return {
                ok: options.projectsStatus === undefined || options.projectsStatus < 400,
                status: options.projectsStatus ?? 200,
                headers: new Headers({ 'x-total': String(projectsTotal) }),
                json: async () => projects,
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
    it('uses the requestor token for administrator callers', async () => {
        const fetchSpy = mockApi();

        await executeTool({ name: 'a' }, memberUser(['administrator']));

        const clientsCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/clients'));
        const [, init] = clientsCall as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-requestor-token');
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it('uses M2M for Talent Manager callers without administrator', async () => {
        const fetchSpy = mockApi();

        await executeTool({ name: 'a' }, memberUser(['Talent Manager']));

        const clientsCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/clients'));
        const [, init] = clientsCall as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-m2m-token');
    });

    it('uses the requestor token when the caller has both administrator and Talent Manager', async () => {
        const fetchSpy = mockApi();

        await executeTool({ name: 'a' }, memberUser(['administrator', 'Talent Manager']));

        const clientsCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/clients'));
        const [, init] = clientsCall as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-requestor-token');
    });

    it('uses M2M when no user is on the request context', async () => {
        // RBAC would deny a missing user before execute runs — DISABLE_AUTH isolates
        // the outbound credential branch (fail toward M2M when !user).
        process.env.DISABLE_AUTH = 'true';
        const fetchSpy = mockApi();

        await fetchClientProjectsTool.execute?.({ name: 'a' }, buildContext(undefined));

        const clientsCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/clients'));
        const [, init] = clientsCall as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-m2m-token');
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
