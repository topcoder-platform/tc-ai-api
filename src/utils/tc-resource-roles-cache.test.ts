import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MASTRA_AUTH_TOKEN_KEY } from '@mastra/core/request-context';

const { m2mTokenMock } = vi.hoisted(() => ({
    m2mTokenMock: vi.fn(),
}));

vi.mock('./auth/m2m.service', () => ({
    M2MService: class MockM2MService {
        getM2MToken = m2mTokenMock;
    },
}));

import { resolveCategoryRoleIds, resetResourceRolesCacheForTests } from './tc-resource-roles-cache';

const ROLES_URL = 'https://api.example.com/v6/resource-roles';

const MOCK_ROLES = [
    { id: 'copilot-id', name: 'Copilot' },
    { id: 'reviewer-id', name: 'Reviewer' },
    { id: 'iterative-reviewer-id', name: 'Iterative Reviewer' },
    { id: 'submitter-id', name: 'Submitter' },
    { id: 'manager-id', name: 'Manager' },
    { id: 'observer-id', name: 'Observer' },
];

function requestContext() {
    return {
        get: (key: string) => (key === MASTRA_AUTH_TOKEN_KEY ? 'fake-token' : undefined),
    } as any;
}

function mockRolesFetch(roles: typeof MOCK_ROLES = MOCK_ROLES, status = 200) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: status < 400,
        status,
        json: async () => roles,
    } as Response);
}

beforeEach(() => {
    vi.clearAllMocks();
    resetResourceRolesCacheForTests();
    m2mTokenMock.mockResolvedValue('fake-m2m-token');
    process.env.TC_API_BASE = 'https://api.example.com';
});

describe('resolveCategoryRoleIds', () => {
    it('resolves a category to the expected role id set', async () => {
        mockRolesFetch();

        const ids = await resolveCategoryRoleIds('copilot', ['Copilot'], requestContext());

        expect(ids).toEqual(new Set(['copilot-id']));
    });

    it('resolves multiple role names for a category', async () => {
        mockRolesFetch();

        const ids = await resolveCategoryRoleIds(
            'reviewers',
            ['Reviewer', 'Iterative Reviewer'],
            requestContext(),
        );

        expect(ids).toEqual(new Set(['reviewer-id', 'iterative-reviewer-id']));
    });

    it('throws with an actionable message when a configured role name is missing upstream', async () => {
        mockRolesFetch([{ id: 'copilot-id', name: 'Copilot' }]);

        await expect(
            resolveCategoryRoleIds('reviewers', ['Reviewer'], requestContext()),
        ).rejects.toThrow(/Resource role "Reviewer" \(category "reviewers"\) not found/);
    });

    it('shares one fetch across concurrent callers before the first resolves', async () => {
        const fetchSpy = mockRolesFetch();

        const [a, b] = await Promise.all([
            resolveCategoryRoleIds('copilot', ['Copilot'], requestContext()),
            resolveCategoryRoleIds('registrants', ['Submitter'], requestContext()),
        ]);

        expect(a).toEqual(new Set(['copilot-id']));
        expect(b).toEqual(new Set(['submitter-id']));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0]?.[0]).toBe(ROLES_URL);
    });

    it('retries after a failed fetch instead of permanently caching the failure', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => MOCK_ROLES,
            } as Response);

        await expect(
            resolveCategoryRoleIds('copilot', ['Copilot'], requestContext()),
        ).rejects.toThrow(/Failed to fetch resource roles \(HTTP 503\)/);

        const ids = await resolveCategoryRoleIds('copilot', ['Copilot'], requestContext());
        expect(ids).toEqual(new Set(['copilot-id']));
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
});
