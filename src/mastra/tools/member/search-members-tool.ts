// Reports API: POST /v6/reports/member/search — Talent Search portal member discovery.
// See docs/adr/0008-member-search-tool.md.
import { createTool } from '@mastra/core/tools';
import { withAccessPolicy } from '../../../utils/auth/access-control';
import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';
import type { IMastraLogger } from '@mastra/core/logger';
import { callTcApi } from '../../../utils/tc-api-client';
import { MEMBER_SEARCH_PREFERRED_ROLES } from '../../../config/member-search.config';
import {
    dedupeResolvedSkills,
    resolveSkillTerms,
    type SkillResolution,
} from '../skills/skill-term-resolver';
import countriesModule from 'i18n-iso-countries';
import { createRequire } from 'node:module';

interface CountryLocaleData {
    locale: string;
    countries: Record<string, string | string[]>;
}

const cjsRequire = createRequire(import.meta.url);
const enLocale = cjsRequire('i18n-iso-countries/langs/en.json') as CountryLocaleData;

const countries =
    (countriesModule as { default?: typeof countriesModule }).default ?? countriesModule;

countries.registerLocale(enLocale);

const TOOL_ID = 'search-members';
const MEMBER_SEARCH_URL = `${process.env.TC_API_BASE}/v6/reports/member/search`;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const preferredRoleValues = MEMBER_SEARCH_PREFERRED_ROLES.map((r) => r.value) as [string, ...string[]];
export const preferredRoleEnumValues = preferredRoleValues;
const preferredRoleEnum = z.enum(preferredRoleValues);
const preferredRoleLabel = new Map(MEMBER_SEARCH_PREFERRED_ROLES.map((r) => [r.value, r.label]));

const preferredRolesDescription =
    'Roles members WANT (open-to-work preferences; members without them never match). For "people ' +
    'looking for X roles" only — for "people who can do X" use skills. Codes: ' +
    MEMBER_SEARCH_PREFERRED_ROLES.map((r) => `${r.value} (${r.label})`).join(', ') +
    '. Use the labels, not the codes, with the user.';

/** Common country names not covered by i18n-iso-countries alone (ADR 0008). */
const COUNTRY_ALIASES: Record<string, string> = {
    korea: 'KOR',
    holland: 'NLD',
    england: 'GBR',
    britain: 'GBR',
    macedonia: 'MKD',
    'viet nam': 'VNM',
};

export function convertCountryToAlpha3(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (!trimmed) {
        return undefined;
    }
    const aliasKey = trimmed.toLowerCase();
    if (COUNTRY_ALIASES[aliasKey]) {
        return COUNTRY_ALIASES[aliasKey];
    }
    const upper = trimmed.toUpperCase();
    if (upper.length === 3 && countries.isValid(upper)) {
        return upper;
    }
    if (upper.length === 2) {
        const a3 = countries.alpha2ToAlpha3(upper);
        if (a3) {
            return a3;
        }
    }
    const fromName = countries.getAlpha3Code(trimmed, 'en');
    if (fromName) {
        return fromName;
    }
    return undefined;
}

export function convertCountries(rawCountries: string[]): {
    alpha3: string[];
    unrecognized: string[];
} {
    const alpha3: string[] = [];
    const unrecognized: string[] = [];
    const seen = new Set<string>();

    for (const raw of rawCountries) {
        const code = convertCountryToAlpha3(raw);
        if (!code) {
            unrecognized.push(raw);
            continue;
        }
        if (!seen.has(code)) {
            seen.add(code);
            alpha3.push(code);
        }
    }
    return { alpha3, unrecognized };
}

function hasAtLeastOneFilter(data: {
    skills?: unknown[];
    openToWork?: boolean;
    recentlyActive?: boolean;
    verifiedProfile?: boolean;
    profileComplete?: boolean;
    copilot?: boolean;
    preferredRoles?: unknown[];
    countries?: unknown[];
}): boolean {
    if (data.skills && data.skills.length > 0) return true;
    if (data.openToWork === true) return true;
    if (data.recentlyActive === true) return true;
    if (data.verifiedProfile === true) return true;
    if (data.profileComplete === true) return true;
    if (data.copilot === true) return true;
    if (data.preferredRoles && data.preferredRoles.length > 0) return true;
    if (data.countries && data.countries.length > 0) return true;
    return false;
}

const skillResolutionOutputSchema = z.object({
    input: z.string().describe('Skill as requested.'),
    status: z
        .enum(['resolved', 'ambiguous', 'unresolved'])
        .describe(
            'ambiguous: search not run — call again with one candidate id. ' +
                'unresolved: not a Topcoder skill, left out of the search.',
        ),
    id: z.string().optional().describe('Resolved skill id (internal; never show to the user).'),
    name: z.string().optional().describe('Resolved Topcoder skill name.'),
    matchedBy: z
        .enum(['id', 'exact', 'alias', 'semantic'])
        .optional()
        .describe('alias/semantic: the input was interpreted — tell the user which skill was used.'),
    candidates: z
        .array(z.object({ id: z.string(), name: z.string() }))
        .optional()
        .describe('Possible skills when ambiguous.'),
    reason: z.string().optional().describe('Why the skill was unresolved.'),
});

const searchMembersInputSchema = z
    .object({
        skills: z
            .array(
                z.object({
                    skill: z
                        .string()
                        .min(1)
                        .describe(
                            'Plain skill name with abbreviations written out ("Kubernetes" not "k8s", ' +
                                '"machine learning" not "ML"), or a Topcoder skill id from an earlier tool ' +
                                'result. Never invent ids.',
                        ),
                    minWins: z
                        .number()
                        .int()
                        .min(1)
                        .optional()
                        .describe('Minimum wins wanted. NOT filtered — check matchedSkills[].meetsMinWins.'),
                }),
            )
            .max(10)
            .optional()
            .describe(
                'Technologies, tools or domains, one per entry. Matches only members who competed or ' +
                    'submitted with the skill, not skills merely listed on a profile.',
            ),
        skillMatch: z
            .enum(['any', 'all'])
            .optional()
            .describe(
                'all: every skill required (one person with React AND Node). any (default): at least one; ' +
                    'members matching more rank higher.',
            ),
        openToWork: z.boolean().optional().describe('Only members open to work ("available", "can start now").'),
        recentlyActive: z.boolean().optional().describe('Only recently active members.'),
        verifiedProfile: z.boolean().optional().describe('Only verified members ("verified", "can be paid").'),
        profileComplete: z.boolean().optional().describe('Only members with a complete profile.'),
        copilot: z.boolean().optional().describe('Only copilots.'),
        preferredRoles: z
            .array(preferredRoleEnum)
            .max(MEMBER_SEARCH_PREFERRED_ROLES.length)
            .optional()
            .describe(preferredRolesDescription),
        countries: z
            .array(z.string().min(1))
            .max(30)
            .optional()
            .describe(
                'Country names or ISO codes. Regions ("Europe", "LATAM") are not countries — expand them.',
            ),
        sortBy: z
            .enum(['matchIndex', 'handle'])
            .optional()
            .describe('Omit for best match first; handle = alphabetical.'),
        sortOrder: z.enum(['asc', 'desc']).optional().describe('Defaults: desc for matchIndex, asc for handle.'),
        page: z.number().int().min(1).optional().describe('1-based page (default 1).'),
        limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_LIMIT)
            .optional()
            .describe(`Members per page (default ${DEFAULT_LIMIT}).`),
    })
    .refine(hasAtLeastOneFilter, {
        message:
            'Provide at least one filter (skills, openToWork, recentlyActive, verifiedProfile, profileComplete, ' +
            'copilot, preferredRoles or countries) — an unfiltered search is not allowed.',
    });

const searchMembersOutputSchema = z.object({
    searched: z
        .boolean()
        .describe(
            'false: no search ran (see message and skillResolution) — never report it as "no members found".',
        ),
    message: z.string().optional().describe('Why the search did not run.'),
    total: z.number().describe('Matching members across all pages.'),
    page: z.number(),
    limit: z.number(),
    hasMore: z.boolean().describe('More pages exist.'),
    rankedBy: z
        .enum(['matchIndex', 'handle', 'activity'])
        .describe(
            'matchIndex: best match first. handle: alphabetical. activity: recently active and available ' +
                'first. Only matchIndex justifies calling anyone "top" or "best".',
        ),
    unrecognizedCountries: z.array(z.string()).optional().describe('Countries left out of the search.'),
    minWinsEnforced: z
        .boolean()
        .optional()
        .describe('Present (false) when minWins was set: results are not filtered by it — use meetsMinWins.'),
    skillResolution: z.array(skillResolutionOutputSchema).describe('How each requested skill was mapped.'),
    appliedFilters: z
        .object({
            skills: z.array(z.object({ id: z.string(), name: z.string(), minWins: z.number().optional() })),
            skillMatch: z.enum(['any', 'all']),
            openToWork: z.boolean().optional(),
            recentlyActive: z.boolean().optional(),
            verifiedProfile: z.boolean().optional(),
            profileComplete: z.boolean().optional(),
            copilot: z.boolean().optional(),
            preferredRoles: z
                .array(z.object({ value: z.string(), label: z.string() }))
                .optional(),
            countries: z.array(z.string()).optional(),
            sortBy: z.enum(['matchIndex', 'handle']),
            sortOrder: z.enum(['asc', 'desc']),
        })
        .optional()
        .describe('Filters actually searched. For the next page, pass these again (skills by id) with page + 1.'),
    members: z
        .array(
            z.object({
                userId: z.string(),
                handle: z.string().describe('Topcoder handle (profile URL segment).'),
                name: z.string().optional().describe('Personal data — show only when useful.'),
                location: z.string().optional().describe('Personal data — show only when useful.'),
                matchIndex: z
                    .number()
                    .describe('Relative score, mostly how many requested skills matched. Not a percentage.'),
                openToWork: z.boolean(),
                isRecentlyActive: z.boolean(),
                isVerified: z.boolean(),
                isCopilot: z.boolean(),
                matchedSkills: z
                    .array(
                        z.object({
                            id: z.string(),
                            name: z.string(),
                            wins: z.number().describe('Challenges won with this skill.'),
                            submitted: z.number().describe('Challenges submitted to with this skill.'),
                            meetsMinWins: z.boolean().optional().describe('wins >= the requested minWins.'),
                        }),
                    )
                    .describe('Requested skills this member has Topcoder activity in.'),
            }),
        )
        .describe('One page of members, in rankedBy order.'),
});

type SearchInput = z.infer<typeof searchMembersInputSchema>;

interface UpstreamMemberRow {
    id: string;
    handle: string;
    name?: string | null;
    photoUrl?: string | null;
    isRecentlyActive: boolean;
    isVerified: boolean;
    openToWork: boolean;
    isCopilot: boolean;
    location?: string | null;
    matchIndex: number;
    matchedSkills: {
        id: string;
        name: string;
        isVerified?: boolean;
        wins: number;
        submitted: number;
    }[];
}

function toSkillResolutionOutput(resolutions: SkillResolution[]) {
    return resolutions.map((r) => {
        if (r.status === 'resolved') {
            return {
                input: r.input,
                status: 'resolved' as const,
                id: r.id,
                name: r.name,
                matchedBy: r.matchedBy,
            };
        }
        if (r.status === 'ambiguous') {
            return { input: r.input, status: 'ambiguous' as const, candidates: r.candidates };
        }
        return { input: r.input, status: 'unresolved' as const, reason: r.reason };
    });
}

function computeRankedBy(
    resolvedSkillCount: number,
    preferredRoles: string[] | undefined,
    sortBy: 'matchIndex' | 'handle' | undefined,
): 'matchIndex' | 'handle' | 'activity' {
    if (sortBy === 'handle') {
        return 'handle';
    }
    if (resolvedSkillCount === 0 && preferredRoles && preferredRoles.length > 0) {
        return 'activity';
    }
    if (resolvedSkillCount === 0) {
        return 'handle';
    }
    return 'matchIndex';
}

function defaultSortOrder(sortBy: 'matchIndex' | 'handle'): 'asc' | 'desc' {
    return sortBy === 'handle' ? 'asc' : 'desc';
}

function mapUpstreamMember(
    row: UpstreamMemberRow,
    minWinsBySkillId: Map<string, number>,
): z.infer<typeof searchMembersOutputSchema>['members'][number] {
    let name = row.name?.trim();
    if (name && name.toLowerCase() === row.handle.toLowerCase()) {
        name = undefined;
    }
    const location = row.location?.trim() || undefined;

    const matchedSkills = row.matchedSkills.map((s) => {
        const minWins = minWinsBySkillId.get(s.id);
        const entry: {
            id: string;
            name: string;
            wins: number;
            submitted: number;
            meetsMinWins?: boolean;
        } = {
            id: s.id,
            name: s.name,
            wins: s.wins,
            submitted: s.submitted,
        };
        if (minWins !== undefined) {
            entry.meetsMinWins = s.wins >= minWins;
        }
        return entry;
    });

    return {
        userId: row.id,
        handle: row.handle,
        name,
        location,
        matchIndex: row.matchIndex,
        openToWork: row.openToWork,
        isRecentlyActive: row.isRecentlyActive,
        isVerified: row.isVerified,
        isCopilot: row.isCopilot,
        matchedSkills,
    };
}

function emptySearchResult(
    page: number,
    limit: number,
    rankedBy: 'matchIndex' | 'handle' | 'activity',
    skillResolution: SkillResolution[],
    message: string,
    unrecognizedCountries?: string[],
): z.infer<typeof searchMembersOutputSchema> {
    return {
        searched: false,
        message,
        total: 0,
        page,
        limit,
        hasMore: false,
        rankedBy,
        skillResolution: toSkillResolutionOutput(skillResolution),
        members: [],
        ...(unrecognizedCountries && unrecognizedCountries.length > 0
            ? { unrecognizedCountries }
            : {}),
    };
}

async function executeSearchMembers(
    inputData: SearchInput,
    requestContext: RequestContext | undefined,
    logger?: IMastraLogger,
): Promise<z.infer<typeof searchMembersOutputSchema>> {
    const page = inputData.page ?? 1;
    const limit = Math.min(inputData.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const skillMatch = inputData.skillMatch ?? 'any';

    const skillItems = inputData.skills ?? [];
    const skillResolution = await resolveSkillTerms(skillItems, { requestContext, logger });

    const hasAmbiguous = skillResolution.some((r) => r.status === 'ambiguous');
    if (hasAmbiguous) {
        return emptySearchResult(
            page,
            limit,
            'matchIndex',
            skillResolution,
            'Some skills matched several Topcoder skills — pick one and search again.',
        );
    }

    const resolvedSkills = dedupeResolvedSkills(skillResolution);
    const requestedSkillCount = skillItems.length;
    const allUnresolved =
        requestedSkillCount > 0 && skillResolution.every((r) => r.status === 'unresolved');
    if (allUnresolved) {
        return emptySearchResult(
            page,
            limit,
            'matchIndex',
            skillResolution,
            'None of the requested skills exist in the Topcoder skills taxonomy.',
        );
    }

    let alpha3Countries: string[] | undefined;
    let unrecognizedCountries: string[] | undefined;
    if (inputData.countries && inputData.countries.length > 0) {
        const converted = convertCountries(inputData.countries);
        alpha3Countries = converted.alpha3;
        unrecognizedCountries = converted.unrecognized;
        if (alpha3Countries.length === 0) {
            return emptySearchResult(
                page,
                limit,
                computeRankedBy(resolvedSkills.length, inputData.preferredRoles, inputData.sortBy),
                skillResolution,
                'None of the requested countries were recognized.',
                unrecognizedCountries,
            );
        }
    }

    const sortBy = inputData.sortBy ?? 'matchIndex';
    const sortOrder = inputData.sortOrder ?? defaultSortOrder(sortBy);
    const rankedBy = computeRankedBy(resolvedSkills.length, inputData.preferredRoles, inputData.sortBy);

    const body: Record<string, unknown> = {
        page,
        limit,
        skillSearchType: skillMatch === 'all' ? 'AND' : 'OR',
        skills: resolvedSkills.map((s) => ({
            id: s.id,
            ...(s.minWins !== undefined ? { wins: s.minWins } : {}),
        })),
    };

    if (inputData.openToWork === true) body.openToWork = true;
    if (inputData.recentlyActive === true) body.recentlyActive = true;
    if (inputData.verifiedProfile === true) body.verifiedProfile = true;
    if (inputData.profileComplete === true) body.profileComplete = true;
    if (inputData.copilot === true) body.copilot = true;
    if (inputData.preferredRoles && inputData.preferredRoles.length > 0) {
        body.preferredRoles = [...new Set(inputData.preferredRoles)];
    }
    if (alpha3Countries && alpha3Countries.length > 0) {
        body.countries = alpha3Countries;
    }
    if (inputData.sortBy !== undefined) {
        body.sortBy = inputData.sortBy;
        body.sortOrder = sortOrder;
    }

    const response = await callTcApi({
        toolId: TOOL_ID,
        url: MEMBER_SEARCH_URL,
        init: { method: 'POST', body: JSON.stringify(body) },
        requestContext,
    });

    if (response.status === 400) {
        let detail = response.statusText;
        try {
            const errBody = (await response.json()) as { message?: string };
            if (errBody.message) detail = errBody.message;
        } catch {
            /* ignore */
        }
        throw new Error(`Member search rejected the filters: ${detail}`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new Error(
            'Your account is not permitted to use member search (Administrator or Talent Manager role required).',
        );
    }
    if (response.status === 404) {
        let detail = 'unknown skill';
        try {
            const errBody = (await response.json()) as { message?: string };
            if (errBody.message) detail = errBody.message;
        } catch {
            /* ignore */
        }
        throw new Error(`Skill not found or disabled: ${detail}`);
    }
    if (!response.ok) {
        throw new Error(`Member search is unavailable right now (HTTP ${response.status}).`);
    }

    const payload = (await response.json()) as {
        total: number;
        page: number;
        limit: number;
        data: UpstreamMemberRow[];
    };

    const minWinsBySkillId = new Map<string, number>();
    for (const s of resolvedSkills) {
        if (s.minWins !== undefined) {
            minWinsBySkillId.set(s.id, s.minWins);
        }
    }
    const anyMinWins = minWinsBySkillId.size > 0;

    const members = payload.data.map((row) => mapUpstreamMember(row, minWinsBySkillId));
    const hasMore = payload.page * payload.limit < payload.total;

    const appliedFilters: NonNullable<z.infer<typeof searchMembersOutputSchema>['appliedFilters']> = {
        skills: resolvedSkills.map((s) => ({
            id: s.id,
            name: s.name,
            ...(s.minWins !== undefined ? { minWins: s.minWins } : {}),
        })),
        skillMatch,
        sortBy,
        sortOrder,
    };
    if (inputData.openToWork === true) appliedFilters.openToWork = true;
    if (inputData.recentlyActive === true) appliedFilters.recentlyActive = true;
    if (inputData.verifiedProfile === true) appliedFilters.verifiedProfile = true;
    if (inputData.profileComplete === true) appliedFilters.profileComplete = true;
    if (inputData.copilot === true) appliedFilters.copilot = true;
    if (inputData.preferredRoles && inputData.preferredRoles.length > 0) {
        appliedFilters.preferredRoles = inputData.preferredRoles.map((value) => ({
            value,
            label: preferredRoleLabel.get(value) ?? value,
        }));
    }
    if (alpha3Countries && alpha3Countries.length > 0) {
        appliedFilters.countries = alpha3Countries;
    }

    return {
        searched: true,
        total: payload.total,
        page: payload.page,
        limit: payload.limit,
        hasMore,
        rankedBy,
        skillResolution: toSkillResolutionOutput(skillResolution),
        appliedFilters,
        members,
        ...(unrecognizedCountries && unrecognizedCountries.length > 0 ? { unrecognizedCountries } : {}),
        ...(anyMinWins ? { minWinsEnforced: false } : {}),
    };
}

export const searchMembersTool = withAccessPolicy(
    createTool({
        id: TOOL_ID,
        description:
            'Finds Topcoder members by skills and profile filters (Talent Search): "React developers open to ' +
            'work in the US", "copilots who know Salesforce". Returns a ranked, paginated shortlist with ' +
            'per-skill wins/submissions. At least one filter is required. Not for one known member ' +
            '(fetch-member-insights) or who worked on a challenge (fetch-challenge-resources).',
        inputSchema: searchMembersInputSchema,
        outputSchema: searchMembersOutputSchema,
        execute: async (inputData, context) => {
            const logger = context.mastra?.getLogger?.();
            logger?.info('search-members: resolving skills and calling member search');
            return executeSearchMembers(inputData, context.requestContext, logger);
        },
    }),
);

export const searchMembersToolDescriptionExtras = { preferredRolesDescription };
