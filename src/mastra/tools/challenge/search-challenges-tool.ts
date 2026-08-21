// Challenge API: GET /v6/challenges (M2M token required)
// Searches Topcoder challenges with filters via the v6 Challenges API.
// The v6 endpoint returns a bare JSON array (not a paginated envelope);
// this tool wraps it into { challenges, total, page, perPage } for callers.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { M2MService } from '../../../utils/auth/m2m.service';

const BASE_URL = `${process.env.TC_API_BASE}/v6/challenges`;

const m2mService = new M2MService();

const challengeSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    descriptionFormat: z.string().optional(),
    status: z.string(),
    track: z.string().optional(),
    type: z.string().optional(),
    tags: z.array(z.string()),
    skills: z.array(z.object({ id: z.string(), name: z.string() })),
    projectId: z.number().optional(),
    groups: z.array(z.string()).optional(),
});

export const searchChallengesTool = createTool({
    id: 'search-challenges',
    description:
        'Searches Topcoder challenges via the v6 Challenges API using M2M authentication with filter support (projectId, status, types, tracks, tags, groups, dates, pagination)',
    inputSchema: z.object({
        projectId: z.string().optional(),
        projectIds: z.array(z.string()).optional(),
        status: z.array(z.string()).optional(),
        approvalStatus: z.array(z.string()).optional(),
        types: z.array(z.string()).optional(),
        tracks: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        groups: z.array(z.string()).optional(),
        updatedDateStart: z.string().optional(),
        updatedDateEnd: z.string().optional(),
        ids: z.array(z.string()).optional(),
        page: z.number().optional(),
        perPage: z.number().optional(),
        sortBy: z.string().optional(),
        sortOrder: z.string().optional(),
    }),
    outputSchema: z.object({
        challenges: z.array(challengeSummarySchema),
        total: z.number(),
        page: z.number(),
        perPage: z.number(),
    }),
    execute: async (inputData, context) => {
        const logger = context.mastra?.getLogger?.();
        logger?.info('Searching challenges with filters');
        return await searchChallenges(inputData);
    },
});

interface SearchChallengesInput {
    projectId?: string;
    projectIds?: string[];
    status?: string[];
    approvalStatus?: string[];
    types?: string[];
    tracks?: string[];
    tags?: string[];
    groups?: string[];
    updatedDateStart?: string;
    updatedDateEnd?: string;
    ids?: string[];
    page?: number;
    perPage?: number;
    sortBy?: string;
    sortOrder?: string;
}

/**
 * The v6 endpoint validates `types`/`tracks`/`tags`/`groups` as arrays: both a
 * comma-joined value and a single bare `key=value` are rejected with
 * `"criteria.<field>" must be an array` (HTTP 400). Bracket notation
 * (`key[]=a&key[]=b`) is the form the query parser accepts for one or more
 * values.
 */
function appendArrayParam(params: URLSearchParams, key: string, values: string[]): void {
    for (const value of values) {
        params.append(`${key}[]`, value);
    }
}

/**
 * Builds URLSearchParams from the tool input filters.
 * Always sets isLightweight=false — the lightweight response omits `description`,
 * which is the field being indexed.
 */
function buildQueryParams(input: SearchChallengesInput): URLSearchParams {
    const params = new URLSearchParams();

    // Always set isLightweight: false
    params.set('isLightweight', 'false');

    if (input.projectId) params.set('projectId', input.projectId);
    if (input.projectIds?.length) params.set('projectIds', input.projectIds.join(','));
    // `status` is a scalar enum in the v6 API — repeated or comma-joined values
    // are both rejected. Callers wanting several statuses must search per status.
    if (input.status?.length) params.set('status', input.status.join(','));
    if (input.approvalStatus?.length) params.set('approvalStatus', input.approvalStatus.join(','));
    if (input.types?.length) appendArrayParam(params, 'types', input.types);
    if (input.tracks?.length) appendArrayParam(params, 'tracks', input.tracks);
    if (input.tags?.length) appendArrayParam(params, 'tags', input.tags);
    if (input.groups?.length) appendArrayParam(params, 'groups', input.groups);
    if (input.updatedDateStart) params.set('updatedDateStart', input.updatedDateStart);
    if (input.updatedDateEnd) params.set('updatedDateEnd', input.updatedDateEnd);
    if (input.ids?.length) params.set('ids', input.ids.join(','));
    if (input.page !== undefined) params.set('page', String(input.page));
    if (input.perPage !== undefined) params.set('perPage', String(input.perPage));
    if (input.sortBy) params.set('sortBy', input.sortBy);
    if (input.sortOrder) params.set('sortOrder', input.sortOrder);

    return params;
}

/**
 * Maps a raw challenge object from the v6 API response into the output schema.
 * Handles track/type as both string and { name } object shapes.
 * privateDescription is intentionally NOT included — only the public description is returned.
 */
function mapChallenge(raw: any) {
    return {
        id: raw.id,
        name: raw.name,
        description: raw.description ?? undefined,
        descriptionFormat: raw.descriptionFormat ?? undefined,
        status: raw.status ?? '',
        track: typeof raw.track === 'string' ? raw.track : raw.track?.name ?? undefined,
        type: typeof raw.type === 'string' ? raw.type : raw.type?.name ?? undefined,
        tags: raw.tags ?? [],
        skills: (raw.skills ?? []).map((s: any) => ({ id: s.id, name: s.name })),
        projectId: raw.projectId ?? undefined,
        groups: raw.groups ?? undefined,
        // privateDescription is intentionally NOT included
    };
}

const searchChallenges = async (input: SearchChallengesInput) => {
    const token = await m2mService.getM2MToken();

    const params = buildQueryParams(input);
    const url = `${BASE_URL}?${params.toString()}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'app-version': '2.0.0',
        },
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        throw new Error(
            `Failed to search challenges (HTTP ${response.status})`,
        );
    }

    const data = await response.json();

    // v6 challenges API returns a bare JSON array, not a paginated envelope
    const challengeArray: any[] = Array.isArray(data) ? data : [];

    const page = input.page ?? 1;
    const perPage = input.perPage ?? 20;

    return {
        challenges: challengeArray.map(mapChallenge),
        total: challengeArray.length,
        page,
        perPage,
    };
};
