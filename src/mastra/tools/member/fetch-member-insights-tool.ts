// Members API: GET /v6/members/* — profile, stats, special roles, optional history.
// See docs/adr/0006-member-insights-tool-for-challenge-search-agent.md.
import { createTool } from '@mastra/core/tools';
import {
    withAccessPolicy,
    toAuthenticatedCaller,
    callerHasAnyRole,
} from '../../../utils/auth/access-control';
import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';
import { callTcApi } from '../../../utils/tc-api-client';

const TOOL_ID = 'fetch-member-insights';
const MEMBERS_BASE_URL = `${process.env.TC_API_BASE}/v6/members`;
const ADMIN_ROLE = 'administrator';
const TALENT_MANAGER_ROLE = 'Talent Manager';
const HISTORY_CAP = 20;
const ROLE_CHALLENGES_CAP = 20;

const TRACK_STAT_KEYS = new Set(['DEVELOP', 'DESIGN', 'DATA_SCIENCE', 'QA']);
const STATS_TOP_LEVEL_KEYS = new Set(['challenges', 'wins', 'maxRating']);

const skillPrincipalSchema = z.object({
    id: z.string(),
    name: z.string(),
    category: z.string(),
});

const subTrackSchema = z.object({
    id: z.string(),
    name: z.string(),
    challenges: z.number(),
    wins: z.number().optional(),
    mostRecentSubmission: z.string().optional(),
    mostRecentEventDate: z.string().optional(),
    submissions: z.record(z.string(), z.number()).optional(),
    rank: z.record(z.string(), z.number()).optional(),
});

const memberInsightsOutputSchema = z.object({
    member: z.object({
        userId: z.string(),
        handle: z.string(),
        handleLower: z.string(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        status: z.string(),
        verified: z.boolean(),
        identityVerified: z.boolean().optional(),
        tracks: z.array(z.string()),
        description: z.string().optional(),
        homeCountryCode: z.string().optional(),
        competitionCountryCode: z.string().optional(),
        photoURL: z.string().optional(),
        email: z.string().optional(),
        phones: z.array(z.object({ type: z.string(), number: z.string() })).optional(),
        addresses: z
            .array(
                z.object({
                    streetAddr1: z.string().optional(),
                    streetAddr2: z.string().optional(),
                    city: z.string().optional(),
                    zip: z.string().optional(),
                    stateCode: z.string().optional(),
                    type: z.string().optional(),
                }),
            )
            .optional(),
        availableForGigs: z.boolean().optional(),
        loginCount: z.number().optional(),
        lastLoginDate: z.string().optional(),
        createdAt: z.string().optional(),
        maxRating: z
            .object({
                rating: z.number(),
                track: z.string(),
                subTrack: z.string(),
                ratingColor: z.string(),
            })
            .optional(),
        skills: z.object({
            principal: z.array(skillPrincipalSchema),
            totalCount: z.number(),
            verifiedCount: z.number(),
            additionalCount: z.number(),
        }),
    }),
    activity: z.object({
        totalChallenges: z.number(),
        totalWins: z.number(),
        tracks: z.record(
            z.string(),
            z.object({
                challenges: z.number(),
                wins: z.number(),
                mostRecentSubmission: z.string().optional(),
                mostRecentEventDate: z.string().optional(),
                subTracks: z.array(subTrackSchema),
            }),
        ),
    }),
    specialRoles: z.object({
        copilot: z.object({ challengeCount: z.number() }).optional(),
        reviewer: z.object({ challengeCount: z.number() }).optional(),
    }),
    roleChallenges: z
        .object({
            role: z.enum(['copilot', 'reviewer']),
            total: z.number(),
            truncated: z.boolean(),
            trackCounts: z.record(z.string(), z.number()).optional(),
            fulfillment: z
                .object({
                    completed: z.number(),
                    cancelled: z.number(),
                    total: z.number(),
                    rate: z.number(),
                })
                .optional(),
            challenges: z.array(
                z.object({
                    id: z.string(),
                    name: z.string(),
                    status: z.string(),
                    track: z.string(),
                    type: z.string(),
                    startDate: z.string(),
                    endDate: z.string(),
                    resourceCreatedAt: z.string(),
                }),
            ),
        })
        .optional(),
    history: z
        .object({
            trackId: z.string().optional(),
            totalEntries: z.number(),
            truncated: z.boolean(),
            entries: z.array(
                z.object({
                    challengeId: z.string(),
                    challengeName: z.string(),
                    track: z.string(),
                    subTrack: z.string(),
                    placement: z.number(),
                    ratingDate: z.string(),
                    mostRecent: z.boolean(),
                }),
            ),
        })
        .optional(),
});

export type MemberInsights = z.infer<typeof memberInsightsOutputSchema>;

interface RawSkill {
    id: string;
    name: string;
    category?: { name?: string } | string;
    displayMode?: { name?: string } | string;
    levels?: { name?: string }[];
}

interface ApiCallOptions {
    url: string;
    requestContext: RequestContext | undefined;
    forceM2M: boolean;
}

const inputSchema = z
    .object({
        handle: z
            .string()
            .optional()
            .describe(
                'Exact Topcoder member handle (case-insensitive), e.g. "Ghostar". Preferred over userId when both ' +
                    'are known — skips an extra lookup. Provide this or userId, never neither.',
            ),
        userId: z
            .union([z.string(), z.number()])
            .optional()
            .describe(
                'Numeric Topcoder member userId, e.g. from a challenge\'s "winners" array (fetch-challenge-by-id) ' +
                    'or a resource list (fetch-challenge-resources). Resolved to a handle automatically. Provide this ' +
                    'or handle, never neither.',
            ),
        role: z
            .enum(['copilot', 'reviewer'])
            .optional()
            .describe(
                'Only set this when the user specifically asks what challenges the member copiloted or reviewed. ' +
                    'Returns up to the 20 most recent (see output "truncated"/"total"). Omit for a general profile ' +
                    'question — the base response already says how many copilot/reviewer challenges the member has.',
            ),
        includeHistory: z
            .boolean()
            .optional()
            .describe(
                'Set true only when the user asks about the member\'s recent competition activity/history (as a ' +
                    'competitor, not copilot/reviewer) — e.g. "what has X worked on lately", "X\'s recent submissions". ' +
                    'Returns up to the 20 most recent entries across all tracks (see output "history.truncated").',
            ),
        trackId: z
            .enum(['DEVELOP', 'DESIGN', 'DATA_SCIENCE', 'QA'])
            .optional()
            .describe(
                'Only used together with includeHistory, to narrow history to one track. Note this uses the raw ' +
                    'track codes (DEVELOP/DESIGN/DATA_SCIENCE/QA) — NOT the same casing/wording as ' +
                    'challenge-vector-query\'s "track" filter ("Development"/"Design"/"Data Science"/"Quality ' +
                    'Assurance"). Omit unless the user names a specific track.',
            ),
    })
    .superRefine((data, ctx) => {
        const hasHandle = typeof data.handle === 'string' && data.handle.trim().length > 0;
        const hasUserId = data.userId !== undefined && String(data.userId).trim().length > 0;
        if (!hasHandle && !hasUserId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Provide either handle or userId',
            });
        }
    });

export const fetchMemberInsightsTool = withAccessPolicy(
    createTool({
        id: TOOL_ID,
        description:
            'Fetches a single Topcoder member\'s profile, performance stats, and Copilot/Reviewer special-role ' +
            'summary — everything needed to answer "who is this member" / "tell me about this member" questions. ' +
            'Takes exactly one member, by handle or userId. Does NOT resolve a member from a full name or ' +
            'partial text — the caller must already have an exact handle or numeric userId. Does NOT answer ' +
            '"who is on this challenge" questions (use fetch-challenge-resources for that) — this tool is ' +
            'member-centric, not challenge-centric. Optionally also fetches a specific role\'s full challenge ' +
            'history (role) or the member\'s recent challenge history (includeHistory) — both are on-demand ' +
            'because they can be very large for prolific members; omit them unless the user actually asked for ' +
            'that level of detail.',
        inputSchema,
        outputSchema: memberInsightsOutputSchema,
        execute: async (inputData, context) => {
            const logger = context.mastra?.getLogger?.();
            logger?.info('Fetching member insights: handle={handle} userId={userId}', {
                handle: inputData.handle,
                userId: inputData.userId,
            });
            return await fetchMemberInsights(inputData, context.requestContext);
        },
    }),
);

/**
 * Forward the requestor JWT for administrators and Talent Managers. Member-api
 * treats both as privileged for profile/stats (`SENSITIVE_DATA_ROLES` / admin).
 * Forcing service M2M for Talent Manager breaks when tc-ai-api M2M credentials
 * are unset or lack `read:user_profiles` — unlike Resources API (ADR 0005).
 */
function shouldForceM2M(requestContext: RequestContext | undefined): boolean {
    const user = requestContext?.get('user') as Record<string, unknown> | undefined;
    if (!user) {
        return true;
    }
    const { roles } = toAuthenticatedCaller(user);
    return !callerHasAnyRole(roles, [ADMIN_ROLE, TALENT_MANAGER_ROLE]);
}

function toIso(value: unknown): string | undefined {
    if (value == null || value === '') {
        return undefined;
    }
    if (typeof value === 'number') {
        return new Date(value).toISOString();
    }
    if (typeof value === 'string') {
        return value;
    }
    return undefined;
}

/** Upstream often sends explicit `null` for unset profile fields — omit those from tool output. */
function optionalString(value: unknown): string | undefined {
    if (value == null) {
        return undefined;
    }
    const s = String(value);
    return s.length > 0 ? s : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
    if (value == null) {
        return undefined;
    }
    return Boolean(value);
}

function optionalMaxRating(value: unknown): MemberInsights['member']['maxRating'] {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const r = value as Record<string, unknown>;
    if (r.rating == null || r.track == null || r.subTrack == null || r.ratingColor == null) {
        return undefined;
    }
    return {
        rating: Number(r.rating),
        track: String(r.track),
        subTrack: String(r.subTrack),
        ratingColor: String(r.ratingColor),
    };
}

function skillDisplayModeName(displayMode: RawSkill['displayMode']): string | undefined {
    if (typeof displayMode === 'string') {
        return displayMode;
    }
    return displayMode?.name;
}

function skillCategoryName(category: RawSkill['category']): string {
    if (typeof category === 'string') {
        return category;
    }
    return category?.name ?? '';
}

export function reduceSkills(skills: RawSkill[] | undefined): MemberInsights['member']['skills'] {
    const list = skills ?? [];
    const principal = list
        .filter((s) => skillDisplayModeName(s.displayMode) === 'principal')
        .map((s) => ({
            id: String(s.id),
            name: s.name,
            category: skillCategoryName(s.category),
        }));
    const verifiedCount = list.filter((s) =>
        (s.levels ?? []).some((l) => l.name === 'verified'),
    ).length;
    return {
        principal,
        totalCount: list.length,
        verifiedCount,
        additionalCount: list.length - principal.length,
    };
}

export function normalizeTrack(trackData: Record<string, unknown>): MemberInsights['activity']['tracks'][string] {
    const {
        challenges = 0,
        wins = 0,
        mostRecentSubmission,
        mostRecentEventDate,
        subTracks,
        ...rest
    } = trackData as {
        challenges?: number;
        wins?: number;
        mostRecentSubmission?: unknown;
        mostRecentEventDate?: unknown;
        subTracks?: unknown[];
        [key: string]: unknown;
    };

    const normalizedSubTracks = Array.isArray(subTracks)
        ? subTracks.map((st) => normalizeSubTrack(st as Record<string, unknown>))
        : Object.entries(rest)
              .filter(([key]) => !STATS_TOP_LEVEL_KEYS.has(key))
              .map(([id, v]) => normalizeSubTrack({ id, name: id, ...(v as Record<string, unknown>) }));

    return {
        challenges: Number(challenges) || 0,
        wins: Number(wins) || 0,
        mostRecentSubmission: toIso(mostRecentSubmission),
        mostRecentEventDate: toIso(mostRecentEventDate),
        subTracks: normalizedSubTracks,
    };
}

function normalizeSubTrack(st: Record<string, unknown>): z.infer<typeof subTrackSchema> {
    return {
        id: String(st.id ?? st.name ?? ''),
        name: String(st.name ?? st.id ?? ''),
        challenges: Number(st.challenges) || 0,
        wins: st.wins != null ? Number(st.wins) : undefined,
        mostRecentSubmission: toIso(st.mostRecentSubmission),
        mostRecentEventDate: toIso(st.mostRecentEventDate),
        submissions: st.submissions as Record<string, number> | undefined,
        rank: st.rank as Record<string, number> | undefined,
    };
}

/**
 * GET /members/{handle}/stats returns a JSON array (one object per group scope),
 * not a single object — see member-api StatisticsService.getMemberStats.
 */
export function unwrapMemberStatsPayload(stats: unknown): Record<string, unknown> {
    if (Array.isArray(stats)) {
        if (stats.length === 0) {
            return {};
        }
        const best = stats.reduce<Record<string, unknown>>((acc, row) => {
            if (!row || typeof row !== 'object') {
                return acc;
            }
            const candidate = row as Record<string, unknown>;
            const accChallenges = Number(acc.challenges) || 0;
            const rowChallenges = Number(candidate.challenges) || 0;
            return rowChallenges >= accChallenges ? candidate : acc;
        }, stats[0] as Record<string, unknown>);
        return best;
    }
    if (stats && typeof stats === 'object') {
        return stats as Record<string, unknown>;
    }
    return {};
}

function mapActivity(stats: Record<string, unknown>): MemberInsights['activity'] {
    const tracks: MemberInsights['activity']['tracks'] = {};
    for (const [key, value] of Object.entries(stats)) {
        if (!TRACK_STAT_KEYS.has(key) || typeof value !== 'object' || value == null) {
            continue;
        }
        tracks[key] = normalizeTrack(value as Record<string, unknown>);
    }
    return {
        totalChallenges: Number(stats.challenges) || 0,
        totalWins: Number(stats.wins) || 0,
        tracks,
    };
}

function mapSpecialRoles(roles: Record<string, { challengeCount?: number } | undefined>): MemberInsights['specialRoles'] {
    const out: MemberInsights['specialRoles'] = {};
    if (roles.copilot?.challengeCount != null && roles.copilot.challengeCount > 0) {
        out.copilot = { challengeCount: roles.copilot.challengeCount };
    }
    if (roles.reviewer?.challengeCount != null && roles.reviewer.challengeCount > 0) {
        out.reviewer = { challengeCount: roles.reviewer.challengeCount };
    }
    return out;
}

function mapProfile(profile: Record<string, unknown>): MemberInsights['member'] {
    const phonesRaw = profile.phones;
    const phones =
        phonesRaw == null || !Array.isArray(phonesRaw)
            ? undefined
            : (phonesRaw as MemberInsights['member']['phones']);
    const addressesRaw = profile.addresses;
    const addresses =
        addressesRaw == null || !Array.isArray(addressesRaw)
            ? undefined
            : (addressesRaw as MemberInsights['member']['addresses']);

    return {
        userId: String(profile.userId),
        handle: String(profile.handle),
        handleLower: String(profile.handleLower ?? profile.handle ?? '').toLowerCase(),
        firstName: optionalString(profile.firstName),
        lastName: optionalString(profile.lastName),
        status: String(profile.status ?? ''),
        verified: Boolean(profile.verified),
        identityVerified: optionalBoolean(profile.identityVerified),
        tracks: Array.isArray(profile.tracks) ? (profile.tracks as string[]) : [],
        description: optionalString(profile.description),
        homeCountryCode: optionalString(profile.homeCountryCode),
        competitionCountryCode: optionalString(profile.competitionCountryCode),
        photoURL: optionalString(profile.photoURL),
        email: optionalString(profile.email),
        phones,
        addresses,
        availableForGigs: optionalBoolean(profile.availableForGigs),
        loginCount: profile.loginCount == null ? undefined : Number(profile.loginCount),
        lastLoginDate: toIso(profile.lastLoginDate),
        createdAt: toIso(profile.createdAt),
        maxRating: optionalMaxRating(profile.maxRating),
        skills: reduceSkills(profile.skills as RawSkill[] | undefined),
    };
}

async function apiGet({ url, requestContext, forceM2M }: ApiCallOptions): Promise<Response> {
    return callTcApi({
        toolId: TOOL_ID,
        url,
        init: { method: 'GET', signal: AbortSignal.timeout(30_000) },
        requestContext,
        forceM2M,
    });
}

async function readJsonOrThrow(response: Response, context: string): Promise<unknown> {
    if (response.ok) {
        return response.json();
    }
    let detail = '';
    try {
        const body = (await response.json()) as { message?: string };
        if (body?.message) {
            detail = body.message;
        }
    } catch {
        // ignore parse errors
    }
    if (response.status === 404) {
        throw new Error(detail || `Member not found (${context})`);
    }
    throw new Error(
        detail || `Failed to fetch member insights (${context}, HTTP ${response.status})`,
    );
}

/** Member profile may exist while StatisticsService has no aggregate row — treat as empty activity. */
async function readMemberStatsJson(response: Response, handle: string): Promise<unknown> {
    if (response.status === 404) {
        return [];
    }
    return readJsonOrThrow(response, `stats for ${handle}`);
}

export async function resolveMemberHandle(
    input: { handle?: string; userId?: string | number },
    requestContext: RequestContext | undefined,
    forceM2M: boolean,
): Promise<string> {
    if (input.handle?.trim()) {
        return input.handle.trim();
    }
    const userId = String(input.userId);
    const url = `${MEMBERS_BASE_URL}?userId=${encodeURIComponent(userId)}`;
    const response = await apiGet({ url, requestContext, forceM2M });
    if (!response.ok) {
        await readJsonOrThrow(response, `userId ${userId}`);
    }
    const rows = (await response.json()) as { handle?: string }[];
    if (!Array.isArray(rows) || rows.length === 0 || !rows[0]?.handle) {
        throw new Error(`Member not found for userId ${userId}`);
    }
    return rows[0].handle;
}

interface HistoryRow {
    challengeId: string | number;
    challengeName: string;
    track: string;
    subTrack: string;
    placement: number;
    ratingDate: string;
    mostRecent: boolean;
}

export function mergeAndCapHistory(
    historyPayload: unknown,
    trackIdFilter?: string,
): MemberInsights['history'] {
    const rows: HistoryRow[] = [];

    if (historyPayload && typeof historyPayload === 'object' && !Array.isArray(historyPayload)) {
        for (const [trackKey, trackNode] of Object.entries(historyPayload as Record<string, unknown>)) {
            if (!TRACK_STAT_KEYS.has(trackKey)) {
                continue;
            }
            if (trackIdFilter && trackKey !== trackIdFilter) {
                continue;
            }
            if (!trackNode || typeof trackNode !== 'object') {
                continue;
            }

            const trackObj = trackNode as Record<string, unknown>;
            const subTracks: Record<string, unknown>[] = Array.isArray(trackObj.subTracks)
                ? (trackObj.subTracks as Record<string, unknown>[])
                : Object.entries(trackObj)
                      .filter(
                          ([key]) =>
                              ![
                                  'subTracks',
                                  'challenges',
                                  'wins',
                                  'mostRecentSubmission',
                                  'mostRecentEventDate',
                              ].includes(key),
                      )
                      .map(([id, value]) => ({
                          id,
                          name: id,
                          ...(value as Record<string, unknown>),
                      }));

            for (const st of subTracks) {
                const historyItems = st.history;
                if (!Array.isArray(historyItems)) {
                    continue;
                }
                for (const h of historyItems as Record<string, unknown>[]) {
                    rows.push({
                        challengeId: String(h.challengeId ?? ''),
                        challengeName: String(h.challengeName ?? ''),
                        track: trackKey,
                        subTrack: String(st.name ?? st.id ?? ''),
                        placement: Number(h.placement) || 0,
                        ratingDate: String(h.ratingDate ?? h.eventDate ?? h.date ?? ''),
                        mostRecent: Boolean(h.mostRecent),
                    });
                }
            }
        }
    }

    const sorted = [...rows].sort((a, b) => {
        const da = Date.parse(a.ratingDate) || 0;
        const db = Date.parse(b.ratingDate) || 0;
        return db - da;
    });

    const totalEntries = sorted.length;

    return {
        trackId: trackIdFilter,
        totalEntries,
        truncated: totalEntries > HISTORY_CAP,
        entries: sorted.slice(0, HISTORY_CAP),
    };
}

function capRoleChallenges(
    role: 'copilot' | 'reviewer',
    payload: Record<string, unknown>,
): MemberInsights['roleChallenges'] {
    const all = (payload.challenges as Record<string, unknown>[]) ?? [];
    const total = Number(payload.total) || all.length;
    const capped = all.slice(0, ROLE_CHALLENGES_CAP).map((c) => ({
        id: String(c.id),
        name: String(c.name),
        status: String(c.status),
        track: String(c.track),
        type: String(c.type),
        startDate: String(c.startDate ?? ''),
        endDate: String(c.endDate ?? ''),
        resourceCreatedAt: String(c.resourceCreatedAt ?? ''),
    }));

    const result: MemberInsights['roleChallenges'] = {
        role,
        total,
        truncated: total > capped.length,
        challenges: capped,
    };

    if (role === 'copilot') {
        if (payload.trackCounts && typeof payload.trackCounts === 'object') {
            result.trackCounts = payload.trackCounts as Record<string, number>;
        }
        if (payload.fulfillment && typeof payload.fulfillment === 'object') {
            result.fulfillment = payload.fulfillment as NonNullable<
                MemberInsights['roleChallenges']
            >['fulfillment'];
        }
    }

    return result;
}

async function fetchMemberInsights(
    input: z.infer<typeof inputSchema>,
    requestContext: RequestContext | undefined,
): Promise<MemberInsights> {
    const forceM2M = shouldForceM2M(requestContext);
    const handle = await resolveMemberHandle(input, requestContext, forceM2M);
    const encodedHandle = encodeURIComponent(handle);

    const [profileRes, statsRes, rolesRes] = await Promise.all([
        apiGet({ url: `${MEMBERS_BASE_URL}/${encodedHandle}`, requestContext, forceM2M }),
        apiGet({ url: `${MEMBERS_BASE_URL}/${encodedHandle}/stats`, requestContext, forceM2M }),
        apiGet({ url: `${MEMBERS_BASE_URL}/${encodedHandle}/stats/roles`, requestContext, forceM2M }),
    ]);

    const [profile, stats, rolesRaw] = await Promise.all([
        readJsonOrThrow(profileRes, `handle ${handle}`),
        readMemberStatsJson(statsRes, handle),
        readJsonOrThrow(rolesRes, `special roles for ${handle}`),
    ]);

    const specialRoles = mapSpecialRoles(rolesRaw as Record<string, { challengeCount?: number }>);

    const statsRecord = unwrapMemberStatsPayload(stats);
    const member = mapProfile(profile as Record<string, unknown>);
    if (!member.maxRating) {
        const fromStats = optionalMaxRating(statsRecord.maxRating);
        if (fromStats) {
            member.maxRating = fromStats;
        }
    }

    const result: MemberInsights = {
        member,
        activity: mapActivity(statsRecord),
        specialRoles,
    };

    if (input.role) {
        const roleCount = specialRoles[input.role]?.challengeCount ?? 0;
        if (roleCount === 0) {
            result.roleChallenges = {
                role: input.role,
                total: 0,
                truncated: false,
                challenges: [],
            };
        } else {
            const roleRes = await apiGet({
                url: `${MEMBERS_BASE_URL}/${encodedHandle}/stats/roles/${input.role}/challenges`,
                requestContext,
                forceM2M,
            });
            const rolePayload = (await readJsonOrThrow(
                roleRes,
                `${input.role} challenges for ${handle}`,
            )) as Record<string, unknown>;
            result.roleChallenges = capRoleChallenges(input.role, rolePayload);
        }
    }

    if (input.includeHistory) {
        let historyUrl = `${MEMBERS_BASE_URL}/${encodedHandle}/stats/history`;
        if (input.trackId) {
            historyUrl += `?trackId=${encodeURIComponent(input.trackId)}`;
        }
        const historyRes = await apiGet({ url: historyUrl, requestContext, forceM2M });
        const historyPayload = await readJsonOrThrow(historyRes, `history for ${handle}`);
        result.history = mergeAndCapHistory(historyPayload, input.trackId);
    }

    return result;
}
