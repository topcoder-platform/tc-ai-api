// Challenge API: GET /v6/challenges/:challengeId (M2M token required)
// Fetches full challenge details from the Topcoder API by challenge ID.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { M2MService } from '../../../utils/auth/m2m.service';

const BASE_URL = `${process.env.TC_API_BASE}/v6/challenges`;

const m2mService = new M2MService();

export const fetchChallengeTool = createTool({
    id: 'fetch-challenge-by-id',
    description:
        'Fetches a Topcoder challenge by its UUID from the Topcoder v5 Challenges API using M2M authentication',
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
        return await fetchChallenge(inputData.challengeId);
    },
});

const fetchChallenge = async (challengeId: string) => {
    const token = await m2mService.getM2MToken();

    const url = `${BASE_URL}/${encodeURIComponent(challengeId)}`;
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
