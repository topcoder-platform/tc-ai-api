import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MASTRA_AUTH_TOKEN_KEY } from '@mastra/core/request-context';

const { m2mTokenMock, resolveSkillTermsMock } = vi.hoisted(() => ({
    m2mTokenMock: vi.fn(),
    resolveSkillTermsMock: vi.fn(),
}));

vi.mock('../../../utils/auth/m2m.service', () => ({
    M2MService: class MockM2MService {
        getM2MToken = m2mTokenMock;
    },
}));

vi.mock('../skills/skill-term-resolver', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../skills/skill-term-resolver')>();
    return {
        ...actual,
        resolveSkillTerms: resolveSkillTermsMock,
    };
});

import { searchMembersTool } from './search-members-tool';
import { ToolAccessDeniedError } from '../../../utils/auth/access-control';
import { convertCountries, convertCountryToAlpha3 } from './search-members-tool';

const ROLES_CLAIM = 'https://topcoder.com/roles';
const REACT_ID = '4458454c-9a97-4332-a545-6546e240dab6';
const SFDC_ID = 'c8670c34-1020-4255-9296-6ea4fb8893e1';

const SAMPLE_B_MEMBER = {
    id: '401',
    handle: 'codebump',
    name: 'codebump',
    isRecentlyActive: true,
    isVerified: false,
    openToWork: true,
    isCopilot: true,
    location: 'Bengaluru, India',
    matchIndex: 34,
    matchedSkills: [{ id: REACT_ID, name: 'React.js', isVerified: true, wins: 2, submitted: 3 }],
};

function adminContext() {
    return {
        mastra: undefined,
        requestContext: {
            get: (key: string) => {
                if (key === MASTRA_AUTH_TOKEN_KEY) return 'admin-jwt';
                if (key === 'user') {
                    return { sub: 'auth0|1', 'https://topcoder.com/userId': '1', [ROLES_CLAIM]: ['administrator'] };
                }
                return undefined;
            },
        },
    } as any;
}

function talentManagerContext() {
    return {
        mastra: undefined,
        requestContext: {
            get: (key: string) => {
                if (key === MASTRA_AUTH_TOKEN_KEY) return 'tm-jwt';
                if (key === 'user') {
                    return { sub: 'auth0|2', 'https://topcoder.com/userId': '2', [ROLES_CLAIM]: ['Talent Manager'] };
                }
                return undefined;
            },
        },
    } as any;
}

function memberContext() {
    return {
        mastra: undefined,
        requestContext: {
            get: (key: string) => {
                if (key === MASTRA_AUTH_TOKEN_KEY) return 'member-jwt';
                if (key === 'user') {
                    return { sub: 'auth0|3', 'https://topcoder.com/userId': '3', [ROLES_CLAIM]: ['member'] };
                }
                return undefined;
            },
        },
    } as any;
}

describe('country conversion', () => {
    it('converts US, USA, United States, IN, IND, India to alpha-3', () => {
        expect(convertCountryToAlpha3('US')).toBe('USA');
        expect(convertCountryToAlpha3('USA')).toBe('USA');
        expect(convertCountryToAlpha3('United States')).toBe('USA');
        expect(convertCountryToAlpha3('in')).toBe('IND');
        expect(convertCountryToAlpha3('IND')).toBe('IND');
        expect(convertCountryToAlpha3('India')).toBe('IND');
    });

    it('reports unrecognized countries separately', () => {
        const { alpha3, unrecognized } = convertCountries(['India', 'Atlantis']);
        expect(alpha3).toEqual(['IND']);
        expect(unrecognized).toEqual(['Atlantis']);
    });
});

describe('searchMembersTool', () => {
    beforeEach(() => {
        m2mTokenMock.mockReset();
        resolveSkillTermsMock.mockReset();
    });

    it('denies members without administrator or Talent Manager role', async () => {
        await expect(
            searchMembersTool.execute?.({ copilot: true }, memberContext()),
        ).rejects.toBeInstanceOf(ToolAccessDeniedError);
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it('rejects input with no filters via schema refine', async () => {
        const result = await searchMembersTool.execute?.({}, adminContext());
        expect(result).toMatchObject({ error: true });
        expect(String((result as { message?: string }).message)).toMatch(/at least one filter/i);
    });

    it('does not call upstream when skills are ambiguous', async () => {
        resolveSkillTermsMock.mockResolvedValue([
            {
                input: 'salesforce',
                status: 'ambiguous',
                candidates: [{ id: SFDC_ID, name: 'Salesforce Development (SFDC)' }],
            },
        ]);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const result = await searchMembersTool.execute?.(
            { skills: [{ skill: 'salesforce' }] },
            adminContext(),
        );

        expect(result?.searched).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(m2mTokenMock).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it('searches with resolved skills and maps Sample B filters (admin, no M2M)', async () => {
        resolveSkillTermsMock.mockResolvedValue([
            {
                input: REACT_ID,
                status: 'resolved',
                id: REACT_ID,
                name: 'React.js',
                matchedBy: 'id',
                minWins: 1,
            },
            {
                input: SFDC_ID,
                status: 'resolved',
                id: SFDC_ID,
                name: 'Salesforce Development (SFDC)',
                matchedBy: 'id',
                minWins: 1,
            },
        ]);

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            if (url.includes('/member/search')) {
                expect(init?.method).toBe('POST');
                const body = JSON.parse(String(init?.body));
                expect(body).toMatchObject({
                    skillSearchType: 'OR',
                    countries: ['IND'],
                    copilot: true,
                    recentlyActive: true,
                    skills: [{ id: REACT_ID, wins: 1 }, { id: SFDC_ID, wins: 1 }],
                });
                const auth = (init as RequestInit)?.headers
                    ? new Headers(init.headers as HeadersInit).get('Authorization')
                    : undefined;
                expect(auth).toBe('Bearer admin-jwt');

                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        total: 6,
                        page: 1,
                        limit: 10,
                        data: [SAMPLE_B_MEMBER],
                    }),
                } as Response;
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const result = await searchMembersTool.execute?.(
            {
                skills: [{ skill: REACT_ID, minWins: 1 }, { skill: SFDC_ID, minWins: 1 }],
                skillMatch: 'any',
                countries: ['India'],
                copilot: true,
                recentlyActive: true,
            },
            adminContext(),
        );

        expect(result?.searched).toBe(true);
        expect(result?.total).toBe(6);
        expect(result?.members[0]?.handle).toBe('codebump');
        expect(result?.members[0]?.matchedSkills[0]?.meetsMinWins).toBe(true);
        expect(result?.minWinsEnforced).toBe(false);
        expect(m2mTokenMock).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it('allows Talent Manager with requestor token only', async () => {
        resolveSkillTermsMock.mockResolvedValue([]);
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ total: 40, page: 1, limit: 10, data: [] }),
        } as Response);

        await searchMembersTool.execute?.({ copilot: true, recentlyActive: true }, talentManagerContext());

        expect(m2mTokenMock).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it('maps 403 to a clear permission message', async () => {
        resolveSkillTermsMock.mockResolvedValue([]);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({}),
        } as Response);

        await expect(searchMembersTool.execute?.({ copilot: true }, adminContext())).rejects.toThrow(
            /not permitted to use member search/i,
        );
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it('sets rankedBy activity for preferredRoles without skills', async () => {
        resolveSkillTermsMock.mockResolvedValue([]);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ total: 0, page: 1, limit: 10, data: [] }),
        } as Response);

        const result = await searchMembersTool.execute?.(
            { preferredRoles: ['DEVOPS_SRE'] },
            adminContext(),
        );
        expect(result?.rankedBy).toBe('activity');
    });

    it('searches with valid skills when another skill is unresolved', async () => {
        resolveSkillTermsMock.mockResolvedValue([
            {
                input: 'xyzzy',
                status: 'unresolved',
                reason: 'No matching Topcoder skill',
            },
            {
                input: 'react',
                status: 'resolved',
                id: REACT_ID,
                name: 'React.js',
                matchedBy: 'alias',
            },
        ]);
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ total: 1, page: 1, limit: 10, data: [] }),
        } as Response);

        const result = await searchMembersTool.execute?.(
            { skills: [{ skill: 'xyzzy' }, { skill: 'react' }] },
            adminContext(),
        );

        expect(result?.searched).toBe(true);
        expect(result?.appliedFilters?.skills).toEqual([{ id: REACT_ID, name: 'React.js' }]);
        fetchSpy.mockRestore();
    });

    it('does not search when every country is unrecognized', async () => {
        resolveSkillTermsMock.mockResolvedValue([]);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const result = await searchMembersTool.execute?.(
            { countries: ['Atlantis'], copilot: true },
            adminContext(),
        );

        expect(result?.searched).toBe(false);
        expect(result?.message).toMatch(/countries were recognized/i);
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it('denies M2M callers at RBAC before any upstream call', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const m2mContext = {
            mastra: undefined,
            requestContext: {
                get: (key: string) => {
                    if (key === MASTRA_AUTH_TOKEN_KEY) return 'm2m-token';
                    if (key === 'user') return { sub: 'client@clients', scope: 'some:other:scope' };
                    return undefined;
                },
            },
        } as any;

        await expect(searchMembersTool.execute?.({ copilot: true }, m2mContext)).rejects.toBeInstanceOf(
            ToolAccessDeniedError,
        );
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(m2mTokenMock).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });
});
