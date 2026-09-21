import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MASTRA_AUTH_TOKEN_KEY } from '@mastra/core/request-context';
import { ToolAccessDeniedError } from '../../../utils/auth/access-control';
import {
    fetchMemberInsightsTool,
    mergeAndCapHistory,
    normalizeTrack,
    reduceSkills,
    unwrapMemberStatsPayload,
} from './fetch-member-insights-tool';

const { m2mTokenMock } = vi.hoisted(() => ({
    m2mTokenMock: vi.fn(),
}));

vi.mock('../../../utils/auth/m2m.service', () => ({
    M2MService: class MockM2MService {
        getM2MToken = m2mTokenMock;
    },
}));

const ROLES_CLAIM = 'https://topcoder.com/roles';
const USERID_CLAIM = 'https://topcoder.com/userId';
const HANDLE = 'Ghostar';
const USER_ID = '151743';

const MOCK_PROFILE = {
    userId: USER_ID,
    handle: HANDLE,
    handleLower: 'ghostar',
    status: 'ACTIVE',
    verified: true,
    tracks: ['DEVELOP', 'DESIGN'],
    email: 'ghost@example.com',
    phones: [{ type: 'mobile', number: '+610479187242' }],
    skills: [
        {
            id: 's1',
            name: 'React',
            category: { name: 'Frameworks' },
            displayMode: { name: 'principal' },
            levels: [{ name: 'verified' }],
        },
        {
            id: 's2',
            name: 'Node',
            category: { name: 'Frameworks' },
            displayMode: { name: 'additional' },
            levels: [{ name: 'self-declared' }],
        },
    ],
};

const MOCK_STATS = {
    challenges: 100,
    wins: 50,
    DEVELOP: {
        challenges: 80,
        wins: 40,
        subTracks: [{ id: 'Task', name: 'Task', challenges: 80, wins: 40 }],
    },
    DATA_SCIENCE: {
        challenges: 20,
        wins: 10,
        Challenge: { id: 'Challenge', name: 'Challenge', challenges: 15, wins: 8 },
        SRM: { id: 'SRM', name: 'SRM', challenges: 5, wins: 2 },
    },
};

const MOCK_ROLES = {
    copilot: { challengeCount: 25 },
    reviewer: { challengeCount: 10 },
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

interface MockOptions {
    profileStatus?: number;
    userIdRows?: { handle: string }[];
    roleChallenges?: Record<string, unknown>;
    history?: unknown;
}

function mockMembersApi(options: MockOptions = {}) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);

        if (url.includes('/members?userId=')) {
            const rows = options.userIdRows ?? [{ handle: HANDLE }];
            return { ok: true, status: 200, json: async () => rows } as Response;
        }

        if (url.match(/\/members\/[^/]+\/stats\/roles\/copilot\/challenges/)) {
            return {
                ok: true,
                status: 200,
                json: async () =>
                    options.roleChallenges ?? {
                        role: 'copilot',
                        total: 25,
                        trackCounts: { DEVELOPMENT: 20 },
                        fulfillment: { completed: 20, cancelled: 5, total: 25, rate: 80 },
                        challenges: Array.from({ length: 25 }, (_, i) => ({
                            id: `c-${i}`,
                            name: `Challenge ${i}`,
                            status: 'COMPLETED',
                            track: 'DEVELOPMENT',
                            type: 'CH',
                            startDate: '2020-01-01',
                            endDate: '2020-02-01',
                            resourceCreatedAt: `2020-01-0${(i % 9) + 1}`,
                        })),
                    },
            } as Response;
        }

        if (url.match(/\/members\/[^/]+\/stats\/roles\/reviewer\/challenges/)) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    role: 'reviewer',
                    total: 10,
                    trackCounts: null,
                    fulfillment: null,
                    challenges: Array.from({ length: 10 }, (_, i) => ({
                        id: `r-${i}`,
                        name: `Review ${i}`,
                        status: 'COMPLETED',
                        track: 'DEVELOPMENT',
                        type: 'CH',
                        startDate: '2020-01-01',
                        endDate: '2020-02-01',
                        resourceCreatedAt: '2020-01-01',
                    })),
                }),
            } as Response;
        }

        if (url.includes('/stats/history')) {
            return {
                ok: true,
                status: 200,
                json: async () =>
                    options.history ?? {
                        DEVELOP: {
                            subTracks: [
                                {
                                    id: 'Task',
                                    name: 'Task',
                                    history: Array.from({ length: 15 }, (_, i) => ({
                                        challengeId: `d-${i}`,
                                        challengeName: `Dev ${i}`,
                                        placement: 1,
                                        ratingDate: `2024-01-${String(i + 1).padStart(2, '0')}`,
                                        mostRecent: i === 14,
                                    })),
                                },
                            ],
                        },
                        DESIGN: {
                            subTracks: [
                                {
                                    id: 'Logo',
                                    name: 'Logo',
                                    history: Array.from({ length: 10 }, (_, i) => ({
                                        challengeId: `ds-${i}`,
                                        challengeName: `Design ${i}`,
                                        placement: 2,
                                        ratingDate: `2023-12-${String(i + 1).padStart(2, '0')}`,
                                        mostRecent: false,
                                    })),
                                },
                            ],
                        },
                    },
            } as Response;
        }

        if (url.includes('/stats/roles') && !url.includes('/challenges')) {
            return { ok: true, status: 200, json: async () => MOCK_ROLES } as Response;
        }

        if (url.includes('/stats') && !url.includes('/roles') && !url.includes('/history')) {
            return { ok: true, status: 200, json: async () => MOCK_STATS } as Response;
        }

        if (url.includes('/members/')) {
            return {
                ok: options.profileStatus === undefined || options.profileStatus < 400,
                status: options.profileStatus ?? 200,
                json: async () =>
                    options.profileStatus === 404
                        ? { message: `Member with handle: "${HANDLE}" doesn't exist` }
                        : MOCK_PROFILE,
            } as Response;
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
    });
}

async function executeTool(
    input: Record<string, unknown>,
    user: Record<string, unknown> = memberUser(['administrator']),
) {
    return fetchMemberInsightsTool.execute?.(input, buildContext(user)) as Promise<any>;
}

beforeEach(() => {
    vi.clearAllMocks();
    m2mTokenMock.mockResolvedValue('fake-m2m-token');
    process.env.TC_API_BASE = 'https://api.topcoder.com';
    delete process.env.DISABLE_AUTH;
});

describe('fetchMemberInsightsTool — mappers', () => {
    it('normalizes DATA_SCIENCE object-key subtracks into subTracks array', () => {
        const normalized = normalizeTrack(MOCK_STATS.DATA_SCIENCE as Record<string, unknown>);
        expect(normalized.subTracks).toHaveLength(2);
        expect(normalized.subTracks.map((s) => s.id).sort()).toEqual(['Challenge', 'SRM']);
    });

    it('reduces skills to principal list and counts', () => {
        const reduced = reduceSkills(MOCK_PROFILE.skills as any);
        expect(reduced.principal).toHaveLength(1);
        expect(reduced.principal[0].name).toBe('React');
        expect(reduced.totalCount).toBe(2);
        expect(reduced.verifiedCount).toBe(1);
        expect(reduced.additionalCount).toBe(1);
    });

    it('unwrapMemberStatsPayload picks stats object from API array response', () => {
        const wrapped = [
            {
                userId: 151743,
                groupId: 10,
                handle: 'Ghostar',
                challenges: 1076,
                wins: 226,
                DEVELOP: { challenges: 531, wins: 113, subTracks: [] },
            },
        ];
        const unwrapped = unwrapMemberStatsPayload(wrapped);
        expect(unwrapped.challenges).toBe(1076);
        expect(unwrapped.wins).toBe(226);
        expect((unwrapped.DEVELOP as { challenges: number }).challenges).toBe(531);
    });

    it('mergeAndCapHistory sorts newest-first and caps at 20 with totalEntries', () => {
        const merged = mergeAndCapHistory({
            DEVELOP: {
                subTracks: [
                    {
                        id: 'Task',
                        name: 'Task',
                        history: [
                            { challengeId: '1', challengeName: 'A', placement: 1, ratingDate: '2020-01-01' },
                            { challengeId: '2', challengeName: 'B', placement: 1, ratingDate: '2024-06-01' },
                        ],
                    },
                ],
            },
            DESIGN: {
                subTracks: [
                    {
                        id: 'Logo',
                        name: 'Logo',
                        history: Array.from({ length: 25 }, (_, i) => ({
                            challengeId: `x-${i}`,
                            challengeName: `X ${i}`,
                            placement: 1,
                            ratingDate: `2024-02-${String((i % 28) + 1).padStart(2, '0')}`,
                        })),
                    },
                ],
            },
        });

        expect(merged!.totalEntries).toBe(27);
        expect(merged!.truncated).toBe(true);
        expect(merged!.entries).toHaveLength(20);
        expect(merged!.entries[0].ratingDate).toBe('2024-06-01');
    });
});

describe('fetchMemberInsightsTool — base call', () => {
    it('maps activity when /stats returns a JSON array (live API shape)', async () => {
        const fetchSpy = mockMembersApi();
        fetchSpy.mockImplementation(async (input) => {
            const url = String(input);
            if (url.includes('/stats') && !url.includes('/roles') && !url.includes('/history')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => [{ ...MOCK_STATS, userId: USER_ID, groupId: 10, handle: HANDLE }],
                } as Response;
            }
            if (url.includes('/stats/roles') && !url.includes('/challenges')) {
                return { ok: true, status: 200, json: async () => MOCK_ROLES } as Response;
            }
            if (url.includes('/members/') && !url.includes('/stats')) {
                return { ok: true, status: 200, json: async () => MOCK_PROFILE } as Response;
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        });

        const result = await executeTool({ handle: HANDLE });
        expect(result.activity.totalChallenges).toBe(100);
        expect(result.activity.tracks.DEVELOP).toBeDefined();
    });

    it('omits null profile fields so output schema validation passes', async () => {
        const fetchSpy = mockMembersApi();
        fetchSpy.mockImplementation(async (input) => {
            const url = String(input);
            if (url.includes('/members/') && !url.includes('/stats')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        ...MOCK_PROFILE,
                        photoURL: null,
                        maxRating: null,
                        email: null,
                    }),
                } as Response;
            }
            if (url.includes('/stats') && !url.includes('/roles') && !url.includes('/history')) {
                return { ok: true, status: 200, json: async () => MOCK_STATS } as Response;
            }
            if (url.includes('/stats/roles') && !url.includes('/challenges')) {
                return { ok: true, status: 200, json: async () => MOCK_ROLES } as Response;
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        });

        const result = await executeTool({ handle: 'sidtester9' });
        expect(result.member.photoURL).toBeUndefined();
        expect(result.member.maxRating).toBeUndefined();
        expect(result.member.email).toBeUndefined();
    });

    it('returns empty activity when /stats is 404 but profile and roles exist', async () => {
        const fetchSpy = mockMembersApi();
        fetchSpy.mockImplementation(async (input) => {
            const url = String(input);
            if (url.includes('/stats') && !url.includes('/roles') && !url.includes('/history')) {
                return {
                    ok: false,
                    status: 404,
                    json: async () => ({ message: 'Member stats not found' }),
                } as Response;
            }
            if (url.includes('/stats/roles') && !url.includes('/challenges')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ copilot: { challengeCount: 19 } }),
                } as Response;
            }
            if (url.includes('/members/') && !url.includes('/stats')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        ...MOCK_PROFILE,
                        handle: 'himanicodes',
                        handleLower: 'himanicodes',
                        photoURL: null,
                        maxRating: null,
                    }),
                } as Response;
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        });

        const result = await executeTool({ handle: 'himanicodes' });
        expect(result.member.handle).toBe('himanicodes');
        expect(result.activity.totalChallenges).toBe(0);
        expect(result.activity.totalWins).toBe(0);
        expect(Object.keys(result.activity.tracks)).toHaveLength(0);
        expect(result.specialRoles.copilot?.challengeCount).toBe(19);
    });

    it('returns combined profile, activity, and specialRoles for handle', async () => {
        mockMembersApi();
        const result = await executeTool({ handle: HANDLE });

        expect(result.member.handle).toBe(HANDLE);
        expect(result.member.email).toBe('ghost@example.com');
        expect(result.member.phones?.[0].number).toBe('+610479187242');
        expect(result.activity.totalChallenges).toBe(100);
        expect(result.activity.tracks.DATA_SCIENCE.subTracks).toHaveLength(2);
        expect(result.specialRoles.copilot?.challengeCount).toBe(25);
    });

    it('resolves userId to handle and returns equivalent member data', async () => {
        const fetchSpy = mockMembersApi();
        const byUserId = await executeTool({ userId: USER_ID });
        expect(byUserId.member.handle).toBe(HANDLE);
        expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/members?userId='))).toBe(
            true,
        );

        vi.clearAllMocks();
        m2mTokenMock.mockResolvedValue('fake-m2m-token');
        mockMembersApi();
        const byHandle = await executeTool({ handle: HANDLE });
        expect(byHandle.member.userId).toBe(byUserId.member.userId);
    });

    it('prefers handle over userId when both are given', async () => {
        const fetchSpy = mockMembersApi();
        await executeTool({ handle: HANDLE, userId: USER_ID });
        expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/members?userId='))).toBe(
            false,
        );
    });

    it('throws a clear error when member is not found', async () => {
        mockMembersApi({ profileStatus: 404 });
        await expect(executeTool({ handle: 'unknown-handle' })).rejects.toThrow(/doesn't exist|not found/i);
    });
});

describe('fetchMemberInsightsTool — role challenges', () => {
    it('returns capped copilot role challenges with trackCounts and fulfillment', async () => {
        mockMembersApi();
        const result = await executeTool({ handle: HANDLE, role: 'copilot' });

        expect(result.roleChallenges.total).toBe(25);
        expect(result.roleChallenges.truncated).toBe(true);
        expect(result.roleChallenges.challenges).toHaveLength(20);
        expect(result.roleChallenges.trackCounts).toEqual({ DEVELOPMENT: 20 });
        expect(result.roleChallenges.fulfillment?.rate).toBe(80);
    });

    it('omits trackCounts and fulfillment for reviewer role', async () => {
        mockMembersApi();
        const result = await executeTool({ handle: HANDLE, role: 'reviewer' });

        expect(result.roleChallenges.trackCounts).toBeUndefined();
        expect(result.roleChallenges.fulfillment).toBeUndefined();
        expect(result.roleChallenges.challenges).toHaveLength(10);
        expect(result.roleChallenges.truncated).toBe(false);
    });

    it('skips role challenges upstream call when specialRoles count is zero', async () => {
        const fetchSpy = mockMembersApi();
        fetchSpy.mockImplementation(async (input) => {
            const url = String(input);
            if (url.includes('/stats/roles') && !url.includes('/challenges')) {
                return { ok: true, status: 200, json: async () => ({ reviewer: { challengeCount: 0 } }) } as Response;
            }
            if (url.includes('/stats/roles/reviewer/challenges')) {
                throw new Error('role challenges should not be called');
            }
            if (url.includes('/stats') && !url.includes('/roles')) {
                return { ok: true, status: 200, json: async () => MOCK_STATS } as Response;
            }
            if (url.includes('/members/') && !url.includes('/stats')) {
                return { ok: true, status: 200, json: async () => MOCK_PROFILE } as Response;
            }
            throw new Error(`Unexpected: ${url}`);
        });

        const result = await executeTool({ handle: HANDLE, role: 'reviewer' });
        expect(result.roleChallenges).toEqual({
            role: 'reviewer',
            total: 0,
            truncated: false,
            challenges: [],
        });
        expect(
            fetchSpy.mock.calls.some(([url]) => String(url).includes('/stats/roles/reviewer/challenges')),
        ).toBe(false);
    });
});

describe('fetchMemberInsightsTool — history', () => {
    it('returns merged history capped at 20 with totalEntries', async () => {
        mockMembersApi();
        const result = await executeTool({ handle: HANDLE, includeHistory: true });

        expect(result.history!.totalEntries).toBe(25);
        expect(result.history!.truncated).toBe(true);
        expect(result.history!.entries).toHaveLength(20);
    });

    it('passes trackId filter to history URL', async () => {
        const fetchSpy = mockMembersApi();
        await executeTool({ handle: HANDLE, includeHistory: true, trackId: 'DEVELOP' });
        expect(
            fetchSpy.mock.calls.some(([url]) =>
                String(url).includes('/stats/history') && String(url).includes('trackId=DEVELOP'),
            ),
        ).toBe(true);
    });
});

describe('fetchMemberInsightsTool — shouldForceM2M', () => {
    it('forwards requestor token for administrator', async () => {
        const fetchSpy = mockMembersApi();
        await executeTool({ handle: HANDLE }, memberUser(['administrator']));
        const profileCall = fetchSpy.mock.calls.find(([url]) =>
            String(url).match(/\/members\/Ghostar(\?|$)/),
        );
        const [, init] = profileCall as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-requestor-token');
        expect(m2mTokenMock).not.toHaveBeenCalled();
    });

    it('uses M2M token for Talent Manager without administrator', async () => {
        const fetchSpy = mockMembersApi();
        await executeTool({ handle: HANDLE }, memberUser(['Talent Manager']));
        const profileCall = fetchSpy.mock.calls.find(([url]) =>
            String(url).match(/\/members\/Ghostar(\?|$)/),
        );
        const [, init] = profileCall as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-m2m-token');
    });
});

describe('fetchMemberInsightsTool — RBAC', () => {
    it('denies callers without administrator or Talent Manager before execute', async () => {
        const fetchSpy = mockMembersApi();
        await expect(
            fetchMemberInsightsTool.execute?.({ handle: HANDLE }, buildContext(memberUser(['copilot']))),
        ).rejects.toBeInstanceOf(ToolAccessDeniedError);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('denies M2M callers with no matching scopes', async () => {
        const fetchSpy = mockMembersApi();
        const m2mUser = { sub: 'client@clients', scope: 'some:other:scope' };
        await expect(
            fetchMemberInsightsTool.execute?.({ handle: HANDLE }, buildContext(m2mUser)),
        ).rejects.toBeInstanceOf(ToolAccessDeniedError);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
