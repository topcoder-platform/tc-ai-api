// Projects API: GET /v6/projects/:projectId (by id) and GET /v6/projects?name= (by name)
//
// Retrieval-time enrichment only (D10): resolves the opaque `projectId`
// reference stored in challenge vector metadata to project detail (name,
// status, tech stack) on demand, under the CALLER's own authorization.
// Not used by, and nothing in, the ingestion or retrieval path depends on
// this tool — it exists so a consumer that already has a projectId from a
// challenge-search hit can make the "subsequent call" D10 describes instead
// of that data being denormalized into the vector store.
//
// Authorized as the requestor by default (their own token is forwarded
// as-is); no M2M fallback configured for this tool — see
// docs/adr/0002-tc-api-requestor-token-with-m2m-fallback.md.
import { createTool } from '@mastra/core/tools';
import { withAccessPolicy } from '../../../utils/auth/access-control';
import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';
import { callTcApi } from '../../../utils/tc-api-client';

const TOOL_ID = 'fetch-project-by-id';
const BASE_URL = `${process.env.TC_API_BASE}/v6/projects`;

// Upper bound on how many name matches are pulled back. A project name search
// is a "contains" match server-side, so a short input can match broadly; the
// best match is returned as `project` and the rest as `matches` so the caller
// can disambiguate instead of silently answering about the wrong project.
const NAME_SEARCH_PER_PAGE = 10;

const PROJECT_SHAPE = z.object({
    id: z.string(),
    name: z.string().optional(),
    status: z.string().optional(),
    type: z.string().optional(),
    billingAccountId: z.string().optional(),
    directProjectId: z.string().optional(),
    techStack: z.array(z.string()).optional(),
});

/**
 * Project ids are BigInt-backed on projects-api-v6 and the `GET /:projectId`
 * route rejects anything non-numeric with a 400. Anything else the caller
 * passes is therefore a name, not an id.
 */
function isNumericId(value: string): boolean {
    return /^\d+$/.test(value);
}

export const fetchProjectTool = withAccessPolicy(createTool({
    id: TOOL_ID,
    description:
        'Resolves a Topcoder project from the v6 Projects API, authorized as the requesting user. ' +
        'Accepts either a numeric project id or a project name — a non-numeric value is treated as a ' +
        'name search instead of an id lookup. Returns the project\'s id, name, status, type, and tech ' +
        'stack; use the returned numeric id when a projectId is needed elsewhere.',
    inputSchema: z.object({
        projectId: z.string().describe(
            'Numeric project id, or a project name when the id is not known (a non-numeric value is '
            + 'searched by name, case-insensitive, matching any project whose name contains it)',
        ),
        fields: z.string().optional().describe('Optional comma-separated field list to narrow the response (only used for numeric id lookups)'),
    }),
    outputSchema: z.object({
        project: PROJECT_SHAPE,
        resolvedBy: z.enum(['id', 'name']).describe('Whether the input was looked up as an id or searched as a name'),
        matches: z.array(PROJECT_SHAPE).optional().describe(
            'Other projects whose name also matched, when the name search was ambiguous',
        ),
    }),
    execute: async (inputData, context) => {
        const logger = context.mastra?.getLogger?.();
        const identifier = inputData.projectId.trim();

        if (identifier.length === 0) {
             throw new Error('projectId must not be empty');
         }

        if (!isNumericId(identifier)) {
            logger?.info('Resolving project by name: {name}', { name: identifier });
            return await searchProjectsByName(identifier, context.requestContext);
        }

        logger?.info('Fetching project by ID: {projectId}', { projectId: identifier });
        return {
            project: await fetchProject(identifier, inputData.fields, context.requestContext),
            resolvedBy: 'id' as const,
        };
    },
}));

/**
 * Project.id / billingAccountId / directProjectId are Prisma BigInt on the
 * server (projects-api-v6), which throws on JSON.stringify ("Do not know how
 * to serialize a BigInt") if ever returned without an explicit conversion.
 * By the time we read a value here it has already crossed fetch().json()
 * (which never produces a BigInt), but every one of those fields is still
 * coerced to string explicitly so this tool's own output never depends on
 * how the upstream API happened to serialize them.
 */
function toStringOrUndefined(value: unknown): string | undefined {
    return value === null || value === undefined ? undefined : String(value);
}

const fetchProject = async (projectId: string, fields: string | undefined, requestContext: RequestContext | undefined) => {
    const params = fields ? `?fields=${encodeURIComponent(fields)}` : '';
    const url = `${BASE_URL}/${encodeURIComponent(projectId)}${params}`;

    const response = await callTcApi({
        toolId: TOOL_ID,
        url,
        init: {
            method: 'GET',
            signal: AbortSignal.timeout(15_000),
        },
        requestContext,
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch project ${projectId} (HTTP ${response.status})`);
    }

    return mapProject(await response.json(), projectId);
};

/**
 * Maps a raw project payload (from either the detail or the list endpoint)
 * onto this tool's output shape.
 */
function mapProject(data: any, fallbackId: string) {
    const techStack = Array.isArray(data.techStack)
        ? data.techStack
        : Array.isArray(data.details?.techStack)
            ? data.details.techStack
            : undefined;

    return {
        id: toStringOrUndefined(data.id) ?? fallbackId,
        name: data.name ?? undefined,
        status: data.status ?? undefined,
        type: data.type ?? undefined,
        billingAccountId: toStringOrUndefined(data.billingAccountId),
        directProjectId: toStringOrUndefined(data.directProjectId),
        techStack,
    };
}

/**
 * Resolves a project name to a project via `GET /v6/projects?name=`, which is
 * a case-insensitive "contains" match server-side. An exact (case-insensitive)
 * name match wins when one is present; otherwise the first hit is returned as
 * the best match and the remainder are surfaced as `matches`.
 */
const searchProjectsByName = async (name: string, requestContext: RequestContext | undefined) => {
    const url = `${BASE_URL}?name=${encodeURIComponent(name)}&perPage=${NAME_SEARCH_PER_PAGE}`;

    const response = await callTcApi({
        toolId: TOOL_ID,
        url,
        init: {
            method: 'GET',
            signal: AbortSignal.timeout(15_000),
        },
        requestContext,
    });

    if (!response.ok) {
        throw new Error(`Failed to search projects by name "${name}" (HTTP ${response.status})`);
    }

    const body = await response.json();
    const rows: any[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];

    if (rows.length === 0) {
        throw new Error(`No project found matching name "${name}"`);
    }

    const projects = rows
        .map((row) => mapProject(row, toStringOrUndefined(row?.id) ?? ''))
        .filter((project) => project.id.length > 0);

    if (projects.length === 0) {
        throw new Error(`No project found matching name "${name}"`);
    }

    const exactIndex = projects.findIndex(
        (project) => project.name?.toLowerCase() === name.toLowerCase(),
    );
    const bestIndex = exactIndex === -1 ? 0 : exactIndex;
    const others = projects.filter((_, index) => index !== bestIndex);

    return {
        project: projects[bestIndex],
        resolvedBy: 'name' as const,
        ...(others.length > 0 ? { matches: others } : {}),
    };
};
