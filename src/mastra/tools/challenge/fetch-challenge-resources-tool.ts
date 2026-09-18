// Resources API: GET /v6/resources?challengeId=...
// Lists challenge resources (copilot, reviewers, registrants, etc.) filterable
// by caller-facing role category. See docs/adr/0005-challenge-resources-tool-for-challenge-search-agent.md.
import { createTool } from '@mastra/core/tools';
import { withAccessPolicy, toAuthenticatedCaller } from '../../../utils/auth/access-control';
import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';
import { callTcApi } from '../../../utils/tc-api-client';
import {
    CHALLENGE_RESOURCE_ROLE_CATEGORIES,
    type ChallengeResourceCategory,
} from '../../../config/challenge-resource-roles.config';
import { resolveCategoryRoleIds } from '../../../utils/tc-resource-roles-cache';

const TOOL_ID = 'fetch-challenge-resources';
const BASE_URL = `${process.env.TC_API_BASE}/v6/resources`;
const MAX_PER_PAGE = 1000;
const ADMIN_ROLE = 'administrator';

const resourceSchema = z.object({
    memberId: z.string(),
    memberHandle: z.string(),
    roleId: z.string(),
    roleName: z.string(),
    created: z.string().optional(),
});

export const fetchChallengeResourcesTool = withAccessPolicy(
    createTool({
        id: TOOL_ID,
        description:
            'Lists a Topcoder challenge\'s resources (copilot, reviewers, registrants/submitters, managers, ' +
            'observers, or all of them) from the v6 Resources API. Takes exactly one challengeId.',
        inputSchema: z.object({
            challengeId: z.string().uuid().describe('UUID of the Topcoder challenge'),
            role: z
                .enum(['copilot', 'reviewers', 'registrants', 'managers', 'observers', 'all'])
                .optional()
                .describe('Caller-facing role category — omit or use "all" to return every resource'),
            roleId: z
                .string()
                .uuid()
                .optional()
                .describe(
                    'Exact resource-role UUID (from a prior lookup) — takes precedence over "role" when both are given',
                ),
        }),
        outputSchema: z.object({
            challengeId: z.string(),
            role: z.string(),
            resources: z.array(resourceSchema),
            total: z.number(),
            truncated: z.boolean().describe(
                `true if the challenge has more than ${MAX_PER_PAGE} total resources — see ADR 0005`,
            ),
        }),
        execute: async (inputData, context) => {
            const logger = context.mastra?.getLogger?.();
            logger?.info('Fetching challenge resources: {challengeId} role={role}', {
                challengeId: inputData.challengeId,
                role: inputData.role ?? inputData.roleId ?? 'all',
            });
            return await fetchChallengeResources(inputData, context.requestContext);
        },
    }),
);

interface Input {
    challengeId: string;
    role?: ChallengeResourceCategory | 'all';
    roleId?: string;
}

/**
 * `withAccessPolicy` has already confirmed the caller holds `administrator`
 * or `Talent Manager` by the time this runs — this only decides *which*
 * credential to forward for the outbound TC API call, not whether to allow
 * the call at all.
 */
function shouldForceM2M(requestContext: RequestContext | undefined): boolean {
    const user = requestContext?.get('user') as Record<string, unknown> | undefined;
    if (!user) {
        return true;
    }
    return !toAuthenticatedCaller(user).roles.includes(ADMIN_ROLE);
}

const fetchChallengeResources = async (
    input: Input,
    requestContext: RequestContext | undefined,
) => {
    const forceM2M = shouldForceM2M(requestContext);
    const url = `${BASE_URL}?challengeId=${encodeURIComponent(input.challengeId)}&page=1&perPage=${MAX_PER_PAGE}`;
    const response = await callTcApi({
        toolId: TOOL_ID,
        url,
        init: { method: 'GET', signal: AbortSignal.timeout(15_000) },
        requestContext,
        forceM2M,
    });
    if (!response.ok) {
        throw new Error(
            `Failed to fetch resources for challenge ${input.challengeId} (HTTP ${response.status})`,
        );
    }

    const all: {
        memberId: string | number;
        memberHandle: string;
        roleId: string;
        roleName: string;
        created?: string;
    }[] = await response.json();
    const totalHeader = Number(response.headers.get('x-total') ?? all.length);

    let roleIds: Set<string> | undefined;
    let label: string;
    if (input.roleId) {
        roleIds = new Set([input.roleId]);
        label = `roleId:${input.roleId}`;
    } else if (input.role && input.role !== 'all') {
        roleIds = await resolveCategoryRoleIds(
            input.role,
            CHALLENGE_RESOURCE_ROLE_CATEGORIES[input.role],
            requestContext,
        );
        label = input.role;
    } else {
        label = 'all';
    }

    const filtered = roleIds ? all.filter((r) => roleIds!.has(r.roleId)) : all;

    return {
        challengeId: input.challengeId,
        role: label,
        resources: filtered.map((r) => ({
            memberId: String(r.memberId),
            memberHandle: r.memberHandle,
            roleId: r.roleId,
            roleName: r.roleName,
            created: r.created ?? undefined,
        })),
        total: filtered.length,
        truncated: totalHeader > all.length,
    };
};
