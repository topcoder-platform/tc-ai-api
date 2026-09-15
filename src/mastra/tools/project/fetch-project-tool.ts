// Projects API: GET /v6/projects/:projectId
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

export const fetchProjectTool = withAccessPolicy(createTool({
    id: TOOL_ID,
    description:
        'Fetches a Topcoder project by id from the v6 Projects API, authorized as the requesting user. ' +
        'Retrieval-time enrichment only — resolves a projectId reference from a challenge-search hit ' +
        'to the project\'s name, status, type, and tech stack.',
    inputSchema: z.object({
        projectId: z.string().describe('Project id to fetch (D10 — carried as a string reference)'),
        fields: z.string().optional().describe('Optional comma-separated field list to narrow the response'),
    }),
    outputSchema: z.object({
        project: z.object({
            id: z.string(),
            name: z.string().optional(),
            status: z.string().optional(),
            type: z.string().optional(),
            billingAccountId: z.string().optional(),
            directProjectId: z.string().optional(),
            techStack: z.array(z.string()).optional(),
        }),
    }),
    execute: async (inputData, context) => {
        const logger = context.mastra?.getLogger?.();
        logger?.info('Fetching project by ID: {projectId}', { projectId: inputData.projectId });
        return await fetchProject(inputData.projectId, inputData.fields, context.requestContext);
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

    const data = await response.json();
    const techStack = Array.isArray(data.techStack)
        ? data.techStack
        : Array.isArray(data.details?.techStack)
            ? data.details.techStack
            : undefined;

    return {
        project: {
            id: toStringOrUndefined(data.id) ?? projectId,
            name: data.name ?? undefined,
            status: data.status ?? undefined,
            type: data.type ?? undefined,
            billingAccountId: toStringOrUndefined(data.billingAccountId),
            directProjectId: toStringOrUndefined(data.directProjectId),
            techStack,
        },
    };
};
