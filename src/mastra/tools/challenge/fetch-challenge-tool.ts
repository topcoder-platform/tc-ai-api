// Challenge API: GET /v6/challenges/:challengeId
// Fetches full challenge details from the Topcoder API by challenge ID.
//
// Authorized as the requestor by default (their own token is forwarded
// as-is); no M2M fallback configured for this tool — see
// docs/adr/0002-tc-api-requestor-token-with-m2m-fallback.md.
import { createTool } from '@mastra/core/tools';
import { withAccessPolicy } from '../../../utils/auth/access-control';
import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';
import { callTcApi } from '../../../utils/tc-api-client';

const TOOL_ID = 'fetch-challenge-by-id';
const BASE_URL = `${process.env.TC_API_BASE}/v6/challenges`;

export const fetchChallengeTool = withAccessPolicy(createTool({
    id: TOOL_ID,
    description:
        'Fetches a Topcoder challenge by its UUID from the Topcoder v6 Challenges API, authorized as the requesting user',
    inputSchema: z.object({
        challengeId: z.string().uuid().describe('UUID of the Topcoder challenge to fetch'),
    }),
    outputSchema: z.object({
        challenge: z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
            privateDescription: z.string().optional(),
            descriptionFormat: z.string().optional(),
            status: z.string(),
            track: z.string().optional(),
            type: z.string().optional(),
            tags: z.array(z.string()),
            skills: z.array(
                z.object({
                    id: z.string(),
                    name: z.string(),
                }),
            ),
            numOfRegistrants: z.number(),
            numOfSubmissions: z.number(),
            projectId: z.number().optional(),
            groups: z.array(z.string()).optional(),
            registrationStartDate: z.string().optional(),
            registrationEndDate: z.string().optional(),
            startDate: z.string().optional(),
            endDate: z.string().optional(),
            prizeSets: z
                .array(
                    z.object({
                        type: z.string(),
                        prizes: z.array(
                            z.object({
                                type: z.string(),
                                value: z.number(),
                            }),
                        ),
                    }),
                )
                .optional(),
            reviewers: z
                .array(
                    z.object({
                        scorecardId: z.string().optional(),
                        isMemberReview: z.boolean(),
                        type: z.string().optional(),
                        aiWorkflowId: z.string().optional(),
                    }),
                )
                .optional(),
            discussions: z
                .array(
                    z.object({
                        url: z.string().optional(),
                    }),
                )
                .optional(),
            overview: z
                .object({
                    totalPrizes: z.number().optional(),
                })
                .optional(),
            task: z
                .object({
                    isTask: z.boolean().optional(),
                })
                .optional(),
            legacy: z
                .object({
                    reviewType: z.string().optional(),
                })
                .optional(),
        }),
    }),
    execute: async (inputData, context) => {
        const logger = context.mastra?.getLogger?.();
        logger?.info('Fetching challenge by ID: {challengeId}', {
            challengeId: inputData.challengeId,
        });
        return await fetchChallenge(inputData.challengeId, context.requestContext);
    },
}));

const fetchChallenge = async (challengeId: string, requestContext: RequestContext | undefined) => {
    const url = `${BASE_URL}/${encodeURIComponent(challengeId)}`;
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
        throw new Error(
            `Failed to fetch challenge ${challengeId} (HTTP ${response.status})`,
        );
    }

    const data = await response.json();

    return {
        challenge: {
            id: data.id,
            name: data.name,
            description: data.description ?? undefined,
            privateDescription: data.privateDescription ?? undefined,
            descriptionFormat: data.descriptionFormat ?? undefined,
            status: data.status ?? '',
            track: data.track?.name ?? undefined,
            type: data.type?.name ?? undefined,
            tags: data.tags ?? [],
            skills: (data.skills ?? []).map((s: { id: string; name: string }) => ({
                id: s.id,
                name: s.name,
            })),
            numOfRegistrants: data.numOfRegistrants ?? 0,
            numOfSubmissions: data.numOfSubmissions ?? 0,
            projectId: data.projectId ?? undefined,
            groups: data.groups ?? undefined,
            registrationStartDate: data.registrationStartDate ?? undefined,
            registrationEndDate: data.registrationEndDate ?? undefined,
            startDate: data.startDate ?? undefined,
            endDate: data.endDate ?? undefined,
            prizeSets: data.prizeSets ?? undefined,
            reviewers: data.reviewers ?? undefined,
            discussions: data.discussions ?? undefined,
            overview: data.overview ?? undefined,
            task: data.task ?? undefined,
            legacy: data.legacy ?? undefined,
        },
    };
};
