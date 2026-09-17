import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MASTRA_AUTH_TOKEN_KEY } from '@mastra/core/request-context';
import { resetResourceRolesCacheForTests } from '../../../utils/tc-resource-roles-cache';
import { ToolAccessDeniedError } from '../../../utils/auth/access-control';

const { m2mTokenMock } = vi.hoisted(() => ({
    m2mTokenMock: vi.fn(),
}));

vi.mock('../../../utils/auth/m2m.service', () => ({
    M2MService: class MockM2MService {
        getM2MToken = m2mTokenMock;
    },
}));

import { fetchChallengeResourcesTool } from './fetch-challenge-resources-tool';

const CHALLENGE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const ROLES_CLAIM = 'https://topcoder.com/roles';
const USERID_CLAIM = 'https://topcoder.com/userId';

const ROLE_IDS = {
    copilot: 'cfe12b3f-2a24-4639-9d8b-ec86726f76bd',
    reviewer: '11111111-1111-4111-8111-111111111111',
    iterativeReviewer: '22222222-2222-4222-8222-222222222222',
    submitter: '732339e7-8e30-49d7-9198-cccf9451e221',
    manager: '33333333-3333-4333-8333-333333333333',
    observer: '44444444-4444-4444-8444-444444444444',
};

const MOCK_ROLES = [
    { id: ROLE_IDS.copilot, name: 'Copilot' },
    { id: ROLE_IDS.reviewer, name: 'Reviewer' },
    { id: ROLE_IDS.iterativeReviewer, name: 'Iterative Reviewer' },
    { id: ROLE_IDS.submitter, name: 'Submitter' },
    { id: ROLE_IDS.manager, name: 'Manager' },
    { id: ROLE_IDS.observer, name: 'Observer' },
    { id: '55555555-5555-4555-8555-555555555555', name: 'Client Manager' },
    { id: '66666666-6666-4666-8666-666666666666', name: 'Final Reviewer' },
    { id: '77777777-7777-4777-8777-777777777777', name: 'Screener' },
    { id: '88888888-8888-4888-8888-888888888888', name: 'Primary Screener' },
    { id: '99999999-9999-4999-8999-999999999999', name: 'Checkpoint Screener' },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Checkpoint Reviewer' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Accuracy Reviewer' },
    { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Stress Reviewer' },
    { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Specification Reviewer' },
    { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Post-Mortem Reviewer' },
    { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Failure Reviewer' },
    { id: '10101010-1010-4101-8101-101010101010', name: 'Aggregator' },
    { id: '20202020-2020-4202-8202-202020202020', name: 'Approver' },
];

const MOCK_RESOURCES = [
    {
        memberId: '1001',
        memberHandle: 'copilot_user',
        roleId: ROLE_IDS.copilot,
        roleName: 'Copilot',
    },
    {
        memberId: '1002',
        memberHandle: 'reviewer_one',
        roleId: ROLE_IDS.reviewer,
        roleName: 'Reviewer',
    },
    {
        memberId: '1003',
        memberHandle: 'iterative_reviewer',
        roleId: ROLE_IDS.iterativeReviewer,
        roleName: 'Iterative Reviewer',
    },
    {
        memberId: '1004',
        memberHandle: 'submitter_one',
        roleId: ROLE_IDS.submitter,
        roleName: 'Submitter',
    },
    {
        memberId: '1005',
        memberHandle: 'manager_one',
        roleId: ROLE_IDS.manager,
        roleName: 'Manager',
    },
    {
        memberId: '1006',
        memberHandle: 'observer_one',
        roleId: ROLE_IDS.observer,
        roleName: 'Observer',
    },
];

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

function mockApi(resources = MOCK_RESOURCES, options: { total?: number; resourcesStatus?: number } = {}) {
    const total = options.total ?? resources.length;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/resource-roles')) {
            return {
                ok: true,
                status: 200,
                json: async () => MOCK_ROLES,
            } as Response;
        }
        if (url.includes('/resources')) {
            return {
                ok: options.resourcesStatus === undefined || options.resourcesStatus < 400,
                status: options.resourcesStatus ?? 200,
                headers: new Headers({ 'x-total': String(total) }),
                json: async () => resources,
            } as Response;
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
    });
}

async function executeTool(
    input: {
        challengeId: string;
        role?: 'copilot' | 'reviewers' | 'registrants' | 'managers' | 'observers' | 'all';
        roleId?: string;
    },
    user: Record<string, unknown> = memberUser(['administrator']),
) {
    return fetchChallengeResourcesTool.execute?.(input, buildContext(user)) as Promise<any>;
}

beforeEach(() => {
    vi.clearAllMocks();
    resetResourceRolesCacheForTests();
    m2mTokenMock.mockResolvedValue('fake-m2m-token');
    process.env.TC_API_BASE = 'https://api.topcoder.com';
    delete process.env.DISABLE_AUTH;
});

describe('fetchChallengeResourcesTool — role categories', () => {
    it('returns only copilot resources for role: "copilot"', async () => {
        mockApi();

        const result = await executeTool({ challengeId: CHALLENGE_UUID, role: 'copilot' });

        expect(result.resources).toHaveLength(1);
        expect(result.resources[0].memberHandle).toBe('copilot_user');
        expect(result.role).toBe('copilot');
    });

    it('returns all reviewer variants for role: "reviewers"', async () => {
        mockApi();

        const result = await executeTool({ challengeId: CHALLENGE_UUID, role: 'reviewers' });

        expect(result.resources).toHaveLength(2);
        expect(result.resources.map((r: { memberHandle: string }) => r.memberHandle)).toEqual([
            'reviewer_one',
            'iterative_reviewer',
        ]);
    });

    it('returns submitter resources for role: "registrants"', async () => {
        mockApi();

        const result = await executeTool({ challengeId: CHALLENGE_UUID, role: 'registrants' });

        expect(result.resources).toHaveLength(1);
        expect(result.resources[0].roleName).toBe('Submitter');
    });

    it('returns unfiltered resources when role is omitted or "all"', async () => {
        mockApi();

        const omitted = await executeTool({ challengeId: CHALLENGE_UUID });
        const explicitAll = await executeTool({ challengeId: CHALLENGE_UUID, role: 'all' });

        expect(omitted.resources).toHaveLength(MOCK_RESOURCES.length);
        expect(omitted.role).toBe('all');
        expect(explicitAll.resources).toHaveLength(MOCK_RESOURCES.length);
    });

    it('filters by raw roleId and roleId takes precedence over role', async () => {
        mockApi();

        const result = await executeTool({
            challengeId: CHALLENGE_UUID,
            role: 'copilot',
            roleId: ROLE_IDS.submitter,
        });

        expect(result.resources).toHaveLength(1);
        expect(result.resources[0].memberHandle).toBe('submitter_one');
        expect(result.role).toBe(`roleId:${ROLE_IDS.submitter}`);
    });
});

describe('fetchChallengeResourcesTool — truncation and errors', () => {
    it('sets truncated: true when x-total exceeds the returned page', async () => {
        mockApi(MOCK_RESOURCES, { total: 1500 });

        const result = await executeTool({ challengeId: CHALLENGE_UUID, role: 'all' });

        expect(result.truncated).toBe(true);
    });

    it('sets truncated: false when x-total matches the returned page', async () => {
        mockApi();

        const result = await executeTool({ challengeId: CHALLENGE_UUID, role: 'all' });

        expect(result.truncated).toBe(false);
    });

    it('throws on non-2xx upstream response', async () => {
        mockApi(MOCK_RESOURCES, { resourcesStatus: 404 });

        await expect(
            executeTool({ challengeId: CHALLENGE_UUID, role: 'copilot' }),
        ).rejects.toThrow(/Failed to fetch resources for challenge .* \(HTTP 404\)/);
    });
});

describe('fetchChallengeResourcesTool — shouldForceM2M', () => {
    it('uses the requestor token for administrator callers', async () => {
        const fetchSpy = mockApi();

        await executeTool({ challengeId: CHALLENGE_UUID, role: 'copilot' }, memberUser(['administrator']));

        const resourcesCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/resources'));
        const [, init] = resourcesCall as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-requestor-token');
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it('uses M2M for Talent Manager callers without administrator', async () => {
        const fetchSpy = mockApi();

        await executeTool(
            { challengeId: CHALLENGE_UUID, role: 'reviewers' },
            memberUser(['Talent Manager']),
        );

        const resourcesCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/resources'));
        const [, init] = resourcesCall as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-m2m-token');
    });

    it('uses the requestor token when the caller has both administrator and Talent Manager', async () => {
        const fetchSpy = mockApi();

        await executeTool(
            { challengeId: CHALLENGE_UUID, role: 'reviewers' },
            memberUser(['administrator', 'Talent Manager']),
        );

        const resourcesCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/resources'));
        const [, init] = resourcesCall as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-requestor-token');
    });

    it('uses M2M when no user is on requestContext', async () => {
        const fetchSpy = mockApi();

        await executeTool({ challengeId: CHALLENGE_UUID, role: 'registrants' }, undefined);

        const resourcesCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/resources'));
        const [, init] = resourcesCall as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-m2m-token');
    });
});

describe('fetchChallengeResourcesTool — RBAC', () => {
    it('denies callers without administrator or Talent Manager', async () => {
        mockApi();

        await expect(
            executeTool({ challengeId: CHALLENGE_UUID, role: 'copilot' }, memberUser(['copilot'])),
        ).rejects.toBeInstanceOf(ToolAccessDeniedError);
    });

    it('allows Talent Manager callers through RBAC', async () => {
        mockApi();

        await expect(
            executeTool({ challengeId: CHALLENGE_UUID, role: 'copilot' }, memberUser(['Talent Manager'])),
        ).resolves.toMatchObject({ role: 'copilot' });
    });
});
